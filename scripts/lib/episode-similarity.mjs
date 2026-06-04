// Gedeelde episode-similarity zodat de live-sync, de backtest en de auto-tuner
// V2 exact hetzelfde `pattern`-object voeren (train/serve-pariteit). Voorheen
// leefde findSimilarEpisodes alleen in libreview-nightscout-sync.mjs, waardoor
// component 6 / patternScore live wél maar in de backtest/tuner niet werd gevoed.

const SIM_SCALES = { peakMmol: 4, dropFromPeakMmol: 3, minutesSincePeak: 30 }
const SIM_MAX_DIST = 1.5
const SIM_K = 8
const CURVE_MIN_POINTS = 8
const CURVE_MIN_SIMILARITY = 0.8
const WEEKDAYS = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag']

function sq(x) {
  return x * x
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return value
  const f = 10 ** digits
  return Math.round(value * f) / f
}

function normalize(values) {
  if (!values || !values.length) return null
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const centered = values.map((v) => v - mean)
  const norm = Math.sqrt(centered.reduce((sum, v) => sum + v * v, 0))
  if (norm < 1e-9) return centered.map(() => 0)
  return centered.map((v) => v / norm)
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return null
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return dot
}

function weekdayOfVector(v) {
  const raw = v?.nadirAt || v?.peakAt || v?.peakDate || v?.startDate || v?.endDate || v?.createdAt
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return null
  try {
    return new Intl.DateTimeFormat('nl-NL', { weekday: 'long', timeZone: 'Europe/Amsterdam' }).format(new Date(ms))
  } catch {
    return null
  }
}

function weekdayRisk(weekday, vectors) {
  if (!weekday || !vectors || !vectors.length) return null
  const counts = Object.fromEntries(WEEKDAYS.map((d) => [d, { total: 0, risky: 0 }]))
  for (const v of vectors) {
    const d = weekdayOfVector(v)
    if (!d || !counts[d]) continue
    counts[d].total += 1
    if (v.outcome === 'hypo' || v.outcome === 'near_hypo') counts[d].risky += 1
  }
  const current = counts[weekday]
  if (!current || current.total < 2) return null
  const totals = WEEKDAYS.map((d) => counts[d]).filter((c) => c.total > 0)
  const avgRisky = totals.reduce((sum, c) => sum + c.risky, 0) / Math.max(1, totals.length)
  if (avgRisky <= 0) return null
  const ratio = current.risky / avgRisky
  return {
    weekday,
    weekdayEpisodeCount: current.total,
    weekdayRiskyCount: current.risky,
    weekdayRiskRatio: round(ratio, 3),
    weekdayRiskHigh: current.risky >= 2 && ratio >= 1.5,
  }
}

// Vergelijkt de huidige situatie met opgeslagen episode_vectors. Geeft een
// gewogen drop-correctie en hoeveel vergelijkbare episodes in (near-)hypo eindigden.
export function findSimilarEpisodes(input, vectors) {
  if (!vectors || !vectors.length) return null
  const scored = []
  for (const v of vectors) {
    const f = v.featureVector
    if (!f || !Number.isFinite(f.peakMmol) || !Number.isFinite(f.dropFromPeakMmol)) continue
    let sum = sq((f.peakMmol - input.peakMmol) / SIM_SCALES.peakMmol)
    sum += sq((f.dropFromPeakMmol - input.dropFromPeakMmol) / SIM_SCALES.dropFromPeakMmol)
    if (Number.isFinite(f.minutesPeakToEnd) && Number.isFinite(input.minutesSincePeak)) {
      sum += sq((f.minutesPeakToEnd - input.minutesSincePeak) / SIM_SCALES.minutesSincePeak)
    }
    const dist = Math.sqrt(sum)
    if (dist <= SIM_MAX_DIST) scored.push({ dist, drop: f.dropFromPeakMmol, outcome: v.outcome })
  }
  if (scored.length < 3) return null

  scored.sort((a, b) => a.dist - b.dist)
  const top = scored.slice(0, SIM_K)
  let wsum = 0
  let wdrop = 0
  let hypoCount = 0
  for (const s of top) {
    const w = 1 / (1 + s.dist)
    wsum += w
    wdrop += w * (Number.isFinite(s.drop) ? s.drop : 0)
    if (s.outcome === 'hypo' || s.outcome === 'near_hypo') hypoCount += 1
  }
  const weightedDrop = wsum > 0 ? wdrop / wsum : 0
  return {
    count: top.length,
    hypoCount,
    hypoRatio: top.length ? hypoCount / top.length : 0,
    weightedDrop,
    correction: Math.max(0, weightedDrop * 0.18),
  }
}

export function findCurveMatches(liveCurveShape, vectors) {
  if (!liveCurveShape || liveCurveShape.length < CURVE_MIN_POINTS || !vectors || !vectors.length) return null
  const scored = []
  for (const v of vectors) {
    if (!Array.isArray(v.vector) || v.vector.length < liveCurveShape.length) continue
    const historicalPrefix = normalize(v.vector.slice(0, liveCurveShape.length))
    const sim = cosine(liveCurveShape, historicalPrefix)
    if (Number.isFinite(sim) && sim >= CURVE_MIN_SIMILARITY) {
      scored.push({ similarity: sim, outcome: v.outcome })
    }
  }
  if (scored.length < 3) return null
  scored.sort((a, b) => b.similarity - a.similarity)
  const top = scored.slice(0, SIM_K)
  const hypoCount = top.filter((s) => s.outcome === 'hypo' || s.outcome === 'near_hypo').length
  const avgSimilarity = top.reduce((sum, s) => sum + s.similarity, 0) / top.length
  return {
    count: top.length,
    hypoCount,
    hypoRatio: top.length ? hypoCount / top.length : 0,
    avgSimilarity,
  }
}

// Bouwt het `pattern`-object dat V2 (component 6 / patternScore) verwacht,
// gedreven door dezelfde featureset die V2 zelf ziet. Zelfde drop-context-gate
// als de live-sync: alleen bij een echte recente post-piek daling vergelijken.
export function patternFromFeatures(features, vectors) {
  if (!features) return null
  const peakMmol = features.peakMmol120m
  const dropFromPeakMmol = features.dropFromPeakMmol
  const minutesSincePeak = features.minutesSincePeak
  const isDropContext = dropFromPeakMmol >= 2 && minutesSincePeak <= 60
  if (!isDropContext) return null
  const similar = findSimilarEpisodes({ peakMmol, dropFromPeakMmol, minutesSincePeak }, vectors)
  if (!similar) return null
  const curve = findCurveMatches(features.liveCurveShape, vectors)
  const wday = weekdayRisk(features.weekday, vectors)
  return {
    similarEpisodeCount: similar.count,
    similarHypoCount: similar.hypoCount,
    similarHypoRatio: round(similar.hypoRatio, 3),
    patternNadirMmol: round(Math.max(1.5, peakMmol - similar.weightedDrop), 3),
    curveMatchCount: curve ? curve.count : 0,
    curveHypoCount: curve ? curve.hypoCount : 0,
    curveHypoRatio: curve ? round(curve.hypoRatio, 3) : null,
    curveSimilarity: curve ? round(curve.avgSimilarity, 3) : null,
    ...(wday || {}),
  }
}
