// Pure featurebuilder voor de reactieve-hypo detector (V2).
//
// Eén bron van waarheid: zowel de live sync (libreview-nightscout-sync.mjs) als
// de offline backtest (evaluate-hypo-detector.mjs) moeten dezelfde features uit
// dezelfde timeline halen. Daarom heeft deze module GEEN database- of
// netwerk-afhankelijkheden — alleen een tijdreeks in, een featureset uit.
//
// Timeline-formaat: array van Nightscout-achtige metingen, oplopend gesorteerd
// op tijd: { date: <ms epoch>, sgv: <mg/dL> }. mmol wordt intern afgeleid.

export const MGDL_PER_MMOL = 18.0182

// Gewichten identiek aan libreview-nightscout-sync.mjs zodat blendedRate live en
// offline exact gelijk uitvalt.
const BLEND_WEIGHTS = { r5: 0.5, r10: 0.33, r15: 0.17 }
const PEAK_WINDOW_MINUTES = 120
const RECENT_LOW_WINDOW_MINUTES = 120
const FALL_RATE_WINDOWS = [5, 10, 15, 20, 30]
const DEFAULT_LAG_MINUTES = 5
const DEFAULT_TIME_ZONE = 'Europe/Amsterdam'
const CURVE_PRE_PEAK_MINUTES = 20
const CURVE_TOTAL_MINUTES = 60
const CURVE_TOTAL_POINTS = 24
// Aanloop-features (stijgsnelheid + spike t.o.v. baseline). Vensters identiek aan
// build-episode-vectors.mjs zodat live en de opgeslagen episode_vectors exact
// dezelfde grootheid vergelijken (train/serve-pariteit voor de similarity-match).
const RISE_BASELINE_FROM_MIN = 40 // baseline = gemiddelde [-40, -15] min vóór de piek
const RISE_BASELINE_TO_MIN = 15
const RISE_RATE_MINUTES = 15 // gladde gem. stijgsnelheid over 15 min vóór de piek
export const SPIKE_FILTER_THRESHOLD_MGDL = 8
const SPIKE_FILTER_MIN_GAP_MS = 30_000
const SPIKE_FILTER_MAX_GAP_MS = 150_000
const QUALITY_EXPECTED_INTERVAL_MS = 60_000
const QUALITY_MAX_NORMAL_GAP_MS = 150_000
const QUALITY_MAX_STALE_SECONDS = 10 * 60
const QUALITY_RECENT_WINDOW_MINUTES = 30

// Stap 8 — meal-onset: een maaltijdrespons is begonnen als de glucose duidelijk
// stijgt vanaf een lokale bodem die al ≥ 15 min geleden ligt (geen 1-punts blip).
const MEAL_TROUGH_WINDOW_MINUTES = 60
const MEAL_ONSET_RISE_MMOL = 0.8 // stijging in laatste 15 min én vanaf de bodem
const MEAL_ONSET_MIN_TROUGH_AGE = 15 // lokale bodem ≥ 15 min geleden

// Variabele CGM-lag: bij snelle daling loopt de sensor meer achter op het
// echte bloed. Waarden gebaseerd op CGM-literatuur + jouw episode-data.
function effectiveLagMinutes(rate10m) {
  if (!Number.isFinite(rate10m)) return DEFAULT_LAG_MINUTES
  if (rate10m <= -0.07) return 7
  if (rate10m <= -0.04) return 5
  if (rate10m < 0) return 3
  return 0
}

export function round(value, decimals) {
  if (!Number.isFinite(value)) return null
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

export function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value))
}

function toMmol(sgv) {
  return Number(sgv) / MGDL_PER_MMOL
}

function median3(a, b, c) {
  return [a, b, c].sort((x, y) => x - y)[1]
}

function isOneMinuteNeighborGap(ms) {
  return ms >= SPIKE_FILTER_MIN_GAP_MS && ms <= SPIKE_FILTER_MAX_GAP_MS
}

