// Meet HET VERSCHIL dat RIG (rate of increase to peak, Seo et al. 2019) maakt voor
// postprandiale hypo-predictie, bovenop wat er al is (niveau + rate + bestaande
// rise-features). Alleen-lezen; verandert niets aan de live-flow.
//
// Methodologie (senior/medisch):
// - Label: hypo <3.9 (Level-1) SUSTAINED (>=2 metingen) binnen 30 min -> weert sensorruis.
// - Grouped CV per kalenderdag (geen dag in train EN test) -> voorkomt de duplicaat-lekkage.
// - Reactieve context: alleen punten met een recente post-maaltijd-stijging (waar RIG bestaat
//   en waar de reactieve hypo speelt).
// - Modellen (L2-logistische regressie, gestandaardiseerd): A={niveau,rate},
//   B=A+{riseFromBaseline,riseRate15m}, C=B+{RIG}. Out-of-fold gepoolde scores.
// - Metrics: ROC-AUC, PR-AUC (average precision; imbalance-robuust), sensitiviteit @ spec 0.90.
//
// Draaien (Mongo in container op de iMac):
//   docker compose -f docker-compose.nightscout.yml --profile libre run --rm \
//     libreview-sync node scripts/evaluate-rig-contribution.mjs
// Offline rook-test: node scripts/evaluate-rig-contribution.mjs --self-test

import { MongoClient } from 'mongodb'
import { buildHypoFeatures } from './lib/hypo-features.mjs'

const MGDL_PER_MMOL = 18.0182
const MS_PER_MIN = 60_000
const HYPO_MMOL = 3.9
const HORIZON_MIN = 30
const SUSTAIN_POINTS = 2
const SPEC_TARGET = 0.90 // werkpunt: sensitiviteit bij deze specificiteit

const mmol = (sgv) => Number(sgv) / MGDL_PER_MMOL

// RIG = (piek - dal vóór piek) / tijd-tot-piek (min). Faithful aan Seo et al.
function computeRIG(timeline, idx) {
  const latest = timeline[idx]
  const from = latest.date - 120 * MS_PER_MIN
  let peak = latest
  for (let i = idx; i >= 0; i -= 1) {
    if (timeline[i].date < from) break
    if (Number(timeline[i].sgv) >= Number(peak.sgv)) peak = timeline[i]
  }
  // dal vóór de piek (maaltijd-onset proxy), binnen 120m vóór de piek
  let trough = peak
  for (let i = idx; i >= 0; i -= 1) {
    if (timeline[i].date < peak.date - 120 * MS_PER_MIN) break
    if (timeline[i].date >= peak.date) continue
    if (Number(timeline[i].sgv) < Number(trough.sgv)) trough = timeline[i]
  }
  const rise = mmol(peak.sgv) - mmol(trough.sgv)
  const minutes = (peak.date - trough.date) / MS_PER_MIN
  if (!(rise > 0) || !(minutes > 0)) return { rig: null, riseToPeak: rise, minutesToPeak: minutes }
  return { rig: rise / minutes, riseToPeak: rise, minutesToPeak: minutes }
}

// Label: hypo <3.9 sustained (>=SUSTAIN_POINTS opeenvolgende metingen) binnen 30 min.
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
    } else {
      run = 0
      firstLowMs = null
    }
  }
  return { y: 0, leadMin: null }
}

function hasHorizon(timeline, idx) {
  const tEnd = timeline[idx].date + HORIZON_MIN * MS_PER_MIN
  return timeline[timeline.length - 1].date >= tEnd
}

