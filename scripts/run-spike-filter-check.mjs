import { buildHypoFeatures, calcRate, cleanGlucoseTimeline, MGDL_PER_MMOL } from './lib/hypo-features.mjs'

const MS_PER_MIN = 60_000
const now = Date.UTC(2026, 5, 5, 12, 0, 0)

function entry(minutesAgo, mgdl) {
  return {
    date: now - minutesAgo * MS_PER_MIN,
    dateString: new Date(now - minutesAgo * MS_PER_MIN).toISOString(),
    identifier: `fixture:${minutesAgo}`,
    sgv: mgdl,
    type: 'sgv',
  }
}

const timeline = [
  entry(8, 172),
  entry(7, 172),
  entry(6, 172),
  entry(5, 172),
  entry(4, 172),
  entry(3, 172),
  entry(2, 154),
  entry(1, 172),
  entry(0, 172),
].sort((a, b) => a.date - b.date)

const cleaned = cleanGlucoseTimeline(timeline)
const spikeIndex = cleaned.findIndex((e) => e.rawSgv === 154 && e.spikeFiltered)
if (spikeIndex < 0) {
  throw new Error('Expected the 154 mg/dL single-point dropout to be marked spikeFiltered')
}
if (cleaned[spikeIndex].sgv !== 172) {
  throw new Error(`Expected cleaned spike value 172 mg/dL, got ${cleaned[spikeIndex].sgv}`)
}

const rate1mAtRecovery = calcRate(cleaned, spikeIndex + 1, 1)
if (!Number.isFinite(rate1mAtRecovery) || Math.abs(rate1mAtRecovery) > 0.5) {
  throw new Error(`Expected filtered |rate1m| <= 0.5, got ${rate1mAtRecovery}`)
}

const features = buildHypoFeatures(timeline, timeline.length - 1, { nowMs: now })
if (features.maxFallRate30m < -0.5) {
  throw new Error(`Expected maxFallRate30m not to be dominated by dropout, got ${features.maxFallRate30m}`)
}
if (features.isAcceleratingDown) {
  throw new Error('Expected isAcceleratingDown to stay false for a single-point dropout')
}

console.log(JSON.stringify({
  ok: true,
  cleanedSpikeMmol: Math.round((cleaned[spikeIndex].sgv / MGDL_PER_MMOL) * 1000) / 1000,
  rate1mAtRecovery: Math.round(rate1mAtRecovery * 10000) / 10000,
  maxFallRate30m: features.maxFallRate30m,
  isAcceleratingDown: features.isAcceleratingDown,
}, null, 2))
