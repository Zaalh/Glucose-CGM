// Read-only quality analysis for the reactive hypo detector.
//
// Reports data coverage, vector health, current live-state performance, pattern
// contribution, and conservative alternatives. Does not write Mongo or state.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MongoClient } from 'mongodb'
import { DEFAULT_PARAMS } from './lib/reactive-hypo-detector.mjs'
import {
  buildReplayContext,
  evaluateV1,
  evaluateV2,
  loadEpisodeVectors,
} from './evaluate-hypo-detector.mjs'

const MS_PER_MIN = 60_000
const STATE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'reactive-hypo-v2-state.json')

function argNumber(name, fallback) {
  const idx = process.argv.indexOf(name)
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback
  const value = Number(process.argv[idx + 1])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null
  const f = 10 ** digits
  return Math.round(value * f) / f
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function metricLine(metrics) {
  return {
    predictiveAlerts: metrics.predictiveAlerts,
    truePositive: metrics.truePositive,
    falsePositive: metrics.falsePositive,
    missed: metrics.missed,
    earlyCovered: metrics.earlyCovered,
    recall: metrics.recall,
    precision: metrics.precision,
    medianLeadTimeMinutes: metrics.medianLeadTimeMinutes,
  }
}

function levelCounts(points) {
  const out = {}
  for (const p of points) out[p.risk] = (out[p.risk] || 0) + 1
  return out
}

function dataCoverage(entries) {
  const out = {
    count: entries.length,
    from: entries.length ? iso(entries[0].date) : null,
    to: entries.length ? iso(entries[entries.length - 1].date) : null,
    days: entries.length ? round((entries[entries.length - 1].date - entries[0].date) / 86_400_000, 2) : null,
    gapMinutes: { le5: 0, le10: 0, le15: 0, le30: 0, gt30: 0, max: 0 },
  }
  for (let i = 1; i < entries.length; i += 1) {
    const gap = (entries[i].date - entries[i - 1].date) / MS_PER_MIN
    if (gap <= 5) out.gapMinutes.le5 += 1
    else if (gap <= 10) out.gapMinutes.le10 += 1
    else if (gap <= 15) out.gapMinutes.le15 += 1
    else if (gap <= 30) out.gapMinutes.le30 += 1
    else out.gapMinutes.gt30 += 1
    if (gap > out.gapMinutes.max) out.gapMinutes.max = round(gap, 2)
  }
  return out
}

function vectorSummary(vectors) {
  const out = {
    count: vectors.length,
    usableFeatureVectors: 0,
    withDates: 0,
    outcomes: {},
    from: null,
    to: null,
  }
  let min = Infinity
  let max = -Infinity
  for (const v of vectors) {
    const f = v.featureVector || {}
    if (Number.isFinite(f.peakMmol) && Number.isFinite(f.dropFromPeakMmol) && Number.isFinite(f.minutesPeakToEnd)) {
      out.usableFeatureVectors += 1
    }
    out.outcomes[v.outcome || 'unknown'] = (out.outcomes[v.outcome || 'unknown'] || 0) + 1
    const ms = Date.parse(v.peakDate || v.startDate || v.endDate || v.createdAt)
    if (Number.isFinite(ms)) {
      out.withDates += 1
      if (ms < min) min = ms
      if (ms > max) max = ms
    }
  }
  out.from = iso(min)
  out.to = iso(max)
  out.days = Number.isFinite(min) && Number.isFinite(max) ? round((max - min) / 86_400_000, 2) : null
  return out
}

function stripPrivateMetrics(metrics) {
  const { _fpEpisodes, _missed, ...clean } = metrics
  return clean
}

function fpReasonStats(result) {
  const byIdx = new Map(result.points.map((p) => [p.idx, p]))
  const reasons = {}
  const components = {}
  const examples = []
  for (const ep of result.metrics._fpEpisodes || []) {
    const p = byIdx.get(ep.startIdx)
    if (!p) continue
    for (const reason of p.reasons || []) reasons[reason] = (reasons[reason] || 0) + 1
    for (const [key, value] of Object.entries(p.components || {})) {
      if (!components[key]) components[key] = { count: 0, sum: 0 }
      components[key].count += 1
      components[key].sum += Number.isFinite(value) ? value : 0
    }
    if (examples.length < 8) {
      examples.push({
        at: iso(ep.start),
        risk: p.risk,
        score: p.score,
        currentMmol: p.features?.currentMmol,
        dropFromPeakMmol: p.features?.dropFromPeakMmol,
        blendedRate: p.features?.blendedRate,
        pattern: p.pattern
          ? {
              similarEpisodeCount: p.pattern.similarEpisodeCount,
              similarHypoRatio: p.pattern.similarHypoRatio,
              patternNadirMmol: p.pattern.patternNadirMmol,
            }
          : null,
        components: p.components,
        reasons: (p.reasons || []).slice(0, 6),
      })
    }
  }
  const topReasons = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([reason, count]) => ({ reason, count }))
  const avgComponents = Object.fromEntries(
    Object.entries(components).map(([key, v]) => [key, round(v.sum / Math.max(1, v.count), 2)]),
  )
  return { topReasons, avgComponents, examples }
}

