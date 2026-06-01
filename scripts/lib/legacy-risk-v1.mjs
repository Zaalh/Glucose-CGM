// Getrouwe port van evaluateRiskRuleV1 uit libreview-nightscout-sync.mjs.
//
// Bestaat los zodat de backtest V1 kan draaien zónder de live sync te importeren
// (die voert bij import meteen een sync uit). LET OP: dit moet één-op-één gelijk
// blijven aan de V1-functie in de sync; wijzig ze samen. Gebruikt dezelfde
// blend-gewichten als de featurebuilder (0.5/0.33/0.17).

import { blendedRateFrom, round } from './hypo-features.mjs'

// Spiegelt evaluateRiskRuleV1(input) — input: currentMmol, rate5m/10m/15m,
// peakMmol, minutesSincePeak, dropFromPeakMmol, dropFromPeakPercent.
export function evaluateRiskRuleV1(input) {
  let score = 0
  const reasons = []
  const currentMmol = input.currentMmol ?? 99
  const peakMmol = input.peakMmol ?? 0
  const minutesSincePeak = input.minutesSincePeak ?? 999
  const dropFromPeakMmol = input.dropFromPeakMmol ?? 0
  const dropFromPeakPercent = input.dropFromPeakPercent ?? 0
  const rate5m = Number.isFinite(input.rate5m) ? input.rate5m : null
  const rate10m = Number.isFinite(input.rate10m) ? input.rate10m : null
  const rate15m = Number.isFinite(input.rate15m) ? input.rate15m : null
  const blendedRate = blendedRateFrom(rate5m, rate10m, rate15m)
  const minutesTo40 = blendedRate < -0.01 ? (currentMmol - 4.0) / Math.abs(blendedRate) : null
  const minutesTo45 = blendedRate < -0.01 ? (currentMmol - 4.5) / Math.abs(blendedRate) : null
  const isRealDropContext = dropFromPeakMmol >= 1.5 && minutesSincePeak <= 90 && blendedRate < -0.015
  const isFastReactiveContext = dropFromPeakMmol >= 2 && minutesSincePeak <= 45 && (rate10m ?? 0) <= -0.04

  if (peakMmol >= 10 && minutesSincePeak <= 30) {
    score += 3
    reasons.push('Recente piek boven 10.0 mmol/L')
  } else if (peakMmol >= 8.5 && minutesSincePeak <= 45 && isFastReactiveContext) {
    score += 2
    reasons.push('Matige piek met snelle post-piek daling')
  }
  if (dropFromPeakMmol >= 3) {
    score += 3
    reasons.push('Grote daling vanaf piek')
  } else if (dropFromPeakMmol >= 2) {
    score += 2
    reasons.push('Snelle daling vanaf piek')
  }
  if (dropFromPeakPercent >= 30) {
    score += 3
    reasons.push('Relatieve piekdaling >= 30%')
  } else if (dropFromPeakPercent >= 25) {
    score += 2
    reasons.push('Relatieve piekdaling >= 25%')
  }
  if ((rate5m ?? 0) <= -0.08 || (rate10m ?? 0) <= -0.08) {
    score += 3
    reasons.push('Zeer snelle negatieve rate')
  }
  if ((rate15m ?? 0) <= -0.04) {
    score += 2
    reasons.push('Aanhoudende daling over 15 min')
  }
  if (minutesTo45 !== null && minutesTo45 >= 0 && minutesTo45 <= 20) {
    score += 2
    reasons.push('Voorspeld onder 4.5 binnen 20 min')
  }
  if (minutesTo40 !== null && minutesTo40 >= 0 && minutesTo40 <= 20) {
    score += 3
    reasons.push('Voorspeld onder 4.0 binnen 20 min')
  }
  if (currentMmol < 4.0) {
    score += 100
    reasons.push('Actuele waarde onder 4.0 mmol/L')
  } else if (currentMmol < 4.5) {
    score += 4
    reasons.push('Actuele waarde onder 4.5 mmol/L')
  }

  let risk = score >= 7 ? 'urgent' : score >= 5 ? 'high' : score >= 3 ? 'watch' : 'low'
  if (
    risk === 'urgent' &&
    currentMmol >= 4.8 &&
    !(minutesTo40 !== null && minutesTo40 >= 0 && minutesTo40 <= 15) &&
    !isFastReactiveContext
  ) {
    risk = 'high'
    reasons.push('Urgent gedempt: waarde nog boven 4.8 zonder snelle 4.0-projectie')
  }
  if (risk === 'high' && currentMmol >= 6.5 && !isRealDropContext) {
    risk = 'watch'
    reasons.push('High gedempt: nog hoog zonder duidelijke post-piek dropcontext')
  }
  return {
    score,
    risk,
    reasons,
    details: {
      blendedRate: round(blendedRate, 4),
      minutesTo40: minutesTo40 === null ? null : round(minutesTo40, 1),
      minutesTo45: minutesTo45 === null ? null : round(minutesTo45, 1),
      isRealDropContext,
      isFastReactiveContext,
    },
  }
}
