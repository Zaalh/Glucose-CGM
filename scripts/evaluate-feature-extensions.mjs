// Kan het CGM-only BETER dan niveau+rate (~0.74) met features die we nog niet testten,
// en die de literatuur noemt: glycemische VARIABILITEIT, TIJD-VAN-DAG (circadiaan) en
// RECENT-LOW-recency? A/B met grouped-CV per dag, klinisch label <3.9 sustained.
//
// Modellen (L2-logistisch, gestandaardiseerd, OOF grouped-CV):
//   A = niveau + rate
//   D = A + variabiliteit (SD60, CV60)
//   E = D + tijd-van-dag (sin/cos uur) + recent-low (min sinds laatste <3.9, #lows 6u)
//
// SUSTAIN_MIN configureerbaar (default 10 min) i.p.v. de eerdere zwakke 2-punts-definitie.
// Alleen-lezen. Self-test: node scripts/evaluate-feature-extensions.mjs --self-test

import { MongoClient } from 'mongodb'
import { buildHypoFeatures } from './lib/hypo-features.mjs'

const MGDL_PER_MMOL = 18.0182
const MS_PER_MIN = 60_000
const HYPO_MMOL = 3.9
const HORIZON_MIN = 30
const SPEC_TARGET = 0.90
const num = (k, d) => (Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d)
const SUSTAIN_MIN = num('SUSTAIN_MIN', 10) // klinischer dan 2 punten; tolerant via meerderheid
const TZ_OFFSET_H = num('TZ_OFFSET_H', 2) // Amsterdam zomer; voor circadiane features

const mmol = (sgv) => Number(sgv) / MGDL_PER_MMOL
const round = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000)

// Label: er bestaat een t1 in (t, t+30m] met glucose <3.9 die ~SUSTAIN_MIN aanhoudt
// (>=60% van de metingen in [t1, t1+SUSTAIN_MIN] is <3.9 -> ruis-tolerant, klinischer).
function labelHypo(timeline, idx) {
  const t0 = timeline[idx].date
  const tEnd = t0 + HORIZON_MIN * MS_PER_MIN
  for (let i = idx + 1; i < timeline.length; i += 1) {
    if (timeline[i].date > tEnd) break
    if (mmol(timeline[i].sgv) >= HYPO_MMOL) continue
    const t1 = timeline[i].date
    let low = 0
    let total = 0
    for (let j = i; j < timeline.length; j += 1) {
      if (timeline[j].date > t1 + SUSTAIN_MIN * MS_PER_MIN) break
      total += 1
      if (mmol(timeline[j].sgv) < HYPO_MMOL) low += 1
    }
    if (total >= 2 && low / total >= 0.6) return { y: 1, leadMin: (t1 - t0) / MS_PER_MIN }
  }
  return { y: 0, leadMin: null }
}
function hasHorizon(timeline, idx) {
  return timeline[timeline.length - 1].date >= timeline[idx].date + HORIZON_MIN * MS_PER_MIN
}

// glycemische variabiliteit over de laatste windowMin
function variability(timeline, idx, windowMin) {
  const from = timeline[idx].date - windowMin * MS_PER_MIN
  const vals = []
  for (let i = idx; i >= 0; i -= 1) {
    if (timeline[i].date < from) break
    vals.push(mmol(timeline[i].sgv))
  }
  if (vals.length < 3) return { sd: 0, cv: 0 }
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length
  const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length)
  return { sd, cv: mean > 0 ? sd / mean : 0 }
}
function recentLow(timeline, idx) {
  const now = timeline[idx].date
  let minSinceLow = 999
  let lows6h = 0
  for (let i = idx; i >= 0; i -= 1) {
    const ageMin = (now - timeline[i].date) / MS_PER_MIN
    if (ageMin > 360) break
    if (mmol(timeline[i].sgv) < HYPO_MMOL) {
      lows6h += 1
      if (ageMin < minSinceLow) minSinceLow = ageMin
    }
  }
  return { minSinceLow, lows6h }
}
function timeOfDay(ms) {
  const hour = ((ms / (3600 * 1000)) + TZ_OFFSET_H) % 24
  return { sin: Math.sin((2 * Math.PI * hour) / 24), cos: Math.cos((2 * Math.PI * hour) / 24) }
}

