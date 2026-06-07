// Backtest: speelt de historie af en vergelijkt V1 (regel) met V2 (reactieve
// detector) op dezelfde features. Meet precision, recall, gemiste hypo's, vals
// alarm en lead-time. Verandert NIETS live — alleen lezen + rapporteren.
//
// Methodiek volgt CGM-literatuur: ±30 min event-window, "sustained" hypo
// (>= N min onder de grens) i.p.v. losse dips, en early-warning (alleen alarmen
// die afgaan terwijl je nog veilig bent tellen). De featureset wordt één keer
// berekend zodat de auto-tuner snel over V2-parameters kan zoeken.
//
// Draaien op echte data (mongo in compose-netwerk):
//   docker compose ... run --rm libreview-sync node scripts/evaluate-hypo-detector.mjs
//   (of npm run hypo:backtest)
// Lokaal zonder database:
//   node scripts/evaluate-hypo-detector.mjs --self-test

import { MongoClient } from 'mongodb'
import { buildHypoFeatures, MGDL_PER_MMOL } from './lib/hypo-features.mjs'
import { evaluateReactiveHypoRiskV2 } from './lib/reactive-hypo-detector.mjs'
import { evaluateRiskRuleV1 } from './lib/legacy-risk-v1.mjs'
import { patternFromFeatures } from './lib/episode-similarity.mjs'

const MS_PER_MIN = 60_000
const WINDOW_MIN = Number(process.env.HYPO_BACKTEST_WINDOW_MIN ?? 30)
const MERGE_GAP_MIN = 15
const WARMUP_MIN = 15
// Reactieve hypo = korte scherpe dip (~30-40 min na de piek), vaak maar enkele minuten
// onder de grens. Daarom nadir-gebaseerd met een lage sustain die enkel enkel-sample
// sensorruis afwijst, niet de korte dips die de gebruiker echt voelt. (Diabetes-CGM
// gebruikt ~10-15 min sustained; dat ondertelt reactieve hypo's structureel.)
const SUSTAIN_MIN = Number(process.env.HYPO_BACKTEST_SUSTAIN_MIN ?? 2) // hypo telt al bij >= N min onder grens
const HYPO_MMOL = 4.0
const NEAR_MMOL = 4.5

// V1 gebruikt 'high', V2 'likely' als "duidelijk waarschuwen"-niveau.
export const ALERT_LEVELS = {
  v1: new Set(['high', 'urgent']),
  v2: new Set(['likely', 'urgent']),
}

const mmolOf = (e) => Number(e.sgv) / MGDL_PER_MMOL
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

