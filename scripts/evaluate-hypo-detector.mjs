// Backtest: speelt de historie af en vergelijkt V1 (regel) met V2 (reactieve
// detector) op dezelfde features. Meet precision, recall, gemiste hypo's, vals
// alarm en lead-time. Verandert NIETS live — alleen lezen + rapporteren.
//
// Draaien op echte data (mongo in compose-netwerk):
//   docker compose -f docker-compose.nightscout.yml --profile libre \
//     run --rm libreview-sync node scripts/evaluate-hypo-detector.mjs
//   (of npm run hypo:backtest)
//
// Lokaal de metric-logica checken zonder database:
//   node scripts/evaluate-hypo-detector.mjs --self-test

import { MongoClient } from 'mongodb'
import { buildHypoFeatures, MGDL_PER_MMOL } from './lib/hypo-features.mjs'
import { evaluateReactiveHypoRiskV2 } from './lib/reactive-hypo-detector.mjs'
import { evaluateRiskRuleV1 } from './lib/legacy-risk-v1.mjs'

const MS_PER_MIN = 60_000
const WINDOW_MIN = Number(process.env.HYPO_BACKTEST_WINDOW_MIN ?? 30) // match-venster vooruit/achteruit
const MERGE_GAP_MIN = 15 // opeenvolgende alarmen samenvoegen tot één alarm-episode
const WARMUP_MIN = 15 // minimale voorgeschiedenis voordat we scoren
const HYPO_MMOL = 4.0
const NEAR_MMOL = 4.5

// V1 gebruikt 'high', V2 gebruikt 'likely' als "duidelijk waarschuwen"-niveau.
const ALERT_LEVELS = {
  v1: new Set(['high', 'urgent']),
  v2: new Set(['likely', 'urgent']),
}

function mmolOf(e) {
  return Number(e.sgv) / MGDL_PER_MMOL
}
function median(arr) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function round(v, d) {
  if (!Number.isFinite(v)) return null
  const f = 10 ** d
  return Math.round(v * f) / f
}

// Downward crossings onder `threshold`, met refractory tot herstel boven `recover`.
function findOnsets(timeline, threshold, recover) {
  const onsets = []
  let inLow = false
  for (let i = 1; i < timeline.length; i += 1) {
    const v = mmolOf(timeline[i])
    const prev = mmolOf(timeline[i - 1])
    if (!inLow && v < threshold && prev >= threshold) {
      onsets.push({ idx: i, date: timeline[i].date })
      inLow = true
    } else if (inLow && v >= recover) {
      inLow = false
    }
  }
  return onsets
}

function nadirAfter(timeline, fromIdx, withinMs) {
  let min = mmolOf(timeline[fromIdx])
  const end = timeline[fromIdx].date + withinMs
  for (let j = fromIdx; j < timeline.length && timeline[j].date <= end; j += 1) {
    const v = mmolOf(timeline[j])
    if (v < min) min = v
  }
  return min
}

// Dicht genoeg gesamplede regio: minstens `minSamples` metingen in `lookbackMin`.
// Filtert de uurlijkse/15-min historische import weg, waar rate-features zinloos zijn.
function denseAt(timeline, i, lookbackMin, minSamples) {
  const from = timeline[i].date - lookbackMin * MS_PER_MIN
  let count = 0
  for (let j = i; j >= 0 && timeline[j].date >= from; j -= 1) count += 1
  return count >= minSamples
}

// Collapse per-punt alarmen tot alarm-episodes (start = eerste alarm in de reeks).
function alertEpisodes(points, mergeGapMs) {
  const eps = []
  let cur = null
  for (const p of points) {
    if (!p.alert) {
      cur = null
      continue
    }
    if (cur && p.date - cur.end <= mergeGapMs) {
      cur.end = p.date
    } else {
      cur = { start: p.date, end: p.date, startIdx: p.idx }
      eps.push(cur)
    }
  }
  return eps
}