// --- metrics + logistische OOF grouped-CV -----------------------------------
function rocAuc(s) {
  const pos = s.filter((x) => x.y === 1).length, neg = s.length - pos
  if (!pos || !neg) return null
  const sorted = s.slice().sort((a, b) => a.p - b.p)
  let rs = 0
  for (let i = 0; i < sorted.length; ) {
    let j = i; while (j < sorted.length && sorted[j].p === sorted[i].p) j += 1
    const ar = (i + 1 + j) / 2
    for (let k = i; k < j; k += 1) if (sorted[k].y === 1) rs += ar
    i = j
  }
  return (rs - (pos * (pos + 1)) / 2) / (pos * neg)
}
function ap(s) {
  const sorted = s.slice().sort((a, b) => b.p - a.p)
  const tot = s.filter((x) => x.y === 1).length
  if (!tot) return null
  let tp = 0, fp = 0, a = 0, prev = 0
  for (const x of sorted) { if (x.y === 1) tp += 1; else fp += 1; const r = tp / tot; a += (tp / (tp + fp)) * (r - prev); prev = r }
  return a
}
function sensAtSpec(s, spec) {
  const neg = s.filter((x) => x.y === 0).map((x) => x.p).sort((a, b) => a - b)
  const pos = s.filter((x) => x.y === 1)
  if (!neg.length || !pos.length) return null
  const thr = neg[Math.min(neg.length - 1, Math.floor(spec * neg.length))]
  return pos.filter((x) => x.p >= thr).length / pos.length
}
function trainLogistic(rows, dims, { l2 = 1.0, lr = 0.1, epochs = 400 } = {}) {
  const w = new Array(dims).fill(0); let b = 0; const n = rows.length || 1
  const pos = rows.filter((r) => r.y === 1).length || 1, neg = rows.length - pos || 1
  const wPos = rows.length / (2 * pos), wNeg = rows.length / (2 * neg)
  for (let e = 0; e < epochs; e += 1) {
    const gw = new Array(dims).fill(0); let gb = 0
    for (const r of rows) {
      let z = b; for (let j = 0; j < dims; j += 1) z += w[j] * r.xs[j]
      const p = 1 / (1 + Math.exp(-z)); const g = (r.y === 1 ? wPos : wNeg) * (p - r.y)
      for (let j = 0; j < dims; j += 1) gw[j] += g * r.xs[j]; gb += g
    }
    for (let j = 0; j < dims; j += 1) w[j] -= lr * (gw[j] / n + (l2 * w[j]) / n); b -= lr * (gb / n)
  }
  return { w, b }
}
function cv(samples, featNames) {
  const dims = featNames.length
  const days = [...new Set(samples.map((s) => s.day))].sort((a, b) => a - b)
  const folds = 5, oof = []
  for (let f = 0; f < folds; f += 1) {
    const testDays = new Set(days.filter((_, i) => i % folds === f))
    const train = [], test = []
    for (const s of samples) {
      const x = featNames.map((k) => s.f[k]); const row = { x, y: s.y, leadMin: s.leadMin }
      ;(testDays.has(s.day) ? test : train).push(row)
    }
    if (!train.length || !test.length) continue
    const mean = new Array(dims).fill(0), std = new Array(dims).fill(0)
    for (const r of train) for (let j = 0; j < dims; j += 1) mean[j] += r.x[j]
    for (let j = 0; j < dims; j += 1) mean[j] /= train.length
    for (const r of train) for (let j = 0; j < dims; j += 1) std[j] += (r.x[j] - mean[j]) ** 2
    for (let j = 0; j < dims; j += 1) std[j] = Math.sqrt(std[j] / train.length) || 1
    for (const r of train) r.xs = r.x.map((v, j) => (v - mean[j]) / std[j])
    const m = trainLogistic(train, dims)
    for (const r of test) {
      const xs = r.x.map((v, j) => (v - mean[j]) / std[j])
      let z = m.b; for (let j = 0; j < dims; j += 1) z += m.w[j] * xs[j]
      oof.push({ p: 1 / (1 + Math.exp(-z)), y: r.y, leadMin: r.leadMin })
    }
  }
  const leads = oof.filter((s) => s.y === 1 && Number.isFinite(s.leadMin)).map((s) => s.leadMin).sort((a, b) => a - b)
  return { rocAuc: round(rocAuc(oof)), prAuc: round(ap(oof)), sensAtSpec90: round(sensAtSpec(oof, SPEC_TARGET)), medianLeadMin: leads.length ? Math.round(leads[Math.floor(leads.length / 2)]) : null }
}

