// Gedeelde episode-similarity zodat de live-sync, de backtest en de auto-tuner
// V2 exact hetzelfde `pattern`-object voeren (train/serve-pariteit). Voorheen
// leefde findSimilarEpisodes alleen in libreview-nightscout-sync.mjs, waardoor
// component 6 / patternScore live wél maar in de backtest/tuner niet werd gevoed.

// Schalen = "een verschil van deze grootte telt als 1 normeenheid". riseRate15m en
// riseFromBaseline kwamen erbij om op de aanloop (steile spike = hoog-GI) te matchen,
// niet alleen op piek+daling.
const SIM_SCALES = { peakMmol: 4, dropFromPeakMmol: 3, minutesSincePeak: 30, riseRate15m: 0.15, riseFromBaseline: 3 }
// Afstand = RMS over de actieve dimensies (sqrt(sum/dims)), niet sqrt(sum). Zo
// blaast een extra dimensie de afstand niet op en blijft de drempel vergelijkbaar
// of een vector nu 3 of 5 bruikbare features heeft. 0.866 = 1.5/sqrt(3) reproduceert
// exact het oude 3-dimensie-gedrag (sqrt(sum) <= 1.5). Mogelijk herijken via backtest.
const SIM_MAX_DIST = 0.866
const SIM_K_BASE = 8
const SIM_K_MAX = 15
const SIM_EXTRA_DIST_MARGIN = 0.18
const SIM_EXTRA_DIST_RATIO = 1.35
const CURVE_EXTRA_SIM_MARGIN = 0.04
const MEAL_RISE_MAX_DIST = 0.9
const MEAL_DROP_MAX_DIST = 0.9
const MS_PER_DAY = 86_400_000
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

