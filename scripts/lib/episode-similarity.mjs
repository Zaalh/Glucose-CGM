// Gedeelde episode-similarity zodat de live-sync, de backtest en de auto-tuner
// V2 exact hetzelfde `pattern`-object voeren (train/serve-pariteit). Voorheen
// leefde findSimilarEpisodes alleen in libreview-nightscout-sync.mjs, waardoor
// component 6 / patternScore live wél maar in de backtest/tuner niet werd gevoed.

const SIM_SCALES = { peakMmol: 4, dropFromPeakMmol: 3, minutesSincePeak: 30 }
const SIM_MAX_DIST = 1.5
const SIM_K = 8

function sq(x) {
  return x * x
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return value
  const f = 10 ** digits
  return Math.round(value * f) / f
}

// Vergelijkt de huidige situatie met opgeslagen episode_vectors. Geeft een
// gewogen drop-correctie en hoeveel vergelijkbare episodes in (near-)hypo eindigden.
export function findSimilarEpisodes(input, vectors) {
  if (!vectors || !vectors.length) return null
  const scored = []
  for (const v of vectors) {
    const f = v.featureVector
    if (!f || !Number.isFinite(f.peakMmol) || !Number.isFinite(f.dropFromPeakMmol)) continue
    let sum = sq((f.peakMmol - input.peakMmol) / SIM_SCALES.peakMmol)
    sum += sq((f.dropFromPeakMmol - input.dropFromPeakMmol) / SIM_SCALES.dropFromPeakMmol)
    if (Number.isFinite(f.minutesPeakToEnd) && Number.isFinite(input.minutesSincePeak)) {
      sum += sq((f.minutesPeakToEnd - input.minutesSincePeak) / SIM_SCALES.minutesSincePeak)
    }
    const dist = Math.sqrt(sum)
    if (dist <= SIM_MAX_DIST) scored.push({ dist, drop: f.dropFromPeakMmol, outcome: v.outcome })
  }
  if (scored.length < 3) return null

  scored.sort((a, b) => a.dist - b.dist)
  const top = scored.slice(0, SIM_K)
  let wsum = 0
  let wdrop = 0
  let hypoCount = 0
  for (const s of top) {
    const w = 1 / (1 + s.dist)
    wsum += w
    wdrop += w * (Number.isFinite(s.drop) ? s.drop : 0)
    if (s.outcome === 'hypo' || s.outcome === 'near_hypo') hypoCount += 1
  }
  const weightedDrop = wsum > 0 ? wdrop / wsum : 0
  return {
    count: top.length,
    hypoCount,
    hypoRatio: top.length ? hypoCount / top.length : 0,
    correction: Math.max(0, weightedDrop * 0.18),
  }
}

// Bouwt het `pattern`-object dat V2 (component 6 / patternScore) verwacht,
// gedreven door dezelfde featureset die V2 zelf ziet. Zelfde drop-context-gate
// als de live-sync: alleen bij een echte recente post-piek daling vergelijken.
export function patternFromFeatures(features, vectors) {
  if (!features) return null
  const peakMmol = features.peakMmol120m
  const dropFromPeakMmol = features.dropFromPeakMmol
  const minutesSincePeak = features.minutesSincePeak
  const isDropContext = dropFromPeakMmol >= 2 && minutesSincePeak <= 60
  if (!isDropContext) return null
  const similar = findSimilarEpisodes({ peakMmol, dropFromPeakMmol, minutesSincePeak }, vectors)
  if (!similar) return null
  return {
    similarEpisodeCount: similar.count,
    similarHypoCount: similar.hypoCount,
    similarHypoRatio: round(similar.hypoRatio, 3),
  }
}