// --- modeltraining: gestandaardiseerde L2-logistische regressie -------------
function standardizeFit(rows, dims) {
  const mean = new Array(dims).fill(0)
  const std = new Array(dims).fill(0)
  for (const r of rows) for (let j = 0; j < dims; j += 1) mean[j] += r.x[j]
  for (let j = 0; j < dims; j += 1) mean[j] /= rows.length || 1
  for (const r of rows) for (let j = 0; j < dims; j += 1) std[j] += (r.x[j] - mean[j]) ** 2
  for (let j = 0; j < dims; j += 1) std[j] = Math.sqrt(std[j] / (rows.length || 1)) || 1
  return { mean, std }
}
const applyStd = (x, s) => x.map((v, j) => (v - s.mean[j]) / s.std[j])

function trainLogistic(rows, dims, { l2 = 1.0, lr = 0.1, epochs = 400 } = {}) {
  const w = new Array(dims).fill(0)
  let b = 0
  const n = rows.length || 1
  // class weights tegen imbalance
  const pos = rows.filter((r) => r.y === 1).length || 1
  const neg = rows.length - pos || 1
  const wPos = rows.length / (2 * pos)
  const wNeg = rows.length / (2 * neg)
  for (let e = 0; e < epochs; e += 1) {
    const gw = new Array(dims).fill(0)
    let gb = 0
    for (const r of rows) {
      let z = b
      for (let j = 0; j < dims; j += 1) z += w[j] * r.xs[j]
      const p = 1 / (1 + Math.exp(-z))
      const cw = r.y === 1 ? wPos : wNeg
      const g = cw * (p - r.y)
      for (let j = 0; j < dims; j += 1) gw[j] += g * r.xs[j]
      gb += g
    }
    for (let j = 0; j < dims; j += 1) w[j] -= lr * (gw[j] / n + l2 * w[j] / n)
    b -= lr * (gb / n)
  }
  return { w, b }
}
function predict(model, xs) {
  let z = model.b
  for (let j = 0; j < model.w.length; j += 1) z += model.w[j] * xs[j]
  return 1 / (1 + Math.exp(-z))
}

// --- metrics -----------------------------------------------------------------
function rocAuc(scored) {
  const pos = scored.filter((s) => s.y === 1)
  const neg = scored.filter((s) => s.y === 0)
  if (!pos.length || !neg.length) return null
  const sorted = scored.slice().sort((a, b) => a.p - b.p)
  let rank = 0
  let rankSumPos = 0
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j < sorted.length && sorted[j].p === sorted[i].p) j += 1
    const avgRank = (i + 1 + j) / 2
    for (let k = i; k < j; k += 1) if (sorted[k].y === 1) rankSumPos += avgRank
    i = j
    rank = j
  }
  return (rankSumPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length)
}
function averagePrecision(scored) {
  const sorted = scored.slice().sort((a, b) => b.p - a.p)
  const totalPos = scored.filter((s) => s.y === 1).length
  if (!totalPos) return null
  let tp = 0
  let fp = 0
  let ap = 0
  let prevRecall = 0
  for (const s of sorted) {
    if (s.y === 1) tp += 1
    else fp += 1
    const precision = tp / (tp + fp)
    const recall = tp / totalPos
    ap += precision * (recall - prevRecall)
    prevRecall = recall
  }
  return ap
}
function sensitivityAtSpec(scored, specTarget) {
  const neg = scored.filter((s) => s.y === 0).map((s) => s.p).sort((a, b) => a - b)
  const pos = scored.filter((s) => s.y === 1)
  if (!neg.length || !pos.length) return null
  const thr = neg[Math.min(neg.length - 1, Math.floor(specTarget * neg.length))]
  const tp = pos.filter((s) => s.p >= thr).length
  return tp / pos.length
}