function vectorTimeMs(v) {
  const raw = v?.nadirAt || v?.peakAt || v?.peakDate || v?.startDate || v?.endDate || v?.createdAt
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
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

function recencyWeight(vectorMs, currentMs, recencyDays) {
  if (!Number.isFinite(vectorMs) || !Number.isFinite(currentMs) || !Number.isFinite(recencyDays) || recencyDays <= 0) {
    return 1
  }
  const ageDays = Math.max(0, (currentMs - vectorMs) / MS_PER_DAY)
  // Half-life model: current pattern dominates, older dense data remains weak evidence.
  return Math.pow(0.5, ageDays / recencyDays)
}

function selectDistanceMatches(scored, options = {}) {
  if (!scored.length) return []
  const minCount = Math.max(1, Number.isFinite(options.minCount) ? options.minCount : 3)
  const baseK = Math.max(minCount, Number.isFinite(options.baseK) ? options.baseK : SIM_K_BASE)
  const maxK = Math.max(baseK, Number.isFinite(options.maxK) ? options.maxK : SIM_K_MAX)
  const extraMargin = Number.isFinite(options.extraMargin) ? options.extraMargin : SIM_EXTRA_DIST_MARGIN
  const extraRatio = Number.isFinite(options.extraRatio) ? options.extraRatio : SIM_EXTRA_DIST_RATIO
  const top = []
  for (const candidate of scored) {
    if (top.length >= maxK) break
    if (top.length < baseK) {
      top.push(candidate)
      continue
    }
    const bestDist = top[0].dist
    const prevDist = top[top.length - 1].dist
    if (
      candidate.dist <= bestDist + extraMargin &&
      candidate.dist <= prevDist * extraRatio + 0.02
    ) {
      top.push(candidate)
    } else {
      break
    }
  }
  return top
}

function selectCurveMatches(scored, options = {}) {
  if (!scored.length) return []
  const minCount = Math.max(1, Number.isFinite(options.minCount) ? options.minCount : 3)
  const baseK = Math.max(minCount, Number.isFinite(options.baseK) ? options.baseK : SIM_K_BASE)
  const maxK = Math.max(baseK, Number.isFinite(options.maxK) ? options.maxK : SIM_K_MAX)
  const extraMargin = Number.isFinite(options.extraMargin) ? options.extraMargin : CURVE_EXTRA_SIM_MARGIN
  const top = []
  for (const candidate of scored) {
    if (top.length >= maxK) break
    if (top.length < baseK) {
      top.push(candidate)
      continue
    }
    if (candidate.similarity >= top[0].similarity - extraMargin) top.push(candidate)
    else break
  }
  return top
}

// Vergelijkt de huidige situatie met opgeslagen episode_vectors. Geeft een
// gewogen drop-correctie en hoeveel vergelijkbare episodes in (near-)hypo eindigden.
export function findSimilarEpisodes(input, vectors, options = {}) {
  if (!vectors || !vectors.length) return null
  const scored = []
  const currentMs = Number.isFinite(options.currentMs) ? options.currentMs : null
  const recencyDays = Number.isFinite(options.recencyDays) ? options.recencyDays : null
  for (const v of vectors) {
    const vectorMs = vectorTimeMs(v)
    // Backtests must not let future episodes inform earlier replay points. Live has
    // no future vectors, but this keeps train/test parity honest.
    if (currentMs !== null && vectorMs !== null && vectorMs > currentMs) continue
    const f = v.featureVector
    if (!f || !Number.isFinite(f.peakMmol) || !Number.isFinite(f.dropFromPeakMmol)) continue
    let sum = sq((f.peakMmol - input.peakMmol) / SIM_SCALES.peakMmol)
    let dims = 1
    sum += sq((f.dropFromPeakMmol - input.dropFromPeakMmol) / SIM_SCALES.dropFromPeakMmol)
    dims += 1
    if (Number.isFinite(f.minutesPeakToEnd) && Number.isFinite(input.minutesSincePeak)) {
      sum += sq((f.minutesPeakToEnd - input.minutesSincePeak) / SIM_SCALES.minutesSincePeak)
      dims += 1
    }
    // Aanloop-dimensies: alleen meetellen als beide kanten de feature hebben, zodat
    // oudere episode_vectors (zonder deze velden) niet wegvallen tijdens de overgang.
    if (Number.isFinite(f.riseRate15m) && Number.isFinite(input.riseRate15m)) {
      sum += sq((f.riseRate15m - input.riseRate15m) / SIM_SCALES.riseRate15m)
      dims += 1
    }
    if (Number.isFinite(f.riseFromBaseline) && Number.isFinite(input.riseFromBaseline)) {
      sum += sq((f.riseFromBaseline - input.riseFromBaseline) / SIM_SCALES.riseFromBaseline)
      dims += 1
    }
    const dist = Math.sqrt(sum / dims)
    if (dist <= SIM_MAX_DIST) {
      scored.push({
        dist,
        drop: f.dropFromPeakMmol,
        outcome: v.outcome,
        recencyWeight: recencyWeight(vectorMs, currentMs, recencyDays),
      })
    }
  }
  if (scored.length < 3) return null

  scored.sort((a, b) => a.dist - b.dist)
  const top = selectDistanceMatches(scored)
  let wsum = 0
  let wdrop = 0
  let whypo = 0
  let hypoCount = 0
  for (const s of top) {
    const w = (1 / (1 + s.dist)) * s.recencyWeight
    wsum += w
    wdrop += w * (Number.isFinite(s.drop) ? s.drop : 0)
    if (s.outcome === 'hypo' || s.outcome === 'near_hypo') {
      hypoCount += 1
      whypo += w
    }
  }
  const weightedDrop = wsum > 0 ? wdrop / wsum : 0
  return {
    count: top.length,
    hypoCount,
    hypoRatio: wsum > 0 ? whypo / wsum : top.length ? hypoCount / top.length : 0,
    weightedDrop,
    correction: Math.max(0, weightedDrop * 0.18),
  }
}

export function findCurveMatches(liveCurveShape, vectors, options = {}) {
  if (!liveCurveShape || liveCurveShape.length < CURVE_MIN_POINTS || !vectors || !vectors.length) return null
  const scored = []
  const currentMs = Number.isFinite(options.currentMs) ? options.currentMs : null
  const recencyDays = Number.isFinite(options.recencyDays) ? options.recencyDays : null
  for (const v of vectors) {
    const vectorMs = vectorTimeMs(v)
    if (currentMs !== null && vectorMs !== null && vectorMs > currentMs) continue
    if (!Array.isArray(v.vector) || v.vector.length < liveCurveShape.length) continue
    const historicalPrefix = normalize(v.vector.slice(0, liveCurveShape.length))
    const sim = cosine(liveCurveShape, historicalPrefix)
    if (Number.isFinite(sim) && sim >= CURVE_MIN_SIMILARITY) {
      scored.push({ similarity: sim, outcome: v.outcome, recencyWeight: recencyWeight(vectorMs, currentMs, recencyDays) })
    }
  }
  if (scored.length < 3) return null
  scored.sort((a, b) => b.similarity - a.similarity)
  const top = selectCurveMatches(scored)
  const hypoCount = top.filter((s) => s.outcome === 'hypo' || s.outcome === 'near_hypo').length
  let wsum = 0
  let whypo = 0
  let wsim = 0
  for (const s of top) {
    const w = s.recencyWeight
    wsum += w
    wsim += w * s.similarity
    if (s.outcome === 'hypo' || s.outcome === 'near_hypo') whypo += w
  }
  const avgSimilarity = wsum > 0 ? wsim / wsum : top.reduce((sum, s) => sum + s.similarity, 0) / top.length
  return {
    count: top.length,
    hypoCount,
    hypoRatio: wsum > 0 ? whypo / wsum : top.length ? hypoCount / top.length : 0,
    avgSimilarity,
  }
}

// Bouwt het `pattern`-object dat V2 (component 6 / patternScore) verwacht,
// gedreven door dezelfde featureset die V2 zelf ziet. Zelfde drop-context-gate
// als de live-sync: alleen bij een echte recente post-piek daling vergelijken.
export function patternFromFeatures(features, vectors, options = {}) {
  if (!features) return null
  const peakMmol = features.peakMmol120m
  const dropFromPeakMmol = features.dropFromPeakMmol
  const minutesSincePeak = features.minutesSincePeak
  const isDropContext = dropFromPeakMmol >= 2 && minutesSincePeak <= 60
  if (!isDropContext) return null
  const currentMs = Number.isFinite(features.date) ? features.date : null
  const similar = findSimilarEpisodes(
    {
      peakMmol,
      dropFromPeakMmol,
      minutesSincePeak,
      riseRate15m: features.riseRate15m,
      riseFromBaseline: features.riseFromBaseline,
    },
    vectors,
    { currentMs, recencyDays: options.recencyDays },
  )
  if (!similar) return null
  const curve = findCurveMatches(features.liveCurveShape, vectors, { currentMs, recencyDays: options.recencyDays })
  const wday = options.enableWeekday ? weekdayRisk(features.weekday, vectors) : null
  return {
    similarEpisodeCount: similar.count,
    similarHypoCount: similar.hypoCount,
    similarHypoRatio: round(similar.hypoRatio, 3),
    // Drop-correctie voor de V1-forecast: gelijk aan wat de losse findSimilarEpisodes-
    // call vroeger leverde, maar nu uit exact dezelfde (feature-pad) match zodat V1 en
    // V2 niet langer op verschillende buren steunen.
    correction: similar.correction,
    weightedDrop: round(similar.weightedDrop, 3),
    patternNadirMmol: round(Math.max(1.5, peakMmol - similar.weightedDrop), 3),
    curveMatchCount: curve ? curve.count : 0,
    curveHypoCount: curve ? curve.hypoCount : 0,
    curveHypoRatio: curve ? round(curve.hypoRatio, 3) : null,
    curveSimilarity: curve ? round(curve.avgSimilarity, 3) : null,
    ...(wday || {}),
  }
}

function classifyPatternRisk(hypoRatio, weightedDrop, options = {}) {
  if (options.maxRisk === 'watch' && (hypoRatio >= 0.35 || weightedDrop >= 1.8)) return 'watch'
  if (hypoRatio >= 0.6 || weightedDrop >= 2.6) return 'high'
  if (hypoRatio >= 0.35 || weightedDrop >= 1.8) return 'watch'
  return 'low'
}

function patternSummary(scored, minCount, options = {}) {
  if (scored.length < minCount) return null
  scored.sort((a, b) => a.dist - b.dist)
  const top = selectDistanceMatches(scored, { minCount })
  let wsum = 0
  let wdrop = 0
  let whypo = 0
  let hypoCount = 0
  for (const s of top) {
    const w = (1 / (1 + s.dist)) * s.recencyWeight
    wsum += w
    wdrop += w * (Number.isFinite(s.drop) ? s.drop : 0)
    if (s.outcome === 'hypo' || s.outcome === 'near_hypo') {
      hypoCount += 1
      whypo += w
    }
  }
  const weightedDrop = wsum > 0 ? wdrop / wsum : 0
  const hypoRatio = wsum > 0 ? whypo / wsum : top.length ? hypoCount / top.length : 0
  return {
    similarEpisodeCount: top.length,
    similarHypoCount: hypoCount,
    similarHypoRatio: round(hypoRatio, 3),
    weightedDrop: round(weightedDrop, 3),
    patternRisk: classifyPatternRisk(hypoRatio, weightedDrop, options),
  }
}

// Maaltijd-detector vectorlaag: gebruikt episode_vectors als extra risicosignaal
// voor een al gedetecteerde maaltijdstatus. Deze functie bepaalt bewust geen phase.
export function mealPatternFromState(meal, vectors, options = {}) {
  if (!meal || !vectors || !vectors.length) return null
  if (!['rising', 'plateau', 'reactive-drop'].includes(meal.phase)) return null

  const currentMs = Number.isFinite(options.currentMs) ? options.currentMs : null
  const recencyDays = Number.isFinite(options.recencyDays) ? options.recencyDays : null
  const scored = []

  for (const v of vectors) {
    const vectorMs = vectorTimeMs(v)
    if (currentMs !== null && vectorMs !== null && vectorMs > currentMs) continue
    const f = v.featureVector
    if (!f) continue

    if (meal.phase === 'reactive-drop') {
      if (!Number.isFinite(f.peakMmol) || !Number.isFinite(f.dropFromPeakMmol)) continue
      if (!Number.isFinite(meal.peakMmol) || !Number.isFinite(meal.dropFromPeak)) continue
      let sum = sq((f.peakMmol - meal.peakMmol) / SIM_SCALES.peakMmol)
      let dims = 1
      sum += sq((f.dropFromPeakMmol - meal.dropFromPeak) / SIM_SCALES.dropFromPeakMmol)
      dims += 1
      if (Number.isFinite(f.minutesPeakToEnd) && Number.isFinite(meal.minutesSincePeak)) {
        sum += sq((f.minutesPeakToEnd - meal.minutesSincePeak) / SIM_SCALES.minutesSincePeak)
        dims += 1
      }
      const dist = Math.sqrt(sum / dims)
      if (dist <= MEAL_DROP_MAX_DIST) {
        scored.push({
          dist,
          drop: f.dropFromPeakMmol,
          outcome: v.outcome,
          recencyWeight: recencyWeight(vectorMs, currentMs, recencyDays),
        })
      }
      continue
    }

    const riseRate = Number.isFinite(meal.effRate) ? meal.effRate : null
    const riseFromBaseline = Number.isFinite(meal.riseFromTrough) ? meal.riseFromTrough : null
    if (!Number.isFinite(f.riseRate15m) || !Number.isFinite(f.riseFromBaseline)) continue
    if (!Number.isFinite(riseRate) || !Number.isFinite(riseFromBaseline)) continue

    let sum = sq((f.riseRate15m - riseRate) / SIM_SCALES.riseRate15m)
    sum += sq((f.riseFromBaseline - riseFromBaseline) / SIM_SCALES.riseFromBaseline)
    const dist = Math.sqrt(sum / 2)
    if (dist <= MEAL_RISE_MAX_DIST) {
      scored.push({
        dist,
        drop: f.dropFromPeakMmol,
        outcome: v.outcome,
        recencyWeight: recencyWeight(vectorMs, currentMs, recencyDays),
      })
    }
  }

  const minCount = meal.phase === 'reactive-drop' ? 3 : 4
  const summary = patternSummary(scored, minCount, { maxRisk: meal.phase === 'reactive-drop' ? null : 'watch' })
  if (!summary) return null
  return {
    ...summary,
    patternKind: meal.phase === 'reactive-drop' ? 'post-peak-drop' : 'rise-onset',
  }
}
