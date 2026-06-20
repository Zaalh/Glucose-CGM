// Vergelijkt het HUIDIGE systeem (V1 regelmodel, V2 reactieve-hypo detector) met de
// eenvoudige referentie A (niveau + daalsnelheid, logistisch) op exact dezelfde punten
// en hetzelfde klinische label (<3.9 sustained binnen 30m). Antwoordt: halen V1/V2 het
// plafond (ROC-AUC ~0.74) dat A bereikt, of zit er nog ruimte?
//
// V1/V2 zijn vaste functies -> directe AUC op alle punten. A wordt getraind -> OOF
// grouped-CV per dag (eerlijk). NB: V2 is historisch op deze persoon getuned -> zijn
// in-sample AUC is licht optimistisch; A is honest out-of-fold.
//
// Alleen-lezen. Draaien (container op de iMac):
//   docker compose -f docker-compose.nightscout.yml --profile libre run --rm \
//     libreview-sync node scripts/compare-detectors.mjs
// Offline rook-test: node scripts/compare-detectors.mjs --self-test

import { MongoClient } from 'mongodb'
import { buildHypoFeatures } from './lib/hypo-features.mjs'
import { evaluateRiskRuleV1 } from './lib/legacy-risk-v1.mjs'
import { evaluateReactiveHypoRiskV2 } from './lib/reactive-hypo-detector.mjs'

const MGDL_PER_MMOL = 18.0182
const MS_PER_MIN = 60_000
const HYPO_MMOL = 3.9
const HORIZON_MIN = 30
const SUSTAIN_POINTS = 2
const SPEC_TARGET = 0.90

const mmol = (sgv) => Number(sgv) / MGDL_PER_MMOL
const round = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000)

function labelHypo(timeline, idx) {
  const t0 = timeline[idx].date
  const tEnd = t0 + HORIZON_MIN * MS_PER_MIN
  let run = 0
  let firstLowMs = null
  for (let i = idx + 1; i < timeline.length; i += 1) {
    if (timeline[i].date > tEnd) break
    if (mmol(timeline[i].sgv) < HYPO_MMOL) {
      run += 1
      if (run === 1) firstLowMs = timeline[i].date
      if (run >= SUSTAIN_POINTS) return { y: 1, leadMin: (firstLowMs - t0) / MS_PER_MIN }
    } else { run = 0; firstLowMs = null }
  }
  return { y: 0, leadMin: null }
}
function hasHorizon(timeline, idx) {
  return timeline[timeline.length - 1].date >= timeline[idx].date + HORIZON_MIN * MS_PER_MIN
}

// --- metrics (rank-based; threshold-vrij, dus score-schaal maakt niet uit) ---
function rocAuc(scored) {
  const pos = scored.filter((s) => s.y === 1).length
  const neg = scored.length - pos
  if (!pos || !neg) return null
  const sorted = scored.slice().sort((a, b) => a.p - b.p)
  let rankSumPos = 0
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j < sorted.length && sorted[j].p === sorted[i].p) j += 1
    const avgRank = (i + 1 + j) / 2
    for (let k = i; k < j; k += 1) if (sorted[k].y === 1) rankSumPos += avgRank
    i = j
  }
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg)
}
function averagePrecision(scored) {
  const sorted = scored.slice().sort((a, b) => b.p - a.p)
  const totalPos = scored.filter((s) => s.y === 1).length
  if (!totalPos) return null
  let tp = 0, fp = 0, ap = 0, prev = 0
  for (const s of sorted) {
    if (s.y === 1) tp += 1; else fp += 1
    const recall = tp / totalPos
    ap += (tp / (tp + fp)) * (recall - prev)
    prev = recall
  }
  return ap
}
function sensitivityAtSpec(scored, spec) {
  const neg = scored.filter((s) => s.y === 0).map((s) => s.p).sort((a, b) => a - b)
  const pos = scored.filter((s) => s.y === 1)
  if (!neg.length || !pos.length) return null
  const thr = neg[Math.min(neg.length - 1, Math.floor(spec * neg.length))]
  return pos.filter((s) => s.p >= thr).length / pos.length
}
function medianLead(scored) {
  const leads = scored.filter((s) => s.y === 1 && Number.isFinite(s.leadMin)).map((s) => s.leadMin).sort((a, b) => a - b)
  return leads.length ? Math.round(leads[Math.floor(leads.length / 2)]) : null
}
function metricsOf(scored) {
  return {
    rocAuc: round(rocAuc(scored)),
    prAuc: round(averagePrecision(scored)),
    sensAtSpec90: round(sensitivityAtSpec(scored, SPEC_TARGET)),
    medianLeadMin: medianLead(scored),
  }
}