export function isSinglePointSpike(prev, current, next, thresholdMgdl = SPIKE_FILTER_THRESHOLD_MGDL) {
  if (!prev || !current || !next) return false
  const a = Number(prev.sgv)
  const p = Number(current.sgv)
  const c = Number(next.sgv)
  const ta = Number(prev.date)
  const tp = Number(current.date)
  const tc = Number(next.date)
  if (![a, p, c, ta, tp, tc].every(Number.isFinite)) return false
  if (!isOneMinuteNeighborGap(tp - ta) || !isOneMinuteNeighborGap(tc - tp)) return false
  const med = median3(a, p, c)
  return Math.abs(p - med) > thresholdMgdl && Math.abs(a - c) < thresholdMgdl
}

// Laag 9 — werk-timeline cleaning: single-point artefacten dempen vóór rates/features.
// Ruwe entries blijven ongemoeid; alleen de geretourneerde timeline gebruikt een
// median-of-3 vervanging. De laatste meting heeft geen buur-na en wordt causally
// niet aangepast; een verdachte laatste sprong moet door de volgende reading worden
// bevestigd voordat hij via historische cleaning verdwijnt.
export function cleanGlucoseTimeline(timeline, options = {}) {
  const thresholdMgdl = Number.isFinite(options.thresholdMgdl)
    ? options.thresholdMgdl
    : SPIKE_FILTER_THRESHOLD_MGDL
  return timeline.map((entry, index) => {
    const prev = timeline[index - 1]
    const next = timeline[index + 1]
    if (!isSinglePointSpike(prev, entry, next, thresholdMgdl)) return entry
    const cleanedSgv = median3(Number(prev.sgv), Number(entry.sgv), Number(next.sgv))
    return {
      ...entry,
      rawSgv: entry.rawSgv ?? entry.sgv,
      sgv: cleanedSgv,
      spikeFiltered: true,
    }
  })
}

export function assessTimelineQuality(timeline, latestIndex, options = {}) {
  const latest = timeline[latestIndex]
  if (!latest) {
    return {
      level: 'degraded',
      score: 0,
      reasons: ['Geen laatste meting beschikbaar'],
      flags: { missingLatest: true },
    }
  }

  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : null
  const recentWindowMinutes = Number.isFinite(options.recentWindowMinutes)
    ? options.recentWindowMinutes
    : QUALITY_RECENT_WINDOW_MINUTES
  const maxNormalGapMs = Number.isFinite(options.maxNormalGapMs)
    ? options.maxNormalGapMs
    : QUALITY_MAX_NORMAL_GAP_MS
  const maxStaleSeconds = Number.isFinite(options.maxStaleSeconds)
    ? options.maxStaleSeconds
    : QUALITY_MAX_STALE_SECONDS

  const fromMs = latest.date - recentWindowMinutes * 60_000
  const recent = []
  for (let i = 0; i <= latestIndex; i += 1) {
    const entry = timeline[i]
    if (!entry || !Number.isFinite(Number(entry.date))) continue
    if (entry.date >= fromMs && entry.date <= latest.date) recent.push(entry)
  }

  const flags = {
    missingLatest: false,
    stale: false,
    duplicateTimestamp: false,
    outOfOrder: false,
    largeGap: false,
    sparseRecentData: false,
    futureTimestamp: false,
  }
  const reasons = []
  let largestGapSeconds = 0
  let medianIntervalSeconds = null
  const intervals = []
  const seen = new Set()

  for (let i = 0; i < recent.length; i += 1) {
    const time = Number(recent[i].date)
    if (seen.has(time)) flags.duplicateTimestamp = true
    seen.add(time)
    if (i > 0) {
      const prev = Number(recent[i - 1].date)
      const gap = time - prev
      if (gap <= 0) flags.outOfOrder = true
      else {
        intervals.push(gap / 1000)
        largestGapSeconds = Math.max(largestGapSeconds, gap / 1000)
        if (gap > maxNormalGapMs) flags.largeGap = true
      }
    }
  }

  if (intervals.length) {
    const sorted = [...intervals].sort((a, b) => a - b)
    medianIntervalSeconds = sorted[Math.floor(sorted.length / 2)]
  }

  const recentSpanMinutes = recent.length > 1
    ? (Number(recent[recent.length - 1].date) - Number(recent[0].date)) / 60_000
    : 0
  if (recentSpanMinutes >= 10 && recent.length < Math.max(5, Math.floor(recentSpanMinutes / 2))) {
    flags.sparseRecentData = true
  }

  let ageSeconds = null
  if (nowMs !== null) {
    ageSeconds = Math.round((nowMs - latest.date) / 1000)
    if (ageSeconds > maxStaleSeconds) flags.stale = true
    if (ageSeconds < -120) flags.futureTimestamp = true
  }

  if (flags.stale) reasons.push('Laatste LibreView-meting is oud')
  if (flags.futureTimestamp) reasons.push('Laatste timestamp ligt in de toekomst')
  if (flags.largeGap) reasons.push(`Gat in recente metingen (${Math.round(largestGapSeconds)} sec)`)
  if (flags.duplicateTimestamp) reasons.push('Dubbele timestamp in recente metingen')
  if (flags.outOfOrder) reasons.push('Timestamps lopen niet oplopend')
  if (flags.sparseRecentData) reasons.push('Weinig recente metingen voor betrouwbare trend')

  let score = 1
  if (flags.stale || flags.futureTimestamp || flags.outOfOrder) score -= 0.45
  if (flags.largeGap) score -= 0.25
  if (flags.duplicateTimestamp) score -= 0.2
  if (flags.sparseRecentData) score -= 0.15
  score = clamp(score, 0, 1)

  const level = score >= 0.85 ? 'good' : score >= 0.6 ? 'watch' : 'degraded'

  return {
    level,
    score: round(score, 3),
    reasons,
    flags,
    recentCount: recent.length,
    recentWindowMinutes,
    recentSpanMinutes: round(recentSpanMinutes, 1),
    largestGapSeconds: round(largestGapSeconds, 1),
    medianIntervalSeconds: medianIntervalSeconds === null ? null : round(medianIntervalSeconds, 1),
    expectedIntervalSeconds: round(QUALITY_EXPECTED_INTERVAL_MS / 1000, 0),
    ageSeconds,
  }
}

