import assert from 'node:assert/strict'
import { assessTimelineQuality, buildHypoFeatures, MGDL_PER_MMOL } from './lib/hypo-features.mjs'
import { evaluateReactiveHypoRiskV2 } from './lib/reactive-hypo-detector.mjs'

const now = Date.parse('2026-06-05T12:00:00.000Z')

function entry(minutesAgo, mmol, extra = {}) {
  return {
    date: now - minutesAgo * 60_000,
    sgv: Math.round(mmol * MGDL_PER_MMOL),
    ...extra,
  }
}

const cleanTimeline = [5, 4, 3, 2, 1, 0].map((m, i) => entry(m, 6 - i * 0.1))
const cleanQuality = assessTimelineQuality(cleanTimeline, cleanTimeline.length - 1, { nowMs: now })
assert.equal(cleanQuality.level, 'good')
assert.equal(cleanQuality.flags.largeGap, false)
assert.equal(cleanQuality.flags.duplicateTimestamp, false)

const dexcomTimeline = [30, 25, 20, 15, 10, 5, 0].map((m, i) => entry(m, 6 - i * 0.1))
const dexcomQuality = assessTimelineQuality(dexcomTimeline, dexcomTimeline.length - 1, { nowMs: now })
assert.equal(dexcomQuality.level, 'good')
assert.equal(dexcomQuality.flags.largeGap, false)
assert.equal(dexcomQuality.medianIntervalSeconds, 300)
assert.equal(dexcomQuality.expectedIntervalSeconds, 300)

const missedDexcomTimeline = [30, 20, 10, 0].map((m, i) => entry(m, 6 - i * 0.1))
const missedDexcomQuality = assessTimelineQuality(missedDexcomTimeline, missedDexcomTimeline.length - 1, { nowMs: now })
assert.equal(missedDexcomQuality.flags.largeGap, true)
assert.equal(missedDexcomQuality.level, 'watch')
assert.equal(missedDexcomQuality.medianIntervalSeconds, 600)
assert.equal(missedDexcomQuality.expectedIntervalSeconds, 360)

const gappedTimeline = [20, 19, 18, 17, 16, 0].map((m, i) => entry(m, 6 - i * 0.1))
const gappedQuality = assessTimelineQuality(gappedTimeline, gappedTimeline.length - 1, { nowMs: now })
assert.equal(gappedQuality.level, 'watch')
assert.equal(gappedQuality.flags.largeGap, true)

const duplicateTimeline = [
  entry(4, 6.0),
  entry(3, 5.8),
  entry(3, 5.7),
  entry(2, 5.6),
  entry(1, 5.5),
  entry(0, 5.4),
]
const duplicateQuality = assessTimelineQuality(duplicateTimeline, duplicateTimeline.length - 1, { nowMs: now })
assert.equal(duplicateQuality.flags.duplicateTimestamp, true)
assert.equal(duplicateQuality.flags.outOfOrder, true)
assert.equal(duplicateQuality.level, 'degraded')

const staleQuality = assessTimelineQuality(cleanTimeline, cleanTimeline.length - 1, { nowMs: now + 11 * 60_000 })
assert.equal(staleQuality.flags.stale, true)
assert.equal(staleQuality.level, 'degraded')

const features = buildHypoFeatures(gappedTimeline, gappedTimeline.length - 1, { nowMs: now })
assert.equal(features.dataQuality.level, 'watch')
const v2 = evaluateReactiveHypoRiskV2({
  ...features,
  currentMmol: 5.2,
  rate5m: -0.07,
  rate10m: -0.07,
  rate15m: -0.05,
  blendedRate: -0.065,
  dropFromPeakMmol: 2.4,
  dropFromPeakPercent: 32,
  peakMmol120m: 7.6,
  minutesSincePeak: 35,
  minutesTo45: 10,
  minutesTo40: null,
})
assert.ok(v2.confidence < 0.8)
assert.ok(v2.uncertainty > 0)

console.log(JSON.stringify({
  ok: true,
  clean: cleanQuality,
  dexcom: dexcomQuality,
  missedDexcom: missedDexcomQuality,
  gapped: gappedQuality,
  duplicate: duplicateQuality,
  stale: staleQuality,
  v2: {
    risk: v2.risk,
    confidence: v2.confidence,
    uncertainty: v2.uncertainty,
  },
}, null, 2))