// --- logistische referentie A (niveau + rate), grouped CV per dag ------------
function trainLogistic(rows, dims, { l2 = 1.0, lr = 0.1, epochs = 400 } = {}) {
  const w = new Array(dims).fill(0); let b = 0
  const n = rows.length || 1
  const pos = rows.filter((r) => r.y === 1).length || 1
  const neg = rows.length - pos || 1
  const wPos = rows.length / (2 * pos); const wNeg = rows.length / (2 * neg)
  for (let e = 0; e < epochs; e += 1) {
    const gw = new Array(dims).fill(0); let gb = 0
    for (const r of rows) {
      let z = b; for (let j = 0; j < dims; j += 1) z += w[j] * r.xs[j]
      const p = 1 / (1 + Math.exp(-z))
      const g = (r.y === 1 ? wPos : wNeg) * (p - r.y)
      for (let j = 0; j < dims; j += 1) gw[j] += g * r.xs[j]
      gb += g
    }
    for (let j = 0; j < dims; j += 1) w[j] -= lr * (gw[j] / n + (l2 * w[j]) / n)
    b -= lr * (gb / n)
  }
  return { w, b }
}
function cvLogistic(samples) {
  const dims = 2
  const days = [...new Set(samples.map((s) => s.day))].sort((a, b) => a - b)
  const folds = 5
  const oof = []
  for (let f = 0; f < folds; f += 1) {
    const testDays = new Set(days.filter((_, i) => i % folds === f))
    const train = [], test = []
    for (const s of samples) (testDays.has(s.day) ? test : train).push({ x: [s.level, s.rate], y: s.y, leadMin: s.leadMin })
    if (!train.length || !test.length) continue
    const mean = [0, 0], std = [0, 0]
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
  return metricsOf(oof)
}

function buildSamples(timeline, { reactiveOnly }) {
  const samples = []
  for (let idx = 12; idx < timeline.length; idx += 1) {
    if (!hasHorizon(timeline, idx)) continue
    let f
    try { f = buildHypoFeatures(timeline, idx, { nowMs: timeline[idx].date, cleanTimeline: false }) } catch { continue }
    if (!f || !Number.isFinite(f.currentMmol) || !Number.isFinite(f.blendedRate)) continue
    const riseFromBaseline = Number.isFinite(f.riseFromBaseline) ? f.riseFromBaseline : 0
    const minutesSincePeak = Number.isFinite(f.minutesSincePeak) ? f.minutesSincePeak : 999
    if (reactiveOnly && !(riseFromBaseline >= 1 && minutesSincePeak >= 0 && minutesSincePeak <= 60)) continue

    const v1 = evaluateRiskRuleV1({
      currentMmol: f.currentMmol, rate5m: f.rate5m, rate10m: f.rate10m, rate15m: f.rate15m,
      peakMmol: f.peakMmol120m, minutesSincePeak: f.minutesSincePeak,
      dropFromPeakMmol: f.dropFromPeakMmol, dropFromPeakPercent: f.dropFromPeakPercent,
    })
    const v2 = evaluateReactiveHypoRiskV2(f, {})
    const { y, leadMin } = labelHypo(timeline, idx)
    samples.push({
      day: Math.floor(timeline[idx].date / (24 * 60 * MS_PER_MIN)),
      level: f.currentMmol, rate: f.blendedRate,
      v1: Number.isFinite(v1?.score) ? v1.score : 0,
      v2: Number.isFinite(v2?.score) ? v2.score : 0,
      y, leadMin,
    })
  }
  return samples
}

function runContext(timeline, reactiveOnly) {
  const s = buildSamples(timeline, { reactiveOnly })
  const pos = s.filter((x) => x.y === 1).length
  return {
    n: s.length, hypoPos: pos, baseRate: round(pos / (s.length || 1)),
    V1_rule: metricsOf(s.map((x) => ({ p: x.v1, y: x.y, leadMin: x.leadMin }))),
    V2_detector: metricsOf(s.map((x) => ({ p: x.v2, y: x.y, leadMin: x.leadMin }))),
    A_levelRate_OOF: cvLogistic(s),
  }
}

function syntheticTimeline() {
  const readings = []
  let t = Date.UTC(2026, 0, 1, 6, 0, 0)
  const rnd = (() => { let s = 7; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff })()
  for (let day = 0; day < 16; day += 1) {
    for (let meal = 0; meal < 3; meal += 1) {
      const steep = rnd() < 0.5
      const block = steep
        ? [5.5, 5.2, 6.5, 8.5, 11, 9, 7, 5, 3.6, 3.5, 3.7, 4.5, 5.2]
        : [5.5, 5.4, 6, 6.8, 7.4, 8.5, 8, 7.4, 6.8, 6.2, 5.8, 5.6, 5.5]
      for (const v of block) { readings.push({ date: t, sgv: Math.round(v * MGDL_PER_MMOL) }); t += 5 * MS_PER_MIN }
      t += 90 * MS_PER_MIN
    }
    t += 6 * 60 * MS_PER_MIN
  }
  return readings.sort((a, b) => a.date - b.date)
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const res = { reactiveContext: runContext(syntheticTimeline(), true) }
    console.log(JSON.stringify(res, null, 2))
    const rc = res.reactiveContext
    const ok = rc.n > 10 && rc.hypoPos > 3 && rc.V1_rule.rocAuc !== null && rc.V2_detector.rocAuc !== null && rc.A_levelRate_OOF.rocAuc !== null
    console.log(`\n${ok ? 'SELF-TEST OK' : 'SELF-TEST FAIL'}`)
    process.exit(ok ? 0 : 1)
  }

  const uri = process.env.MONGODB_URI ?? 'mongodb://nightscout-mongo:27017/nightscout'
  const client = new MongoClient(uri)
  await client.connect()
  try {
    const entries = await client.db().collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true } }, { projection: { _id: 0, date: 1, sgv: 1 } })
      .sort({ date: 1 }).toArray()
    const timeline = entries.map((e) => ({ date: Number(e.date), sgv: Number(e.sgv) }))
    console.log(`entries geladen: ${timeline.length}\n`)
    const res = { allPoints: runContext(timeline, false), reactiveContext: runContext(timeline, true) }
    console.log(JSON.stringify(res, null, 2))
    console.log('\n--- duiding (huidig systeem vs referentie-plafond) ---')
    for (const key of ['allPoints', 'reactiveContext']) {
      const r = res[key]
      console.log(`[${key}] n=${r.n} hypo=${r.hypoPos} base-rate=${r.baseRate}`)
      console.log(`  ROC-AUC:  V1=${r.V1_rule.rocAuc}  V2=${r.V2_detector.rocAuc}  A(niveau+rate,OOF)=${r.A_levelRate_OOF.rocAuc}`)
      console.log(`  PR-AUC:   V1=${r.V1_rule.prAuc}  V2=${r.V2_detector.prAuc}  A=${r.A_levelRate_OOF.prAuc}`)
      console.log(`  sens@spec90: V1=${r.V1_rule.sensAtSpec90}  V2=${r.V2_detector.sensAtSpec90}  A=${r.A_levelRate_OOF.sensAtSpec90}`)
      console.log(`  mediaan lead: V1=${r.V1_rule.medianLeadMin}m  V2=${r.V2_detector.medianLeadMin}m  A=${r.A_levelRate_OOF.medianLeadMin}m`)
    }
    console.log('\nNB: V2 is op deze persoon getuned -> in-sample optimistisch; A is honest out-of-fold.')
    console.log('NB: V2 hier zonder pattern-component (eerder verwaarloosbaar gebleken).')
  } finally {
    await client.close()
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