function buildSamples(timeline, { reactiveOnly }) {
  const out = []
  for (let idx = 12; idx < timeline.length; idx += 1) {
    if (!hasHorizon(timeline, idx)) continue
    let hf; try { hf = buildHypoFeatures(timeline, idx, { nowMs: timeline[idx].date, cleanTimeline: false }) } catch { continue }
    if (!hf || !Number.isFinite(hf.currentMmol) || !Number.isFinite(hf.blendedRate)) continue
    const riseFromBaseline = Number.isFinite(hf.riseFromBaseline) ? hf.riseFromBaseline : 0
    const minutesSincePeak = Number.isFinite(hf.minutesSincePeak) ? hf.minutesSincePeak : 999
    if (reactiveOnly && !(riseFromBaseline >= 1 && minutesSincePeak >= 0 && minutesSincePeak <= 60)) continue
    const v = variability(timeline, idx, 60)
    const rl = recentLow(timeline, idx)
    const tod = timeOfDay(timeline[idx].date)
    const { y, leadMin } = labelHypo(timeline, idx)
    out.push({
      day: Math.floor(timeline[idx].date / (24 * 60 * MS_PER_MIN)),
      f: { level: hf.currentMmol, rate: hf.blendedRate, sd60: v.sd, cv60: v.cv, hourSin: tod.sin, hourCos: tod.cos, minSinceLow: rl.minSinceLow, lows6h: rl.lows6h },
      y, leadMin,
    })
  }
  return out
}

const A = ['level', 'rate']
const D = ['level', 'rate', 'sd60', 'cv60']
const E = ['level', 'rate', 'sd60', 'cv60', 'hourSin', 'hourCos', 'minSinceLow', 'lows6h']

function runContext(timeline, reactiveOnly) {
  const s = buildSamples(timeline, { reactiveOnly })
  const pos = s.filter((x) => x.y === 1).length
  return { n: s.length, hypoPos: pos, baseRate: round(pos / (s.length || 1)), sustainMin: SUSTAIN_MIN,
    A_levelRate: cv(s, A), D_plusVariability: cv(s, D), E_plusTimeRecent: cv(s, E) }
}

function syntheticTimeline() {
  const r = []; let t = Date.UTC(2026, 0, 1, 6, 0, 0)
  const rnd = (() => { let s = 99; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff })()
  for (let d = 0; d < 16; d += 1) {
    for (let m = 0; m < 3; m += 1) {
      const steep = rnd() < 0.5
      const block = steep ? [5.5, 5.2, 6.5, 8.5, 11, 9, 7, 5, 3.6, 3.5, 3.6, 3.7, 4.5, 5.2] : [5.5, 5.4, 6, 6.8, 7.4, 8.5, 8, 7.4, 6.8, 6.2, 5.8, 5.6, 5.5]
      for (const v of block) { r.push({ date: t, sgv: Math.round(v * MGDL_PER_MMOL) }); t += 5 * MS_PER_MIN }
      t += 90 * MS_PER_MIN
    }
    t += 6 * 60 * MS_PER_MIN
  }
  return r.sort((a, b) => a.date - b.date)
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const res = { reactiveContext: runContext(syntheticTimeline(), true) }
    console.log(JSON.stringify(res, null, 2))
    const rc = res.reactiveContext
    const ok = rc.n > 10 && rc.hypoPos > 3 && rc.A_levelRate.rocAuc !== null && rc.E_plusTimeRecent.rocAuc !== null
    console.log(`\n${ok ? 'SELF-TEST OK' : 'SELF-TEST FAIL'}`)
    process.exit(ok ? 0 : 1)
  }
  const uri = process.env.MONGODB_URI ?? 'mongodb://nightscout-mongo:27017/nightscout'
  const client = new MongoClient(uri); await client.connect()
  try {
    const entries = await client.db().collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true } }, { projection: { _id: 0, date: 1, sgv: 1 } }).sort({ date: 1 }).toArray()
    const timeline = entries.map((e) => ({ date: Number(e.date), sgv: Number(e.sgv) }))
    console.log(`entries geladen: ${timeline.length} | sustainMin=${SUSTAIN_MIN}\n`)
    const res = { allPoints: runContext(timeline, false), reactiveContext: runContext(timeline, true) }
    console.log(JSON.stringify(res, null, 2))
    console.log('\n--- duiding (kan het beter CGM-only?) ---')
    for (const key of ['allPoints', 'reactiveContext']) {
      const r = res[key]
      const dAD = round(r.D_plusVariability.rocAuc - r.A_levelRate.rocAuc)
      const dAE = round(r.E_plusTimeRecent.rocAuc - r.A_levelRate.rocAuc)
      console.log(`[${key}] n=${r.n} hypo=${r.hypoPos} base-rate=${r.baseRate}`)
      console.log(`  ROC-AUC: A(niveau+rate)=${r.A_levelRate.rocAuc} -> D(+variab.)=${r.D_plusVariability.rocAuc} (Δ${dAD}) -> E(+tijd+recent-low)=${r.E_plusTimeRecent.rocAuc} (Δ${dAE})`)
      console.log(`  PR-AUC:  A=${r.A_levelRate.prAuc} D=${r.D_plusVariability.prAuc} E=${r.E_plusTimeRecent.prAuc} | sens@spec90 E=${r.E_plusTimeRecent.sensAtSpec90}`)
    }
  } finally { await client.close() }
}
main().catch((err) => { console.error(err); process.exit(1) })
