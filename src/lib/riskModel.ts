import modelState from './risk-model-state.json'

export type RiskLevel = 'low' | 'watch' | 'high' | 'urgent'

export type RiskInput = {
  currentMmol: number
  rate5m?: number | null
  rate10m?: number | null
  rate15m?: number | null
  peakMmol?: number | null
  minutesSincePeak?: number | null
  dropFromPeakMmol?: number | null
  dropFromPeakPercent?: number | null
}

export type RiskResult = {
  score: number
  risk: RiskLevel
  reasons: string[]
}

export function evaluateRisk(input: RiskInput): RiskResult {
  let score = 0
  const reasons: string[] = []

  if ((input.peakMmol ?? 0) >= 10 && (input.minutesSincePeak ?? 999) <= 30) {
    score += 3
    reasons.push('Recente piek boven 10.0 mmol/L')
  }

  if ((input.dropFromPeakMmol ?? 0) >= 3) {
    score += 3
    reasons.push('Grote daling vanaf recente piek (>= 3.0 mmol/L)')
  } else if ((input.dropFromPeakMmol ?? 0) >= 2) {
    score += 2
    reasons.push('Snelle daling vanaf recente piek (>= 2.0 mmol/L)')
  }

  if ((input.dropFromPeakPercent ?? 0) >= 30) {
    score += 3
    reasons.push('Relatieve piekdaling >= 30%')
  } else if ((input.dropFromPeakPercent ?? 0) >= 25) {
    score += 2
    reasons.push('Relatieve piekdaling >= 25%')
  }

  if ((input.rate5m ?? 0) <= -0.08 || (input.rate10m ?? 0) <= -0.08) {
    score += 3
    reasons.push('Zeer snelle negatieve rate')
  }

  if ((input.rate15m ?? 0) <= -0.04) {
    score += 2
    reasons.push('Aanhoudende daling over 15 min')
  }

  if (input.currentMmol < 4.0) {
    score += 100
    reasons.push('Actuele waarde onder 4.0 mmol/L')
  } else if (input.currentMmol < 4.5) {
    score += 4
    reasons.push('Actuele waarde onder 4.5 mmol/L')
  } else if (input.currentMmol < 6.0 && ((input.rate5m ?? 0) < 0 || (input.rate10m ?? 0) < 0)) {
    score += 2
    reasons.push('Waarde onder 6.0 en nog dalend')
  }

  const watchMin = modelState?.thresholds?.watchScoreMin ?? 3
  const highMin = modelState?.thresholds?.highScoreMin ?? 5
  const urgentMin = modelState?.thresholds?.urgentScoreMin ?? 7
  const risk: RiskLevel = score >= urgentMin ? 'urgent' : score >= highMin ? 'high' : score >= watchMin ? 'watch' : 'low'
  return { score, risk, reasons }
}