// --- grouped CV per dag ------------------------------------------------------
function dayKey(ms) {
  return Math.floor(ms / (24 * 60 * MS_PER_MIN))
}
function groupedCV(samples, featureIdx, { folds = 5 } = {}) {
  const dims = featureIdx.length
  const days = [...new Set(samples.map((s) => s.day))].sort((a, b) => a - b)
  const oof = []
  for (let f = 0; f < folds; f += 1) {
    const testDays = new Set(days.filter((_, i) => i % folds === f))
    const train = []
    const test = []
    for (const s of samples) {
      const x = featureIdx.map((j) => s.feat[j])
      const row = { x, y: s.y, leadMin: s.leadMin }
      ;(testDays.has(s.day) ? test : train).push(row)
    }
    if (!train.length || !test.length) continue
    const std = standardizeFit(train, dims)
    for (const r of train) r.xs = applyStd(r.x, std)
    const model = trainLogistic(train, dims)
    for (const r of test) oof.push({ p: predict(model, applyStd(r.x, std)), y: r.y, leadMin: r.leadMin })
  }
  const leads = oof.filter((s) => s.y === 1 && Number.isFinite(s.leadMin)).map((s) => s.leadMin).sort((a, b) => a - b)
  return {
    rocAuc: round(rocAuc(oof)),
    prAuc: round(averagePrecision(oof)),
    sensAtSpec90: round(sensitivityAtSpec(oof, SPEC_TARGET)),
    medianLeadMin: leads.length ? Math.round(leads[Math.floor(leads.length / 2)]) : null,
  }
}
const round = (x) => (x === null || x === undefined ? null : Math.round(x * 1000) / 1000)

// Feature-volgorde in s.feat: [level, rate, riseFromBaseline, riseRate15m, RIG]
const FEAT = { level: 0, rate: 1, riseFromBaseline: 2, riseRate15m: 3, rig: 4 }
const MODEL_A = [FEAT.level, FEAT.rate]
const MODEL_B = [FEAT.level, FEAT.rate, FEAT.riseFromBaseline, FEAT.riseRate15m]
const MODEL_C = [FEAT.level, FEAT.rate, FEAT.riseFromBaseline, FEAT.riseRate15m, FEAT.rig]

function buildSamples(timeline, { reactiveOnly }) {
  const samples = []
  for (let idx = 12; idx < timeline.length; idx += 1) {
    if (!hasHorizon(timeline, idx)) continue
    let feats
    try {
      feats = buildHypoFeatures(timeline, idx, { nowMs: timeline[idx].date, cleanTimeline: false })
    } catch {
      continue
    }
    if (!feats || !Number.isFinite(feats.currentMmol) || !Number.isFinite(feats.blendedRate)) continue
    const { rig } = computeRIG(timeline, idx)
    const riseFromBaseline = Number.isFinite(feats.riseFromBaseline) ? feats.riseFromBaseline : 0
    const riseRate15m = Number.isFinite(feats.riseRate15m) ? feats.riseRate15m : 0
    const minutesSincePeak = Number.isFinite(feats.minutesSincePeak) ? feats.minutesSincePeak : 999
    // reactieve context: recente post-maaltijd-stijging
    if (reactiveOnly && !(riseFromBaseline >= 1 && minutesSincePeak >= 0 && minutesSincePeak <= 60)) continue
    const { y, leadMin } = labelHypo(timeline, idx)
    samples.push({
      day: dayKey(timeline[idx].date),
      feat: [feats.currentMmol, feats.blendedRate, riseFromBaseline, riseRate15m, Number.isFinite(rig) ? rig : 0],
      y,
      leadMin,
    })
  }
  return samples
}

function summarize(samples) {
  const pos = samples.filter((s) => s.y === 1).length
  return { n: samples.length, hypoPos: pos, baseRate: round(pos / (samples.length || 1)) }
}

function runAll(timeline) {
  const out = {}
  for (const reactiveOnly of [false, true]) {
    const samples = buildSamples(timeline, { reactiveOnly })
    const key = reactiveOnly ? 'reactiveContext' : 'allPoints'
    out[key] = {
      ...summarize(samples),
      A_levelRate: groupedCV(samples, MODEL_A),
      B_plusExistingRise: groupedCV(samples, MODEL_B),
      C_plusRIG: groupedCV(samples, MODEL_C),
    }
  }
  return out
}