// Slope in mmol/L/min over ~minutesBack, gemeten vanaf de meting op-of-vóór het
// doelmoment. Geeft null bij onvoldoende historie. Spiegelt de logica van
// calcRateFromTimeline in de sync.
export function calcRate(timeline, latestIndex, minutesBack) {
  const latest = timeline[latestIndex]
  if (!latest) return null
  const target = latest.date - minutesBack * 60_000
  for (let i = latestIndex - 1; i >= 0; i -= 1) {
    if (timeline[i].date <= target) {
      const dtMin = (latest.date - timeline[i].date) / 60_000
      if (dtMin <= 0) return null
      return (toMmol(latest.sgv) - toMmol(timeline[i].sgv)) / dtMin
    }
  }
  return null
}

// Verschil in mmol t.o.v. ~minutesBack terug (positief = gestegen).
function calcDelta(timeline, latestIndex, minutesBack) {
  const latest = timeline[latestIndex]
  if (!latest) return null
  const target = latest.date - minutesBack * 60_000
  for (let i = latestIndex - 1; i >= 0; i -= 1) {
    if (timeline[i].date <= target) {
      return toMmol(latest.sgv) - toMmol(timeline[i].sgv)
    }
  }
  return null
}

export function blendedRateFrom(rate5m, rate10m, rate15m) {
  const r5 = Number.isFinite(rate5m) ? rate5m : null
  const r10 = Number.isFinite(rate10m) ? rate10m : null
  const r15 = Number.isFinite(rate15m) ? rate15m : null
  const num =
    (r5 ?? 0) * BLEND_WEIGHTS.r5 +
    (r10 ?? 0) * BLEND_WEIGHTS.r10 +
    (r15 ?? 0) * BLEND_WEIGHTS.r15
  const den =
    (r5 === null ? 0 : BLEND_WEIGHTS.r5) +
    (r10 === null ? 0 : BLEND_WEIGHTS.r10) +
    (r15 === null ? 0 : BLEND_WEIGHTS.r15)
  return den > 0 ? num / den : 0
}