function scoreModel(points, onsets, windowMs, mergeGapMs, predictiveFloor) {
  const eps = alertEpisodes(points, mergeGapMs)
  const byIdx = new Map(points.map((p) => [p.idx, p]))
  for (const ep of eps) ep.startMmol = byIdx.get(ep.startIdx)?.mmol ?? null

  // Alleen voorspellende alarmen tellen: gestart terwijl glucose nog >= 4.0 was.
  // Alarmen die pas afgaan als je al < 4.0 bent zijn geen vroege waarschuwing.
  const predictive = eps.filter((ep) => Number.isFinite(ep.startMmol) && ep.startMmol >= predictiveFloor)

  // Precision: voorspellend alarm is terecht als er erná (binnen WINDOW) een onset volgt.
  let tpAlerts = 0
  const fpEpisodes = []
  for (const ep of predictive) {
    const hit = onsets.some((o) => o.date > ep.start && o.date <= ep.start + windowMs)
    if (hit) tpAlerts += 1
    else fpEpisodes.push(ep)
  }

  // Recall: onset is op tijd gezien als een voorspellend alarm vóór de onset startte.
  let covered = 0
  const leadTimes = []
  const missed = []
  for (const o of onsets) {
    const before = predictive.filter((ep) => ep.start >= o.date - windowMs && ep.start < o.date)
    if (before.length) {
      covered += 1
      const earliest = Math.min(...before.map((ep) => ep.start))
      leadTimes.push((o.date - earliest) / MS_PER_MIN)
    } else {
      missed.push(o)
    }
  }

  return {
    totalAlertEpisodes: eps.length,
    predictiveAlerts: predictive.length,
    truePositive: tpAlerts,
    falsePositive: fpEpisodes.length,
    earlyCovered: covered,
    missed: missed.length,
    precision: predictive.length ? round(tpAlerts / predictive.length, 3) : null,
    recall: onsets.length ? round(covered / onsets.length, 3) : null,
    medianLeadTimeMinutes: round(median(leadTimes), 1),
    _fpEpisodes: fpEpisodes,
    _missed: missed,
  }
}

