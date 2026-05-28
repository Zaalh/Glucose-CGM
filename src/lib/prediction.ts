import type { GlucoseReading, TrendDirection } from '../types'

const PERSONAL_RATES_KEY = 'cgm_personal_trend_rates'
const MIN_READINGS_PER_TREND = 5

const DEFAULT_RATES: Record<TrendDirection, number> = {
  rising_quickly: 0.15,
  rising: 0.08,
  rising_slowly: 0.03,
  flat: 0,
  falling_slowly: -0.03,
  falling: -0.08,
  falling_quickly: -0.15,
}

type PersonalRates = Partial<Record<TrendDirection, number>>

function loadPersonalRates(): PersonalRates {
  try {
    const raw = localStorage.getItem(PERSONAL_RATES_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {}
}

function savePersonalRates(rates: PersonalRates) {
  localStorage.setItem(PERSONAL_RATES_KEY, JSON.stringify(rates))
}

export function computeAndSavePersonalRates(readings: GlucoseReading[]) {
  if (readings.length < 20) return

  const sorted = [...readings].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )

  const buckets: Partial<Record<TrendDirection, number[]>> = {}

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (!a.trend) continue

    const dtMin = (new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()) / 60_000
    if (dtMin < 0.5 || dtMin > 3) continue

    const ratePerMin = (b.value_mmol - a.value_mmol) / dtMin

    if (!buckets[a.trend]) buckets[a.trend] = []
    buckets[a.trend]!.push(ratePerMin)
  }

  const rates: PersonalRates = {}
  for (const [trend, values] of Object.entries(buckets) as [TrendDirection, number[]][]) {
    if (values.length >= MIN_READINGS_PER_TREND) {
      const sorted = [...values].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      rates[trend] = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid]
    }
  }

  savePersonalRates(rates)
}

/**
 * Weighted linear regression over N readings.
 * Recent points get higher weight so the fit tracks the current direction.
 * Much more stable than quadratic on noisy CGM data.
 */
function weightedLinearRegression(readings: GlucoseReading[], minutesAhead: number): number | null {
  if (readings.length < 5) return null

  const sorted = [...readings].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )

  const n = sorted.length
  const t0 = new Date(sorted[0].timestamp).getTime()

  // Exponential weights: most recent point has weight 1, oldest has weight ~0.1
  const decay = 3 / n
  const pts = sorted.map((r, i) => ({
    x: (new Date(r.timestamp).getTime() - t0) / 60_000,
    y: r.value_mmol,
    w: Math.exp(decay * (i - (n - 1))),
  }))

  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0
  for (const { x, y, w } of pts) {
    sw   += w
    swx  += w * x
    swy  += w * y
    swxx += w * x * x
    swxy += w * x * y
  }

  const denom = sw * swxx - swx * swx
  if (Math.abs(denom) < 1e-9) return null

  const slope     = (sw * swxy - swx * swy) / denom
  const intercept = (swy - slope * swx) / sw

  const lastX = pts[n - 1].x + minutesAhead
  return intercept + slope * lastX
}

/**
 * Predict glucose N minutes in the future.
 *
 * Uses weighted linear regression on the last 30 readings (~30 min at 1-min intervals).
 * Exponential weighting makes the fit follow the current trend rather than old data.
 * Falls back to personalized or default trend rates when insufficient data.
 */
export function predictGlucose(
  recentReadings: GlucoseReading[],
  currentReading: GlucoseReading,
  minutesAhead = 20,
): number {
  const window = recentReadings.slice(-30)

  const predicted = weightedLinearRegression(window, minutesAhead)
  if (predicted !== null) {
    return Math.max(1.5, Math.min(33, predicted))
  }

  // Fallback: personalized or default trend rate
  const personal = loadPersonalRates()
  const trend = currentReading.trend
  const rate = trend ? (personal[trend] ?? DEFAULT_RATES[trend] ?? 0) : 0

  return Math.max(1.5, Math.min(33, currentReading.value_mmol + rate * minutesAhead))
}

export function getPredictionConfidence(recentReadings: GlucoseReading[]): 'high' | 'medium' | 'low' {
  const n = recentReadings.length
  if (n >= 30) return 'high'
  if (n >= 5)  return 'medium'
  return 'low'
}

export function getPersonalRatesSummary(): { trend: TrendDirection; rate: number; label: string }[] {
  const rates = loadPersonalRates()
  const labels: Record<TrendDirection, string> = {
    rising_quickly: 'Snel stijgend',
    rising: 'Stijgend',
    rising_slowly: 'Langzaam stijgend',
    flat: 'Stabiel',
    falling_slowly: 'Langzaam dalend',
    falling: 'Dalend',
    falling_quickly: 'Snel dalend',
  }

  return (Object.entries(rates) as [TrendDirection, number][]).map(([trend, rate]) => ({
    trend,
    rate,
    label: labels[trend],
  }))
}