// Nadir-gebaseerde downward crossing: telt als glucose >= sustainMs onder de grens
// blijft. sustainMs is bewust laag (default 2 min) zodat alleen enkel-sample sensorruis
// wordt afgewezen — korte reactieve dips tellen wel mee. Refractory tot herstel.
function findOnsets(timeline, threshold, recover, sustainMs) {
  const onsets = []
  let i = 1
  while (i < timeline.length) {
    const v = mmolOf(timeline[i])
    const prev = mmolOf(timeline[i - 1])
    if (v < threshold && prev >= threshold) {
      let recoverDate = null
      for (let j = i; j < timeline.length; j += 1) {
        if (mmolOf(timeline[j]) >= recover) {
          recoverDate = timeline[j].date
          break
        }
      }
      const dur = (recoverDate ?? timeline[timeline.length - 1].date) - timeline[i].date
      if (dur >= sustainMs) {
        onsets.push({ idx: i, date: timeline[i].date })
        if (recoverDate === null) break
        while (i < timeline.length && timeline[i].date < recoverDate) i += 1
        continue
      }
    }
    i += 1
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

// Dicht genoeg gesampled: minstens minSamples metingen in lookbackMin.
function denseAt(timeline, i, lookbackMin, minSamples) {
  const from = timeline[i].date - lookbackMin * MS_PER_MIN
  let count = 0
  for (let j = i; j >= 0 && timeline[j].date >= from; j -= 1) count += 1
  return count >= minSamples
}

function alertEpisodes(points, mergeGapMs) {
  const eps = []
  let cur = null
  for (const p of points) {
    if (!p.alert) {
      cur = null
      continue
    }
    if (cur && p.date - cur.end <= mergeGapMs) cur.end = p.date
    else {
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

  // Alleen voorspellende alarmen: gestart terwijl glucose nog >= grens was.
  const predictive = eps.filter((ep) => Number.isFinite(ep.startMmol) && ep.startMmol >= predictiveFloor)

  let tpAlerts = 0
  const fpEpisodes = []
  for (const ep of predictive) {
    const hit = onsets.some((o) => o.date > ep.start && o.date <= ep.start + windowMs)
    if (hit) tpAlerts += 1
    else fpEpisodes.push(ep)
  }

  let covered = 0
  const leadTimes = []
  const missed = []
  for (const o of onsets) {
    const before = predictive.filter((ep) => ep.start >= o.date - windowMs && ep.start < o.date)
    if (before.length) {
      covered += 1
      leadTimes.push((o.date - Math.min(...before.map((ep) => ep.start))) / MS_PER_MIN)
    } else missed.push(o)
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

// Precompute één keer: dichte scoorpunten met features + onsets. fromMs/toMs
// beperken WELKE punten meetellen (voor train/test-split); de feature-lookback
// gebruikt nog steeds de volledige timeline.
export function buildReplayContext(timeline, options = {}) {
  const windowMs = (options.windowMin ?? WINDOW_MIN) * MS_PER_MIN
  const mergeGapMs = (options.mergeGapMin ?? MERGE_GAP_MIN) * MS_PER_MIN
  const warmupMs = (options.warmupMin ?? WARMUP_MIN) * MS_PER_MIN
  const sustainMs = (options.sustainMin ?? SUSTAIN_MIN) * MS_PER_MIN
  const denseLookbackMin = options.denseLookbackMin ?? 15
  const denseMinSamples = options.denseMinSamples ?? 4
  const predictiveFloor = options.predictiveFloor ?? HYPO_MMOL
  const cleanTimeline = options.cleanTimeline !== false
  const fromMs = options.fromMs ?? -Infinity
  const toMs = options.toMs ?? Infinity
  const startMs = timeline.length ? timeline[0].date + warmupMs : 0

  const points = []
  for (let i = 0; i < timeline.length; i += 1) {
    const t = timeline[i].date
    if (t < startMs || t < fromMs || t > toMs) continue
    if (!denseAt(timeline, i, denseLookbackMin, denseMinSamples)) continue
    const f = buildHypoFeatures(timeline, i, { nowMs: t, cleanTimeline })
    points.push({ idx: i, date: t, mmol: f.currentMmol, features: f })
  }

  const inRange = (o) =>
    o.date >= fromMs && o.date <= toMs && denseAt(timeline, o.idx, denseLookbackMin, denseMinSamples)
  const hypoOnsets = findOnsets(timeline, HYPO_MMOL, NEAR_MMOL, sustainMs).filter(inRange)
  const nearOnsets = findOnsets(timeline, NEAR_MMOL, NEAR_MMOL + 0.3, sustainMs).filter(inRange)

  // episode_vectors voor component 6 / patternScore (train/serve-pariteit met de
  // live-sync). De live-sync gebruikt de volledige vectorset, dus de backtest doet
  // dat ook; null => geen pattern (V2 valt terug op patternScore 0, zoals voorheen).
  const episodeVectors = options.episodeVectors ?? null

  return {
    timeline,
    points,
    hypoOnsets,
    nearOnsets,
    windowMs,
    mergeGapMs,
    predictiveFloor,
    sustainMin: options.sustainMin ?? SUSTAIN_MIN,
    episodeVectors,
    patternCache: new Map(),
  }
}

export function evaluateV1(ctx) {
  const pts = ctx.points.map((p) => {
    const f = p.features
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
    return { idx: p.idx, date: p.date, mmol: p.mmol, risk: v1.risk, reasons: v1.reasons, alert: ALERT_LEVELS.v1.has(v1.risk) }
  })
  return { metrics: scoreModel(pts, ctx.hypoOnsets, ctx.windowMs, ctx.mergeGapMs, ctx.predictiveFloor), points: pts }
}

function patternKey(recencyDays) {
  return Number.isFinite(recencyDays) && recencyDays > 0 ? String(recencyDays) : 'all'
}

function patternsFor(ctx, recencyDays) {
  if (!ctx.episodeVectors) return null
  const key = patternKey(recencyDays)
  if (ctx.patternCache.has(key)) return ctx.patternCache.get(key)
  const patterns = new Map()
  for (const p of ctx.points) {
    const pattern = patternFromFeatures(p.features, ctx.episodeVectors, { recencyDays })
    if (pattern) patterns.set(p.idx, pattern)
  }
  ctx.patternCache.set(key, patterns)
  return patterns
}

export function evaluateV2(ctx, params) {
  const patterns = patternsFor(ctx, params?.patternRecencyDays)
  const pts = ctx.points.map((p) => {
    const pattern = patterns ? patterns.get(p.idx) ?? null : null
    const r = evaluateReactiveHypoRiskV2(p.features, { params, pattern })
    return {
      idx: p.idx,
      date: p.date,
      mmol: p.mmol,
      risk: r.risk,
      score: r.score,
      reasons: r.reasons,
      features: p.features,
      pattern,
      components: r.components,
      alert: ALERT_LEVELS.v2.has(r.risk),
    }
  })
  return { metrics: scoreModel(pts, ctx.hypoOnsets, ctx.windowMs, ctx.mergeGapMs, ctx.predictiveFloor), points: pts }
}

function levelCounts(points) {
  const c = {}
  for (const p of points) c[p.risk] = (c[p.risk] || 0) + 1
  return c
}

export function replayAndEvaluate(timeline, options = {}) {
  if (timeline.length < 10) return { ok: false, reason: 'te weinig data' }
  const ctx = buildReplayContext(timeline, options)
  const v1 = evaluateV1(ctx)
  const v2 = evaluateV2(ctx, options.v2Params)

  const missedExamples = v2.metrics._missed.slice(0, 5).map((o) => ({
    at: new Date(o.date).toISOString(),
    nadirMmol: round(nadirAfter(timeline, o.idx, ctx.windowMs), 3),
  }))
  const v2ByIdx = new Map(v2.points.map((p) => [p.idx, p]))
  const fpExamples = v2.metrics._fpEpisodes.slice(0, 5).map((ep) => {
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
    scoredPoints: ctx.points.length,
    sustainMinutes: ctx.sustainMin,
    hypoOnsets: ctx.hypoOnsets.length,
    nearHypoOnsets: ctx.nearOnsets.length,
    windowMinutes: options.windowMin ?? WINDOW_MIN,
    levelCounts: { v1: levelCounts(v1.points), v2: levelCounts(v2.points) },
    v1: stripInternal(v1.metrics),
    v2: stripInternal(v2.metrics),
    examples: { missedHypos: missedExamples, falsePositives: fpExamples },
  }
}

function stripInternal(m) {
  const { _fpEpisodes, _missed, ...rest } = m
  return rest
}

// episode_vectors laden voor component 6 / patternScore. Gedeeld door de backtest-CLI
// en de auto-tuner zodat beide V2 hetzelfde pattern voeden als de live-sync.
export async function loadEpisodeVectors(client) {
  try {
    return await client
      .db()
      .collection('episode_vectors')
      .find({}, { projection: { featureVector: 1, outcome: 1, eventType: 1, peakDate: 1, startDate: 1, endDate: 1 } })
      .limit(2000)
      .toArray()
  } catch {
    return []
  }
}

// --- runners -------------------------------------------------------------
function syntheticTimeline() {
  const now = Date.UTC(2026, 5, 1, 12, 0, 0)
  const readings = []
  const blocks = [
    [5.2, 6.5, 8.5, 9.8, 8.6, 7.0, 5.4, 4.2, 3.7, 3.6, 3.7, 4.1, 4.8, 5.4],
    [5.5, 5.6, 5.5, 5.4, 5.5, 5.6],
    [5.4, 7.0, 9.2, 10.1, 8.8, 6.9, 5.1, 4.0, 3.6, 3.5, 3.7, 4.0, 4.7, 5.3],
    [5.4, 5.5, 5.6, 5.5, 5.4, 5.5],
  ]
  let t = -(blocks.flat().length * 5)
  for (const b of blocks)
    for (const mmol of b) {
      readings.push({ date: now + t * MS_PER_MIN, sgv: Math.round(mmol * MGDL_PER_MMOL) })
      t += 5
    }
  return readings.sort((a, b) => a.date - b.date)
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const out = replayAndEvaluate(syntheticTimeline(), { sustainMin: 5 })
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
    const episodeVectors = await loadEpisodeVectors(client)
    console.log(JSON.stringify(replayAndEvaluate(entries, { episodeVectors }), null, 2))
  } finally {
    await client.close().catch(() => undefined)
  }
}

// Alleen draaien als dit bestand het entry-point is (zo blijft importeren veilig).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[backtest] mislukt: ${err && err.message ? err.message : err}`)
    process.exit(1)
  })
}