function patternStats(points) {
  const out = {
    totalPoints: points.length,
    withPattern: 0,
    withPatternAlert: 0,
    highPatternScore: 0,
    risksWithPattern: {},
    risksWithoutPattern: {},
  }
  for (const p of points) {
    const has = Boolean(p.pattern && Number.isFinite(p.pattern.similarEpisodeCount))
    const bucket = has ? out.risksWithPattern : out.risksWithoutPattern
    bucket[p.risk] = (bucket[p.risk] || 0) + 1
    if (has) {
      out.withPattern += 1
      if (p.alert) out.withPatternAlert += 1
      if ((p.components?.patternScore ?? 0) >= 2) out.highPatternScore += 1
    }
  }
  out.withPatternRatio = round(out.withPattern / Math.max(1, points.length), 3)
  return out
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return null
  }
}

async function main() {
  const includeRecency = process.argv.includes('--recency')
  const days = argNumber('--days', 14)
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
    const vectors = await loadEpisodeVectors(client)
    const state = loadState()
    const tunedParams = state?.params || null

    const latestMs = entries.length ? entries[entries.length - 1].date : 0
    const fromMs = latestMs - days * 86_400_000
    const replayOptions = { fromMs, cleanTimeline: false }
    const ctx = buildReplayContext(entries, { ...replayOptions, episodeVectors: vectors })
    const ctxNoPattern = buildReplayContext(entries, { ...replayOptions, episodeVectors: null })

    const v1 = evaluateV1(ctx)
    const v2Default = evaluateV2(ctx, DEFAULT_PARAMS)
    const v2Tuned = tunedParams ? evaluateV2(ctx, tunedParams) : null
    const v2NoPattern = tunedParams ? evaluateV2(ctxNoPattern, tunedParams) : null
    const recency = {}
    if (includeRecency) {
      for (const days of [7, 14, 21]) {
        if (!tunedParams) continue
        recency[`${days}d`] = evaluateV2(ctx, { ...tunedParams, patternRecencyDays: days })
      }
    }
    const damping = {}
    if (tunedParams) {
      const base = {
        ...tunedParams,
        safeUncertaintyDamping: false,
        recentLowRecoveryDamping: false,
      }
      const variants = {
        baseline: base,
        safeUncertainty: { ...base, safeUncertaintyDamping: true },
        recentLowRecovery: { ...base, recentLowRecoveryDamping: true },
        both: { ...base, safeUncertaintyDamping: true, recentLowRecoveryDamping: true },
      }
      for (const [name, params] of Object.entries(variants)) damping[name] = evaluateV2(ctx, params)
    }

    const modelMetrics = {
      v1: metricLine(v1.metrics),
      v2Default: metricLine(v2Default.metrics),
      v2Tuned: v2Tuned ? metricLine(v2Tuned.metrics) : null,
      v2TunedNoPattern: v2NoPattern ? metricLine(v2NoPattern.metrics) : null,
      dampingVariants: Object.fromEntries(Object.entries(damping).map(([k, r]) => [k, metricLine(r.metrics)])),
      recencyVariants: Object.fromEntries(Object.entries(recency).map(([k, r]) => [k, metricLine(r.metrics)])),
    }

    const report = {
      generatedAt: new Date().toISOString(),
      data: dataCoverage(entries),
      replay: {
        windowDays: days,
        windowFrom: iso(fromMs),
        windowTo: iso(latestMs),
        scoredPoints: ctx.points.length,
        hypoOnsets: ctx.hypoOnsets.length,
        nearHypoOnsets: ctx.nearOnsets.length,
        sustainMinutes: ctx.sustainMin,
      },
      vectors: vectorSummary(vectors),
      liveState: state
        ? {
            active: state.active,
            params: state.params,
            trainedAt: state.trainedAt,
            activationGate: state.activationGate,
          }
        : null,
      modelMetrics,
      levelCounts: {
        v1: levelCounts(v1.points),
        v2Default: levelCounts(v2Default.points),
        v2Tuned: v2Tuned ? levelCounts(v2Tuned.points) : null,
      },
      pattern: v2Tuned ? patternStats(v2Tuned.points) : null,
      falsePositives: v2Tuned ? fpReasonStats(v2Tuned) : null,
      rawMetrics: {
        v1: stripPrivateMetrics(v1.metrics),
        v2Default: stripPrivateMetrics(v2Default.metrics),
        v2Tuned: v2Tuned ? stripPrivateMetrics(v2Tuned.metrics) : null,
      },
    }

    console.log(JSON.stringify(report, null, 2))
  } finally {
    await client.close().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error(`[analyze-hypo-quality] mislukt: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