// Hoogste meting binnen het piekvenster vóór (en inclusief) de huidige meting.
// Bij gelijke pieken houden we de vroegste aan, zodat minutesSincePeak de tijd
// sinds het bereiken van de piek weergeeft.
function findPeak(timeline, latestIndex, windowMinutes) {
  const latest = timeline[latestIndex]
  const from = latest.date - windowMinutes * 60_000
  let peak = timeline[latestIndex]
  for (let i = latestIndex; i >= 0; i -= 1) {
    if (timeline[i].date < from) break
    if (Number(timeline[i].sgv) >= Number(peak.sgv)) peak = timeline[i]
  }
  return peak
}

// Laagste meting binnen het maaltijdvenster vóór (en inclusief) nu. Bij gelijke
// bodems houden we de meest recente aan, zodat minutesSinceTrough de tijd sinds
// het begin van de huidige stijging weergeeft.
function findTrough(timeline, latestIndex, windowMinutes) {
  const latest = timeline[latestIndex]
  const from = latest.date - windowMinutes * 60_000
  let trough = timeline[latestIndex]
  for (let i = latestIndex; i >= 0; i -= 1) {
    if (timeline[i].date < from) break
    if (Number(timeline[i].sgv) < Number(trough.sgv)) trough = timeline[i]
  }
  return trough
}

// Gemiddelde mmol over [fromMs, toMs] (oplopend gesorteerde timeline). null bij
// geen metingen in het venster.
function meanInWindow(timeline, fromMs, toMs) {
  let sum = 0
  let n = 0
  for (const entry of timeline) {
    if (entry.date < fromMs) continue
    if (entry.date > toMs) break
    sum += toMmol(entry.sgv)
    n += 1
  }
  return n > 0 ? sum / n : null
}

// Gladde gem. stijgsnelheid (mmol/min) over ~minutesBack vóór de piek, gemeten
// vanaf de meting op-of-vóór dat moment. Geclamped op 0 (alleen stijging telt) en
// null bij onvoldoende historie. Spiegelt riseRateToPeak in build-episode-vectors.
function riseRateToPeak(timeline, peak, minutesBack) {
  const target = peak.date - minutesBack * 60_000
  let before = null
  for (const entry of timeline) {
    if (entry.date > target) break
    before = entry
  }
  if (!before) return null
  const dtMin = (peak.date - before.date) / 60_000
  if (dtMin <= 0) return null
  return Math.max(0, (toMmol(peak.sgv) - toMmol(before.sgv)) / dtMin)
}

function findRecentLow(timeline, latestIndex, windowMinutes) {
  const latest = timeline[latestIndex]
  const from = latest.date - windowMinutes * 60_000
  let low = timeline[latestIndex]
  for (let i = latestIndex; i >= 0; i -= 1) {
    if (timeline[i].date < from) break
    if (Number(timeline[i].sgv) <= Number(low.sgv)) low = timeline[i]
  }
  return low
}

function resampleCurve(timeline, fromMs, toMs, points) {
  if (!timeline.length || points < 2 || toMs <= fromMs) return null
  const out = []
  const span = toMs - fromMs
  for (let k = 0; k < points; k += 1) {
    const target = fromMs + (span * k) / (points - 1)
    let best = null
    let bestDiff = Infinity
    for (const entry of timeline) {
      if (entry.date < fromMs || entry.date > toMs) continue
      const diff = Math.abs(entry.date - target)
      if (diff < bestDiff) {
        best = entry
        bestDiff = diff
      }
    }
    if (!best) return null
    out.push(toMmol(best.sgv))
  }
  return out
}

function normalizeShape(values) {
  if (!values || !values.length) return null
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const centered = values.map((v) => v - mean)
  const norm = Math.sqrt(centered.reduce((sum, v) => sum + v * v, 0))
  if (norm < 1e-9) return centered.map(() => 0)
  return centered.map((v) => round(v / norm, 4))
}