export function replayAndEvaluate(timeline, options = {}) {
  const windowMs = (options.windowMin ?? WINDOW_MIN) * MS_PER_MIN
  const mergeGapMs = (options.mergeGapMin ?? MERGE_GAP_MIN) * MS_PER_MIN
  const warmupMs = (options.warmupMin ?? WARMUP_MIN) * MS_PER_MIN
  const denseLookbackMin = options.denseLookbackMin ?? 15
  const denseMinSamples = options.denseMinSamples ?? 4
  const predictiveFloor = options.predictiveFloor ?? HYPO_MMOL
  if (timeline.length < 10) return { ok: false, reason: 'te weinig data' }

  const startMs = timeline[0].date + warmupMs
  const v1Points = []
  const v2Points = []
  const levelCounts = { v1: {}, v2: {} }

  for (let i = 0; i < timeline.length; i += 1) {
    if (timeline[i].date < startMs) continue
    if (!denseAt(timeline, i, denseLookbackMin, denseMinSamples)) continue
    const f = buildHypoFeatures(timeline, i, { nowMs: timeline[i].date })
    const v1 = evaluateRiskRuleV1({
      currentMmol: f.currentMmol,
      rate5m: f.rate5m,
      rate10m: f.rate10m,
      rate15m: f.rate15m,
      peakMmol: f.peakMmol120m,
      minutesSincePeak: f.minutesSincePeak,
      dropFromPeakMmol: f.dropFromPeakMmol,
      dropFromPeakPercent: f.dropFromPeakPercent,
    })
    const v2 = evaluateReactiveHypoRiskV2(f, {})
    levelCounts.v1[v1.risk] = (levelCounts.v1[v1.risk] || 0) + 1
    levelCounts.v2[v2.risk] = (levelCounts.v2[v2.risk] || 0) + 1
    const mmol = f.currentMmol
    v1Points.push({ idx: i, date: timeline[i].date, mmol, alert: ALERT_LEVELS.v1.has(v1.risk), risk: v1.risk, reasons: v1.reasons })
    v2Points.push({ idx: i, date: timeline[i].date, mmol, alert: ALERT_LEVELS.v2.has(v2.risk), risk: v2.risk, reasons: v2.reasons, features: f })
  }

  // Onsets alleen in dichte regio's — anders is "op tijd waarschuwen" niet eerlijk.
  const hypoOnsets = findOnsets(timeline, HYPO_MMOL, NEAR_MMOL).filter((o) =>
    denseAt(timeline, o.idx, denseLookbackMin, denseMinSamples),
  )
  const nearOnsets = findOnsets(timeline, NEAR_MMOL, NEAR_MMOL + 0.3).filter((o) =>
    denseAt(timeline, o.idx, denseLookbackMin, denseMinSamples),
  )

  const v1 = scoreModel(v1Points, hypoOnsets, windowMs, mergeGapMs, predictiveFloor)
  const v2 = scoreModel(v2Points, hypoOnsets, windowMs, mergeGapMs, predictiveFloor)

  // Voorbeelden (V2): gemiste hypo's, vals alarm, goede detecties.
  const missedExamples = v2._missed.slice(0, 5).map((o) => ({
    at: new Date(o.date).toISOString(),
    nadirMmol: round(nadirAfter(timeline, o.idx, windowMs), 3),
  }))
  const v2ByIdx = new Map(v2Points.map((p) => [p.idx, p]))
  const fpExamples = v2._fpEpisodes.slice(0, 5).map((ep) => {
    const p = v2ByIdx.get(ep.startIdx)
    return {
      at: new Date(ep.start).toISOString(),
      risk: p?.risk,
      currentMmol: p?.features?.currentMmol,
      blendedRate: p?.features?.blendedRate,
      dropFromPeakMmol: p?.features?.dropFromPeakMmol,
      reasons: p?.reasons?.slice(0, 3),
    }
  })

  return {
    ok: true,
    periodStart: new Date(timeline[0].date).toISOString(),
    periodEnd: new Date(timeline[timeline.length - 1].date).toISOString(),
    scoredPoints: v2Points.length,
    hypoOnsets: hypoOnsets.length,
    nearHypoOnsets: nearOnsets.length,
    windowMinutes: options.windowMin ?? WINDOW_MIN,
    levelCounts,
    v1: stripInternal(v1),
    v2: stripInternal(v2),
    examples: { missedHypos: missedExamples, falsePositives: fpExamples },
  }
}

function stripInternal(m) {
  const { _fpEpisodes, _missed, ...rest } = m
  return rest
}

// --- runners -------------------------------------------------------------
function syntheticTimeline() {
  const now = Date.UTC(2026, 5, 1, 12, 0, 0)
  const readings = []
  // twee duidelijke reactieve hypo's + ruis ertussen
  const blocks = [
    [5.2, 6.5, 8.5, 9.8, 8.6, 7.0, 5.4, 4.2, 3.7, 4.1, 4.8, 5.4], // hypo 1
    [5.5, 5.6, 5.5, 5.4, 5.5, 5.6], // vlak
    [5.4, 7.0, 9.2, 10.1, 8.8, 6.9, 5.1, 4.0, 3.6, 4.0, 4.7, 5.3], // hypo 2
    [5.4, 5.5, 5.6, 5.5, 5.4, 5.5], // vlak
  ]
  let t = -((blocks.flat().length) * 5)
  for (const b of blocks) for (const mmol of b) { readings.push({ date: now + t * MS_PER_MIN, sgv: Math.round(mmol * MGDL_PER_MMOL) }); t += 5 }
  return readings.sort((a, b) => a.date - b.date)
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const out = replayAndEvaluate(syntheticTimeline())
    console.log(JSON.stringify(out, null, 2))
    const ok = out.ok && out.hypoOnsets >= 2 && out.v2.recall !== null
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
      .find({ type: 'sgv', sgv: { $exists: true } }, { projection: { _id: 0, date: 1, dateString: 1, sgv: 1 } })
      .sort({ date: 1 })
      .toArray()
    const out = replayAndEvaluate(entries)
    console.log(JSON.stringify(out, null, 2))
  } finally {
    await client.close().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error(`[backtest] mislukt: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
