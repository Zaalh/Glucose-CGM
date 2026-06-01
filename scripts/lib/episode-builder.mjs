// Pure episode-builder voor reactieve-hypo analyse (Mijlpaal 3).
//
// Detecteert post-piek daal-episodes uit een glucose-timeline en labelt de
// uitkomst. Geen database/I-O — een timeline in, episodes uit — zodat de live
// sync, de offline builder én de backtest exact dezelfde episode-logica delen.
//
// Timeline-formaat (oplopend op tijd): { date: <ms>, sgv: <mg/dL> }.

import { MGDL_PER_MMOL, calcRate, round } from './hypo-features.mjs'

const MS_PER_MIN = 60_000

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

    episodes.push({
      version: 2,
      start: isoOf(start),
      end: isoOf(nadir),
      peakAt: isoOf(peak),
      nadirAt: isoOf(nadir),
      startMmol: round(mmol(start), 3),
      peakMmol: round(peakMmol, 3),
      nadirMmol: round(nadirMmol, 3),
      endMmol: round(nadirMmol, 3),
      minutesPeakToNadir: round(minutesPeakToNadir, 1),
      minutesPeakToUnder45: firstUnder45 ? round((firstUnder45.date - peak.date) / MS_PER_MIN, 1) : null,
      minutesPeakToUnder40: firstUnder40 ? round((firstUnder40.date - peak.date) / MS_PER_MIN, 1) : null,
      dropFromPeakMmol: round(dropFromPeakMmol, 3),
      dropFromPeakPercent: peakMmol > 0 ? round((dropFromPeakMmol / peakMmol) * 100, 1) : 0,
      maxFallRate30m: round(maxFallRate, 4),
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