// --- self-test ---------------------------------------------------------------
function syntheticTimeline() {
  // Bouw dagen met maaltijd-spikes; hypo volgt vaker na een STEILE spike (hoge RIG),
  // zodat RIG incrementeel signaal heeft bovenop niveau/rate.
  const readings = []
  let t = Date.UTC(2026, 0, 1, 6, 0, 0)
  const rnd = (() => { let s = 42; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff })()
  for (let day = 0; day < 20; day += 1) {
    for (let meal = 0; meal < 3; meal += 1) {
      const steep = rnd() < 0.5
      const peak = steep ? 11 : 8.5
      const block = steep
        ? [5.5, 5.2, 6.5, 8.5, peak, 9, 7, 5, 3.6, 3.5, 3.7, 4.5, 5.2] // steile spike -> hypo
        : [5.5, 5.4, 6, 6.8, 7.4, peak, 8, 7.4, 6.8, 6.2, 5.8, 5.6, 5.5] // mild -> geen hypo
      for (const v of block) { readings.push({ date: t, sgv: Math.round(v * MGDL_PER_MMOL) }); t += 5 * MS_PER_MIN }
      t += 90 * MS_PER_MIN
    }
    t += 6 * 60 * MS_PER_MIN
  }
  return readings.sort((a, b) => a.date - b.date)
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const res = runAll(syntheticTimeline())
    console.log(JSON.stringify(res, null, 2))
    const rc = res.reactiveContext
    const ok = rc.n > 20 && rc.hypoPos > 5 &&
      rc.C_plusRIG.rocAuc !== null && rc.A_levelRate.rocAuc !== null &&
      rc.C_plusRIG.rocAuc >= 0.7
    console.log(`\n${ok ? 'SELF-TEST OK' : 'SELF-TEST FAIL'}`)
    process.exit(ok ? 0 : 1)
  }

  const uri = process.env.MONGODB_URI ?? 'mongodb://nightscout-mongo:27017/nightscout'
  const client = new MongoClient(uri)
  await client.connect()
  try {
    const entries = await client
      .db()
      .collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true } }, { projection: { _id: 0, date: 1, sgv: 1 } })
      .sort({ date: 1 })
      .toArray()
    const timeline = entries.map((e) => ({ date: Number(e.date), sgv: Number(e.sgv) }))
    console.log(`entries geladen: ${timeline.length}\n`)
    const res = runAll(timeline)
    console.log(JSON.stringify(res, null, 2))
    console.log('\n--- duiding (HET VERSCHIL dat RIG maakt) ---')
    for (const key of ['allPoints', 'reactiveContext']) {
      const r = res[key]
      const dAB = r.B_plusExistingRise.prAuc !== null && r.A_levelRate.prAuc !== null ? round(r.B_plusExistingRise.prAuc - r.A_levelRate.prAuc) : null
      const dBC = r.C_plusRIG.prAuc !== null && r.B_plusExistingRise.prAuc !== null ? round(r.C_plusRIG.prAuc - r.B_plusExistingRise.prAuc) : null
      console.log(`[${key}] n=${r.n} hypo=${r.hypoPos} base-rate=${r.baseRate}`)
      console.log(`  PR-AUC: A(niveau+rate)=${r.A_levelRate.prAuc} -> B(+bestaande rise)=${r.B_plusExistingRise.prAuc} (Δ${dAB}) -> C(+RIG)=${r.C_plusRIG.prAuc} (Δ${dBC})`)
      console.log(`  ROC-AUC C=${r.C_plusRIG.rocAuc} | sens@spec90 C=${r.C_plusRIG.sensAtSpec90} | mediaan lead=${r.C_plusRIG.medianLeadMin}m`)
      console.log(`  -> RIG voegt ${dBC === null ? '?' : dBC > 0.02 ? 'MERKBAAR toe' : dBC > 0 ? 'marginaal toe' : 'NIETS toe'} bovenop bestaande features`)
    }
  } finally {
    await client.close()
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
