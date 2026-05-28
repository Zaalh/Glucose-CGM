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
      // Use median for robustness against outliers
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
 * Quadratic (polynomial degree-2) regression over N readings.
 * Much better than linear for curved glucose trends (post-meal, corrections).
 * Returns predicted value minutesAhead from the last reading.
 */
function quadraticRegression(readings: GlucoseReading[], minutesAhead: number): number | null {
  if (readings.length < 5) return null

  const sorted = [...readings].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )

  const t0 = new Date(sorted[0].timestamp).getTime()
  // x in minutes since first point
  const pts = sorted.map(r => ({
    x: (new Date(r.timestamp).getTime() - t0) / 60_000,
    y: r.value_mmol,
  }))

  const n = pts.length
  // Build normal equations for [a, b, c] in y = a*x^2 + b*x + c
  let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0
  let t0v = 0, t1 = 0, t2 = 0
  for (const { x, y } of pts) {
    s1 += x; s2 += x * x; s3 += x * x * x; s4 += x * x * x * x
    t0v += y; t1 += x * y; t2 += x * x * y
  }

  // 3x3 matrix solve (Cramer's rule)
  const A = [
    [s0, s1, s2],
    [s1, s2, s3],
    [s2, s3, s4],
  ]
  const b = [t0v, t1, t2]

  const det = (m: number[][]): number =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])

  const D = det(A)
  if (Math.abs(D) < 1e-9) return null

  const replaceCol = (m: number[][], col: number, v: number[]) =>
    m.map((row, i) => row.map((val, j) => (j === col ? v[i] : val)))

  const c = det(replaceCol(A, 0, b)) / D
  const bCoef = det(replaceCol(A, 1, b)) / D
  const a = det(replaceCol(A, 2, b)) / D

  const lastX = pts[n - 1].x + minutesAhead
  return a * lastX * lastX + bCoef * lastX + c
}

/**
 * Predict glucose N minutes in the future.
 *
 * Uses quadratic regression on the last 20 readings (~20 min of 1-min data).
 * Falls back to personalized or default trend rates when insufficient data.
 */
export function predictGlucose(
  recentReadings: GlucoseReading[],
  currentReading: GlucoseReading,
  minutesAhead = 20,
): number {
  // Use last 20 readings for quadratic fit (~20 min window at 1-min intervals)
  const window = recentReadings.slice(-20)

  const quad = quadraticRegression(window, minutesAhead)
  if (quad !== null) {
    return Math.max(1.5, Math.min(33, quad))
  }

  // Fallback: personalized or default trend rate
  const personal = loadPersonalRates()
  const trend = currentReading.trend
  const rate = trend ? (personal[trend] ?? DEFAULT_RATES[trend] ?? 0) : 0

  return Math.max(1.5, Math.min(33, currentReading.value_mmol + rate * minutesAhead))
}

export function getPredictionConfidence(recentReadings: GlucoseReading[]): 'high' | 'medium' | 'low' {
  const n = recentReadings.length
  if (n >= 20) return 'high'
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
