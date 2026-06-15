import assert from 'node:assert/strict'
import { mealPatternFromState } from './lib/episode-similarity.mjs'

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0)

function vector(index, featureVector, outcome = 'stable') {
  return {
    peakDate: new Date(NOW - (index + 1) * 3_600_000).toISOString(),
    outcome,
    featureVector,
  }
}

const riskyDropVectors = [
  vector(0, { peakMmol: 8.9, dropFromPeakMmol: 2.4, minutesPeakToEnd: 25, riseRate15m: 0.12, riseFromBaseline: 2.1 }, 'hypo'),
  vector(1, { peakMmol: 9.1, dropFromPeakMmol: 2.2, minutesPeakToEnd: 22, riseRate15m: 0.11, riseFromBaseline: 2.0 }, 'near_hypo'),
  vector(2, { peakMmol: 8.7, dropFromPeakMmol: 2.5, minutesPeakToEnd: 28, riseRate15m: 0.13, riseFromBaseline: 2.3 }, 'hypo'),
  vector(3, { peakMmol: 8.8, dropFromPeakMmol: 2.1, minutesPeakToEnd: 26, riseRate15m: 0.10, riseFromBaseline: 2.0 }, 'stable'),
]

const dropMeal = {
  phase: 'reactive-drop',
  peakMmol: 8.9,
  dropFromPeak: 2.3,
  minutesSincePeak: 24,
}

const dropPattern = mealPatternFromState(dropMeal, riskyDropVectors, { currentMs: NOW })
assert.equal(dropPattern.patternKind, 'post-peak-drop')
assert.equal(dropPattern.similarEpisodeCount, 4)
assert.equal(dropPattern.similarHypoCount, 3)
assert.equal(dropPattern.patternRisk, 'high')

const riskyRiseVectors = [
  vector(0, { peakMmol: 8.9, dropFromPeakMmol: 2.0, minutesPeakToEnd: 40, riseRate15m: 0.10, riseFromBaseline: 1.7 }, 'near_hypo'),
  vector(1, { peakMmol: 9.0, dropFromPeakMmol: 2.4, minutesPeakToEnd: 38, riseRate15m: 0.11, riseFromBaseline: 1.8 }, 'hypo'),
  vector(2, { peakMmol: 8.6, dropFromPeakMmol: 1.9, minutesPeakToEnd: 45, riseRate15m: 0.09, riseFromBaseline: 1.6 }, 'near_hypo'),
  vector(3, { peakMmol: 8.8, dropFromPeakMmol: 2.2, minutesPeakToEnd: 42, riseRate15m: 0.10, riseFromBaseline: 1.7 }, 'stable'),
]

const risingMeal = {
  phase: 'rising',
  effRate: 0.10,
  riseFromTrough: 1.7,
}

const risePattern = mealPatternFromState(risingMeal, riskyRiseVectors, { currentMs: NOW })
assert.equal(risePattern.patternKind, 'rise-onset')
assert.equal(risePattern.similarEpisodeCount, 4)
assert.equal(risePattern.similarHypoCount, 3)
assert.equal(risePattern.patternRisk, 'watch')

const tooFew = mealPatternFromState(risingMeal, riskyRiseVectors.slice(0, 3), { currentMs: NOW })
assert.equal(tooFew, null)

const noPhaseDecision = mealPatternFromState({ phase: 'dip', effRate: 0.1, riseFromTrough: 1.5 }, riskyRiseVectors, { currentMs: NOW })
assert.equal(noPhaseDecision, null)

console.log('MEAL VECTOR CHECK OK')
