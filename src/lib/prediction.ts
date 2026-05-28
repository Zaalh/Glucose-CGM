import type { GlucoseReading, TrendDirection } from '../types'

const PERSONAL_RATES_KEY = 'cgm_personal_trend_rates'
const MIN_READINGS_PER_TREND = 3

// Fixed fallback rates (mmol/L per minute)
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

/**
 * Compute personalized per-trend-direction rates from historical readings.
 * Groups consecutive pairs by the trend of the earlier reading,
 * computes mmol/min rate, averages per direction.
 * Needs at least MIN_READINGS_PER_TREND samples per direction to override default.
 */
export function computeAndSavePersonalRates(readings: GlucoseReading[]) {
  if (readings.length < 10) return

  // Sort ascending
  const sorted = [...readings].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )

  const buckets: Partial<Record<TrendDirection, number[]>> = {}

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (!a.trend) continue

    const dtMin = (new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()) / 60_000
    if (dtMin < 2 || dtMin > 10) continue // skip gaps or duplicates

    const ratePerMin = (b.value_mmol - a.value_mmol) / dtMin

    if (!buckets[a.trend]) buckets[a.trend] = []
    buckets[a.trend]!.push(ratePerMin)
  }

  const rates: PersonalRates = {}
  for (const [trend, values] of Object.entries(buckets) as [TrendDirection, number[]][]) {
    if (values.length >= MIN_READINGS_PER_TREND) {
      rates[trend] = values.reduce((s, v) => s + v, 0) / values.length
    }
  }

  savePersonalRates(rates)
}

/**
 * Linear regression over last N readings (sorted ascending).
 * Returns slope in mmol/L per minute and the predicted value at +minutesAhead.
 */
function linearRegression(readings: GlucoseReading[], minutesAhead: number): number | null {
  if (readings.length < 3) return null

  const sorted = [...readings].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )

  const t0 = new Date(sorted[0].timestamp).getTime()
  const points = sorted.map(r => ({
    x: (new Date(r.timestamp).getTime() - t0) / 60_000, // minutes since first
    y: r.value_mmol,
  }))

  const n = points.length
  const sumX = points.reduce((s, p) => s + p.x, 0)
  const sumY = points.reduce((s, p) => s + p.y, 0)
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0)
  const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0)

  const denom = n * sumX2 - sumX * sumX
  if (Math.abs(denom) < 1e-9) return null

  const slope = (n * sumXY - sumX * sumY) / denom
  const intercept = (sumY - slope * sumX) / n

  const lastX = points[points.length - 1].x
  return intercept + slope * (lastX + minutesAhead)
}

/**
 * Predict glucose value N minutes in the future.
 * Strategy:
 *   1. Linear regression on last 5 readings (primary, most accurate)
 *   2. Personalized trend rate fallback
 *   3. Fixed default rate fallback
 */
export function predictGlucose(
  recentReadings: GlucoseReading[],
  currentReading: GlucoseReading,
  minutesAhead = 20,
): number {
  // Take last 5 readings (including current) for regression
  const window = recentReadings
    .slice(-5)

  const regression = linearRegression(window, minutesAhead)
  if (regression !== null) {
    // Clamp to physiologically plausible range
    return Math.max(1.5, Math.min(33, regression))
  }

  // Fallback: personalized or default trend rate
  const personal = loadPersonalRates()
  const trend = currentReading.trend
  const rate = trend
    ? (personal[trend] ?? DEFAULT_RATES[trend] ?? 0)
    : 0

  return Math.max(1.5, Math.min(33, currentReading.value_mmol + rate * minutesAhead))
}

export function getPredictionConfidence(recentReadings: GlucoseReading[]): 'high' | 'medium' | 'low' {
  const n = recentReadings.length
  if (n >= 5) return 'high'
  if (n >= 3) return 'medium'
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
