// Pure episode-builder voor reactieve-hypo analyse (Mijlpaal 3).
//
// Detecteert post-piek daal-episodes uit een glucose-timeline en labelt de
// uitkomst. Geen database/I-O — een timeline in, episodes uit — zodat de live
// sync, de offline builder én de backtest exact dezelfde episode-logica delen.
//
// Timeline-formaat (oplopend op tijd): { date: <ms>, sgv: <mg/dL> }.

import { MGDL_PER_MMOL, calcRate, round } from './hypo-features.mjs'

const MS_PER_MIN = 60_000
const LOW_THRESHOLD_MMOL = 3.9
const VERY_LOW_THRESHOLD_MMOL = 3.0

export const DEFAULT_EPISODE_OPTIONS = {
  minPeakMmol: 7.5, // piek moet reactieve context hebben
  minDropMmol: 1.0, // piek -> nadir minimaal, anders geen episode
  forwardMinutes: 120, // hoever na de piek we de nadir zoeken
  gapMinutes: 45, // datagat beëindigt de zoektocht
  lookbackMinutes: 60, // venster om de baseline vóór de piek te vinden
  nearMmol: 4.5,
  lowMmol: 4.0,
}

function mmol(entry) {
  return Number(entry.sgv) / MGDL_PER_MMOL
}

function isoOf(entry) {
  return entry.dateString || new Date(entry.date).toISOString()
}

// Lokale piek: hoger dan (of gelijk aan) de directe buren binnen ~10 min.
function isLocalPeak(timeline, i) {
  const here = Number(timeline[i].sgv)
  const from = timeline[i].date - 10 * MS_PER_MIN
  const to = timeline[i].date + 10 * MS_PER_MIN
  for (let j = i - 1; j >= 0 && timeline[j].date >= from; j -= 1) {
    if (Number(timeline[j].sgv) > here) return false
  }
  for (let j = i + 1; j < timeline.length && timeline[j].date <= to; j += 1) {
    if (Number(timeline[j].sgv) > here) return false
  }
  return true
}

function labelOutcome(nadirMmol, opt) {
  if (nadirMmol < opt.lowMmol) return 'hypo'
  if (nadirMmol < opt.nearMmol) return 'near_hypo'
  return 'safe_drop'
}

function minutesBetween(a, b) {
  return (b.date - a.date) / MS_PER_MIN
}

function durationBelow(timeline, fromIdx, toIdx, threshold) {
  let minutes = 0
  for (let j = fromIdx + 1; j <= toIdx; j += 1) {
    const prev = timeline[j - 1]
    const cur = timeline[j]
    const dt = minutesBetween(prev, cur)
    if (dt <= 0) continue
    const prevMmol = mmol(prev)
    const curMmol = mmol(cur)
    if (prevMmol < threshold && curMmol < threshold) {
      minutes += dt
    } else if (prevMmol >= threshold && curMmol < threshold && prevMmol !== curMmol) {
      const fractionBeforeCrossing = (prevMmol - threshold) / (prevMmol - curMmol)
      minutes += dt * (1 - fractionBeforeCrossing)
    } else if (prevMmol < threshold && curMmol >= threshold && prevMmol !== curMmol) {
      const fractionUntilCrossing = (threshold - prevMmol) / (curMmol - prevMmol)
      minutes += dt * fractionUntilCrossing
    }
  }
  return minutes
}

function areaBelow(timeline, fromIdx, toIdx, threshold) {
  let area = 0
  for (let j = fromIdx + 1; j <= toIdx; j += 1) {
    const prev = timeline[j - 1]
    const cur = timeline[j]
    const dt = minutesBetween(prev, cur)
    if (dt <= 0) continue
    const prevDepth = Math.max(0, threshold - mmol(prev))
    const curDepth = Math.max(0, threshold - mmol(cur))
    area += ((prevDepth + curDepth) / 2) * dt
  }
  return area
}

function timeOfDayBucket(dateMs) {
  const hour = new Date(dateMs).getHours()
  if (hour < 6) return 'night'
  if (hour < 12) return 'morning'
  if (hour < 18) return 'afternoon'
  return 'evening'
}

function episodeSeverity(nadirMmol, timeBelow39, areaBelow39, qualityFlags) {
  if (qualityFlags.includes('single_point_low') || qualityFlags.includes('possible_compression_low')) return 'uncertain'
  if (nadirMmol < VERY_LOW_THRESHOLD_MMOL || timeBelow39 >= 30 || areaBelow39 >= 12) return 'severe'
  if (nadirMmol < LOW_THRESHOLD_MMOL || timeBelow39 >= 10 || areaBelow39 >= 4) return 'relevant'
  return 'mild'
}

