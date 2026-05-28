export interface GlucoseReading {
  id: string
  timestamp: string
  value_mmol: number
  trend: TrendDirection | null
  source: string
  created_at: string
}

export type TrendDirection =
  | 'rising_quickly'
  | 'rising'
  | 'rising_slowly'
  | 'flat'
  | 'falling_slowly'
  | 'falling'
  | 'falling_quickly'

export interface AlertRule {
  id: string
  name: string
  threshold_low: number | null
  threshold_high: number | null
  enabled: boolean
  created_at: string
}

export type GlucoseStatus = 'low' | 'normal' | 'high' | 'very_low' | 'very_high'

export function getGlucoseStatus(value: number): GlucoseStatus {
  if (value < 3.0) return 'very_low'
  if (value < 3.9) return 'low'
  if (value > 13.9) return 'very_high'
  if (value > 10.0) return 'high'
  return 'normal'
}

export function trendArrow(trend: TrendDirection | null): string {
  switch (trend) {
    case 'rising_quickly': return '↑↑'
    case 'rising': return '↑'
    case 'rising_slowly': return '↗'
    case 'flat': return '→'
    case 'falling_slowly': return '↘'
    case 'falling': return '↓'
    case 'falling_quickly': return '↓↓'
    default: return '–'
  }
}
