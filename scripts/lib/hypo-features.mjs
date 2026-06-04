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
const FALL_RATE_WINDOWS = [5, 10, 15, 20, 30]
const DEFAULT_LAG_MINUTES = 5

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

function postPeakWindow(minutesSincePeak, dropFromPeakMmol) {
  if (dropFromPeakMmol < 0.5) return 'none'
  if (minutesSincePeak <= 15) return 'early'
  if (minutesSincePeak <= 45) return 'middle'
  if (minutesSincePeak <= 90) return 'late'
  return 'none'
}

// Bouwt de volledige featureset voor één meetpunt (timeline[idx]). Gebruikt
// uitsluitend data tot en met idx, zodat live en backtest identiek zijn.
export function buildHypoFeatures(timeline, idx, options = {}) {
  const lagMinutes = Number.isFinite(options.lagMinutes) ? options.lagMinutes : DEFAULT_LAG_MINUTES
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : null
  const latest = timeline[idx]
  const currentMmol = toMmol(latest.sgv)
  const previousMmol = idx > 0 ? toMmol(timeline[idx - 1].sgv) : null

  const rate5m = calcRate(timeline, idx, 5)
  const rate10m = calcRate(timeline, idx, 10)
  const rate15m = calcRate(timeline, idx, 15)
  const rate30m = calcRate(timeline, idx, 30)
  const blendedRate = blendedRateFrom(rate5m, rate10m, rate15m)

  // Steilste daling in de laatste 30 min: meest negatieve window-rate.
  let maxFallRate30m = 0
  for (const w of FALL_RATE_WINDOWS) {
    const r = calcRate(timeline, idx, w)
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

  const peak = findPeak(timeline, idx, PEAK_WINDOW_MINUTES)
  const peakMmol120m = toMmol(peak.sgv)
  const minutesSincePeak = (latest.date - peak.date) / 60_000
  const dropFromPeakMmol = peakMmol120m - currentMmol
  const dropFromPeakPercent = peakMmol120m > 0 ? (dropFromPeakMmol / peakMmol120m) * 100 : 0
  const peakToCurrentSlope = minutesSincePeak > 0 ? dropFromPeakMmol / minutesSincePeak : 0

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
  const delta15m = calcDelta(timeline, idx, 15)
  const trough = findTrough(timeline, idx, MEAL_TROUGH_WINDOW_MINUTES)
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
    currentMmol: round(currentMmol, 3),
    previousMmol: previousMmol === null ? null : round(previousMmol, 3),
    delta5m: round(calcDelta(timeline, idx, 5), 3),
    delta10m: round(calcDelta(timeline, idx, 10), 3),
    delta15m: round(delta15m, 3),
    ageSeconds: nowMs === null ? null : Math.max(0, Math.round((nowMs - latest.date) / 1000)),
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
    postPeakWindow: postPeakWindow(minutesSincePeak, dropFromPeakMmol),
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