function episodeShape({ dropFromPeakMmol, minutesPeakToNadir, timeBelow39, reboundHigh, singlePointLow }) {
  if (singlePointLow) return 'isolated_point'
  if (reboundHigh) return 'rebound'
  if (timeBelow39 >= 30) return 'prolonged_low'
  if (minutesPeakToNadir > 0 && dropFromPeakMmol / minutesPeakToNadir >= 0.08) return 'fast_drop'
  return 'slow_drift'
}

// Bouwt alle daal-episodes uit een timeline.
export function buildEpisodes(timeline, options = {}) {
  const opt = { ...DEFAULT_EPISODE_OPTIONS, ...options }
  if (!Array.isArray(timeline) || timeline.length < 4) return []

  const episodes = []
  let i = 0
  while (i < timeline.length) {
    if (mmol(timeline[i]) < opt.minPeakMmol || !isLocalPeak(timeline, i)) {
      i += 1
      continue
    }

    const peak = timeline[i]
    const peakMmol = mmol(peak)
    const horizonEnd = peak.date + opt.forwardMinutes * MS_PER_MIN

    // Zoek de nadir vooruit, respecteer datagaten.
    let nadirIdx = i
    let prevDate = peak.date
    let firstUnder45 = null
    let firstUnder40 = null
    for (let j = i + 1; j < timeline.length; j += 1) {
      if (timeline[j].date > horizonEnd) break
      if (timeline[j].date - prevDate > opt.gapMinutes * MS_PER_MIN) break
      prevDate = timeline[j].date
      const v = mmol(timeline[j])
      if (v < mmol(timeline[nadirIdx])) nadirIdx = j
      if (firstUnder45 === null && v < opt.nearMmol) firstUnder45 = timeline[j]
      if (firstUnder40 === null && v < opt.lowMmol) firstUnder40 = timeline[j]
    }

    const nadir = timeline[nadirIdx]
    const nadirMmol = mmol(nadir)
    const dropFromPeakMmol = peakMmol - nadirMmol

    // Geen echte daling -> geen episode; ga één stap verder.
    if (nadirIdx <= i || dropFromPeakMmol < opt.minDropMmol) {
      i += 1
      continue
    }

    // Baseline vóór de stijging: laagste punt in het lookback-venster.
    const baseFrom = peak.date - opt.lookbackMinutes * MS_PER_MIN
    let startIdx = i
    for (let j = i - 1; j >= 0 && timeline[j].date >= baseFrom; j -= 1) {
      if (mmol(timeline[j]) < mmol(timeline[startIdx])) startIdx = j
    }
    const start = timeline[startIdx]

    // Steilste daling binnen de descent (mmol/min).
    let maxFallRate = 0
    for (let j = i + 1; j <= nadirIdx; j += 1) {
      const dt = (timeline[j].date - timeline[j - 1].date) / MS_PER_MIN
      if (dt <= 0) continue
      const r = (mmol(timeline[j]) - mmol(timeline[j - 1])) / dt
      if (r < maxFallRate) maxFallRate = r
    }

    const minutesPeakToNadir = (nadir.date - peak.date) / MS_PER_MIN
    const outcome = labelOutcome(nadirMmol, opt)
    const recoveryThreshold = LOW_THRESHOLD_MMOL
    let recoveredIdx = null
    let afterNadirPrevDate = nadir.date
    const recoveryHorizonEnd = nadir.date + opt.forwardMinutes * MS_PER_MIN
    for (let j = nadirIdx + 1; j < timeline.length; j += 1) {
      if (timeline[j].date > recoveryHorizonEnd) break
      if (timeline[j].date - afterNadirPrevDate > opt.gapMinutes * MS_PER_MIN) break
      afterNadirPrevDate = timeline[j].date
      if (mmol(timeline[j]) >= recoveryThreshold) {
        recoveredIdx = j
        break
      }
    }

    const analysisEndIdx = recoveredIdx ?? nadirIdx
    const recovered = recoveredIdx !== null ? timeline[recoveredIdx] : null
    const recoveryMinutes = recovered ? (recovered.date - nadir.date) / MS_PER_MIN : null
    const timeBelow39 = durationBelow(timeline, i, analysisEndIdx, LOW_THRESHOLD_MMOL)
    const timeBelow30 = durationBelow(timeline, i, analysisEndIdx, VERY_LOW_THRESHOLD_MMOL)
    const burden39 = areaBelow(timeline, i, analysisEndIdx, LOW_THRESHOLD_MMOL)
    const burden30 = areaBelow(timeline, i, analysisEndIdx, VERY_LOW_THRESHOLD_MMOL)
    const fallRateMmolPerMin = minutesPeakToNadir > 0 ? dropFromPeakMmol / minutesPeakToNadir : 0

    let reboundPeak = null
    if (recoveredIdx !== null) {
      const reboundEnd = timeline[recoveredIdx].date + 60 * MS_PER_MIN
      let prevDate2 = timeline[recoveredIdx].date
      for (let j = recoveredIdx; j < timeline.length; j += 1) {
        if (timeline[j].date > reboundEnd) break
        if (timeline[j].date - prevDate2 > opt.gapMinutes * MS_PER_MIN) break
        prevDate2 = timeline[j].date
        if (!reboundPeak || mmol(timeline[j]) > mmol(reboundPeak)) reboundPeak = timeline[j]
      }
    }
    const reboundPeakMmol = reboundPeak ? mmol(reboundPeak) : null
    const reboundHigh = reboundPeakMmol !== null && reboundPeakMmol >= 10.0

    const qualityFlags = []
    const dataGapLimitMs = opt.gapMinutes * MS_PER_MIN
    if (i > 0 && peak.date - timeline[i - 1].date > dataGapLimitMs) qualityFlags.push('data_gap_before')
    if (nadirIdx > i + 1) {
      for (let j = i + 1; j <= nadirIdx; j += 1) {
        if (timeline[j].date - timeline[j - 1].date > dataGapLimitMs) qualityFlags.push('data_gap_during')
      }
    }
    if (nadirIdx + 1 < timeline.length && timeline[nadirIdx + 1].date - nadir.date > dataGapLimitMs) qualityFlags.push('data_gap_after')
    const singlePointLow = nadirMmol < LOW_THRESHOLD_MMOL && timeBelow39 <= 6
    if (singlePointLow) qualityFlags.push('single_point_low')
    const nightEpisode = new Date(peak.date).getHours() < 6
    if (nightEpisode && singlePointLow && recoveryMinutes !== null && recoveryMinutes <= 20 && !reboundHigh) {
      qualityFlags.push('possible_compression_low')
    }
    if (Math.abs(maxFallRate) >= 0.12 || fallRateMmolPerMin >= 0.08) qualityFlags.push('lag_sensitive')
    const qualityScore = Math.max(0, 100 - qualityFlags.length * 20)
    const severity = episodeSeverity(nadirMmol, timeBelow39, burden39, qualityFlags)
    const shape = episodeShape({ dropFromPeakMmol, minutesPeakToNadir, timeBelow39, reboundHigh, singlePointLow })

    episodes.push({
      version: 3,
      start: isoOf(start),
      end: isoOf(nadir),
      peakAt: isoOf(peak),
      nadirAt: isoOf(nadir),
      recoveredAt: recovered ? isoOf(recovered) : null,
      startMmol: round(mmol(start), 3),
      peakMmol: round(peakMmol, 3),
      nadirMmol: round(nadirMmol, 3),
      endMmol: round(nadirMmol, 3),
      minutesPeakToNadir: round(minutesPeakToNadir, 1),
      recoveryMinutes: recoveryMinutes === null ? null : round(recoveryMinutes, 1),
      minutesPeakToUnder45: firstUnder45 ? round((firstUnder45.date - peak.date) / MS_PER_MIN, 1) : null,
      minutesPeakToUnder40: firstUnder40 ? round((firstUnder40.date - peak.date) / MS_PER_MIN, 1) : null,
      dropFromPeakMmol: round(dropFromPeakMmol, 3),
      peakToNadirDeltaMmol: round(dropFromPeakMmol, 3),
      dropFromPeakPercent: peakMmol > 0 ? round((dropFromPeakMmol / peakMmol) * 100, 1) : 0,
      maxFallRate30m: round(maxFallRate, 4),
      fallRateMmolPerMin: round(fallRateMmolPerMin, 4),
      timeBelow3_9Minutes: round(timeBelow39, 1),
      timeBelow3_0Minutes: round(timeBelow30, 1),
      areaBelow3_9: round(burden39, 3),
      areaBelow3_0: round(burden30, 3),
      reboundHigh,
      reboundPeakMmol: reboundPeakMmol === null ? null : round(reboundPeakMmol, 3),
      reboundMinutesAfterRecovery: reboundPeak && recovered ? round((reboundPeak.date - recovered.date) / MS_PER_MIN, 1) : null,
      nightEpisode,
      timeOfDayBucket: timeOfDayBucket(peak.date),
      severity,
      shape,
      postprandialCandidate: null,
      qualityFlags,
      qualityScore,
      whippleClass: 'uncertain',
      outcome,
      feedback: [],
      featureVector: {
        peakMmol: round(peakMmol, 3),
        dropFromPeakMmol: round(dropFromPeakMmol, 3),
        minutesPeakToNadir: round(minutesPeakToNadir, 1),
        maxFallRate: round(maxFallRate, 4),
        rate10m: calcRate(timeline, nadirIdx, 10),
        rate15m: calcRate(timeline, nadirIdx, 15),
      },
    })

    // Volgende episode pas na deze nadir, zodat ze niet overlappen.
    i = nadirIdx + 1
  }

  return episodes
}

export function outcomeHistogram(episodes) {
  const hist = {}
  for (const e of episodes) hist[e.outcome] = (hist[e.outcome] || 0) + 1
  return hist
}