function partialCurveShape(timeline, peak, latest) {
  const fromMs = peak.date - CURVE_PRE_PEAK_MINUTES * 60_000
  const toMs = latest.date
  const elapsedMinutes = (toMs - fromMs) / 60_000
  if (elapsedMinutes < 15) return null
  const points = clamp(Math.round((elapsedMinutes / CURVE_TOTAL_MINUTES) * CURVE_TOTAL_POINTS), 6, CURVE_TOTAL_POINTS)
  const curve = resampleCurve(timeline, fromMs, toMs, points)
  return normalizeShape(curve)
}

function postPeakWindow(minutesSincePeak, dropFromPeakMmol) {
  if (dropFromPeakMmol < 0.5) return 'none'
  if (minutesSincePeak <= 15) return 'early'
  if (minutesSincePeak <= 45) return 'middle'
  if (minutesSincePeak <= 90) return 'late'
  return 'none'
}

function localHourOf(ms, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('nl-NL', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone,
    }).formatToParts(new Date(ms))
    const hour = Number(parts.find((p) => p.type === 'hour')?.value)
    return Number.isInteger(hour) ? hour : new Date(ms).getUTCHours()
  } catch {
    return new Date(ms).getUTCHours()
  }
}

function timeOfDayFor(ms, timeZone = DEFAULT_TIME_ZONE) {
  const hour = localHourOf(ms, timeZone)
  if (hour < 6) return 'nacht'
  if (hour < 10) return 'ochtend'
  if (hour < 15) return 'middag'
  if (hour < 19) return 'middag2'
  return 'avond'
}

function weekdayFor(ms, timeZone = DEFAULT_TIME_ZONE) {
  try {
    return new Intl.DateTimeFormat('nl-NL', { weekday: 'long', timeZone }).format(new Date(ms))
  } catch {
    return new Intl.DateTimeFormat('nl-NL', { weekday: 'long', timeZone: 'UTC' }).format(new Date(ms))
  }
}

// Bouwt de volledige featureset voor één meetpunt (timeline[idx]). Gebruikt
// uitsluitend data tot en met idx, zodat live en backtest identiek zijn.
export function buildHypoFeatures(timeline, idx, options = {}) {
  const workTimeline = options.cleanTimeline === false ? timeline : cleanGlucoseTimeline(timeline, options)
  const lagMinutes = Number.isFinite(options.lagMinutes) ? options.lagMinutes : DEFAULT_LAG_MINUTES
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : null
  const latest = workTimeline[idx]
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE
  const currentMmol = toMmol(latest.sgv)
  const previousMmol = idx > 0 ? toMmol(workTimeline[idx - 1].sgv) : null
  const dataQuality = assessTimelineQuality(workTimeline, idx, { nowMs, ...options.dataQuality })

  const rate5m = calcRate(workTimeline, idx, 5)
  const rate10m = calcRate(workTimeline, idx, 10)
  const rate15m = calcRate(workTimeline, idx, 15)
  const rate30m = calcRate(workTimeline, idx, 30)
  const blendedRate = blendedRateFrom(rate5m, rate10m, rate15m)

  // Steilste daling in de laatste 30 min: meest negatieve window-rate.
  let maxFallRate30m = 0
  for (const w of FALL_RATE_WINDOWS) {
    const r = calcRate(workTimeline, idx, w)
    if (Number.isFinite(r) && r < maxFallRate30m) maxFallRate30m = r
  }

  const isAcceleratingDown =
    Number.isFinite(rate5m) && Number.isFinite(rate10m) && rate5m < rate10m - 0.005 && rate5m < 0
  const isRecovering =
    Number.isFinite(rate5m) && Number.isFinite(rate10m) && rate5m > rate10m + 0.005

  // Stap 1 — dalingsversnelling (mmol/min²): positief = versnelt, negatief = vlakt af.
  // Gebruik rate5m vs rate15m over een 10-min tijdsbasis voor meer stabiliteit.
  const acceleration =
    Number.isFinite(rate5m) && Number.isFinite(rate15m)
      ? round((rate5m - rate15m) / 10, 5)
      : null
  // Daling vlakt aantoonbaar af (twee opeenvolgende rate-vensters worden minder negatief).
  const isDecelerating =
    Number.isFinite(rate5m) && Number.isFinite(rate10m) && Number.isFinite(rate15m) &&
    rate5m > rate10m + 0.003 && rate10m > rate15m + 0.003 && rate15m < -0.005

  // Stap 2 — hersteldetectie: daling haast gestopt of draait al om.
  const isBottoming =
    Number.isFinite(rate5m) && Math.abs(rate5m) < 0.01 && Number.isFinite(rate10m) && rate10m < -0.01
  const recoverySignal =
    Number.isFinite(rate5m) && rate5m > 0 && Number.isFinite(rate10m) && rate10m < 0

  const peak = findPeak(workTimeline, idx, PEAK_WINDOW_MINUTES)
  const peakMmol120m = toMmol(peak.sgv)
  const minutesSincePeak = (latest.date - peak.date) / 60_000
  const dropFromPeakMmol = peakMmol120m - currentMmol
  const dropFromPeakPercent = peakMmol120m > 0 ? (dropFromPeakMmol / peakMmol120m) * 100 : 0
  const peakToCurrentSlope = minutesSincePeak > 0 ? dropFromPeakMmol / minutesSincePeak : 0
  const liveCurveShape = partialCurveShape(workTimeline, peak, latest)

  // Aanloop naar de piek: steile spike (hoog-GI) voorspelt de reactieve crash. We
  // matchen hier later op zodat twee episodes met dezelfde piek+daling maar een
  // andere aanloop niet langer als "gelijk" tellen.
  const riseBaseline = meanInWindow(
    workTimeline,
    peak.date - RISE_BASELINE_FROM_MIN * 60_000,
    peak.date - RISE_BASELINE_TO_MIN * 60_000,
  )
  const riseFromBaseline = riseBaseline === null ? null : peakMmol120m - riseBaseline
  const riseRate15m = riseRateToPeak(workTimeline, peak, RISE_RATE_MINUTES)

  const recentLow = findRecentLow(workTimeline, idx, RECENT_LOW_WINDOW_MINUTES)
  const recentLowMmol = toMmol(recentLow.sgv)
  const minutesSinceRecentLow = (latest.date - recentLow.date) / 60_000
  const reboundFromRecentLowMmol = currentMmol - recentLowMmol

  // Geschatte tijd tot grenswaarden bij huidige (negatieve) blendedRate.
  const fallRate = blendedRate < -0.01 ? Math.abs(blendedRate) : null
  const minutesTo45 = fallRate && currentMmol > 4.5 ? (currentMmol - 4.5) / fallRate : null
  const minutesTo40 = fallRate && currentMmol > 4.0 ? (currentMmol - 4.0) / fallRate : null

  // Stap 6 — variabele CGM-lag: hoe sneller de daling, hoe meer de sensor achterloopt.
  // Overschrijfbaar via options.lagMinutes (bijv. voor backtest-calibratie).
  const effLag = Number.isFinite(options.lagMinutes) ? options.lagMinutes : effectiveLagMinutes(rate10m)
  const lagAdjustedMmol = currentMmol + blendedRate * effLag

  // Stap 8 — meal-onset detector: herken dat een maaltijdpiek is begonnen (sterke
  // stijging vanaf een bodem ≥ 15 min geleden) zodat de detector al in de stijgende
  // fase kan waarschuwen i.p.v. pas als de reactieve daling begint.
  const delta15m = calcDelta(workTimeline, idx, 15)
  const trough = findTrough(workTimeline, idx, MEAL_TROUGH_WINDOW_MINUTES)
  const minutesSinceTrough = (latest.date - trough.date) / 60_000
  const riseFromTroughMmol = currentMmol - toMmol(trough.sgv)
  const rising = blendedRate > 0 || (Number.isFinite(rate10m) && rate10m > 0)
  const mealOnset =
    Number.isFinite(delta15m) &&
    delta15m >= MEAL_ONSET_RISE_MMOL &&
    minutesSinceTrough >= MEAL_ONSET_MIN_TROUGH_AGE &&
    riseFromTroughMmol >= MEAL_ONSET_RISE_MMOL &&
    rising

  return {
    // raw
    date: latest.date,
    currentMmol: round(currentMmol, 3),
    previousMmol: previousMmol === null ? null : round(previousMmol, 3),
    delta5m: round(calcDelta(workTimeline, idx, 5), 3),
    delta10m: round(calcDelta(workTimeline, idx, 10), 3),
    delta15m: round(delta15m, 3),
    spikeFiltered: Boolean(latest.spikeFiltered),
    rawSgv: latest.rawSgv ?? null,
    ageSeconds: nowMs === null ? null : Math.max(0, Math.round((nowMs - latest.date) / 1000)),
    dataQuality,
    // speed
    rate5m: round(rate5m, 4),
    rate10m: round(rate10m, 4),
    rate15m: round(rate15m, 4),
    rate30m: round(rate30m, 4),
    blendedRate: round(blendedRate, 4),
    maxFallRate30m: round(maxFallRate30m, 4),
    isAcceleratingDown,
    isRecovering,
    acceleration,
    isDecelerating,
    isBottoming,
    recoverySignal,
    effectiveLagMinutes: effLag,
    // peak/drop
    peakMmol120m: round(peakMmol120m, 3),
    minutesSincePeak: round(minutesSincePeak, 1),
    dropFromPeakMmol: round(dropFromPeakMmol, 3),
    dropFromPeakPercent: round(dropFromPeakPercent, 1),
    peakToCurrentSlope: round(peakToCurrentSlope, 4),
    riseFromBaseline: riseFromBaseline === null ? null : round(riseFromBaseline, 3),
    riseRate15m: riseRate15m === null ? null : round(riseRate15m, 4),
    postPeakWindow: postPeakWindow(minutesSincePeak, dropFromPeakMmol),
    recentLowMmol: round(recentLowMmol, 3),
    minutesSinceRecentLow: round(minutesSinceRecentLow, 1),
    reboundFromRecentLowMmol: round(reboundFromRecentLowMmol, 3),
    recentLevel1Hypo: recentLowMmol < 3.9 && minutesSinceRecentLow <= RECENT_LOW_WINDOW_MINUTES,
    recentLevel2Hypo: recentLowMmol < 3.0 && minutesSinceRecentLow <= RECENT_LOW_WINDOW_MINUTES,
    timeOfDay: timeOfDayFor(latest.date, timeZone),
    weekday: weekdayFor(latest.date, timeZone),
    liveCurveShape,
    // meal-onset (stap 8)
    mealOnset,
    riseFromTroughMmol: round(riseFromTroughMmol, 3),
    minutesSinceTrough: round(minutesSinceTrough, 1),
    // forecast (deterministisch)
    minutesTo45: minutesTo45 === null ? null : round(minutesTo45, 1),
    minutesTo40: minutesTo40 === null ? null : round(minutesTo40, 1),
    lagAdjustedMmol: round(lagAdjustedMmol, 3),
    // context (nog leeg; schema klaar voor later)
    mealMinutesAgo: options.mealMinutesAgo ?? null,
    carbsEstimate: options.carbsEstimate ?? null,
    exerciseMinutesAgo: options.exerciseMinutesAgo ?? null,
    manualFeeling: options.manualFeeling ?? null,
    fingerstickMmol: options.fingerstickMmol ?? null,
  }
}

// Helper voor fixtures/tests: bouw een timeline uit een lijst { minutesAgo, mmol }.
export function timelineFromReadings(readings, nowMs = Date.now()) {
  return readings
    .map((r) => ({
      date: nowMs - r.minutesAgo * 60_000,
      sgv: Math.round(r.mmol * MGDL_PER_MMOL),
    }))
    .sort((a, b) => a.date - b.date)
}
