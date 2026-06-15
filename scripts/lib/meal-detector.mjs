export const MGDL_PER_MMOL = 18.0182
export const MAX_BASELINE_DIFF_MS = 75_000
export const MEAL_TROUGH_WINDOW_MS = 60 * 60_000

export const MEAL_DEFAULTS = {
  fastRate: 0.13,
  slowRate: 0.07,
  preDipMmol: 0.40,
  dipToNadirMin: 60,
  dropWatchRate: 0.07,
  dropHighRate: 0.12,
  dropUrgentRate: 0.18,
  typicalRiseMmol: 1.4,
  typicalDropMmol: 1.4,
  typicalUndershootMmol: 0.2,
  // Universele klinische niveau-drempels (mmol/L) voor de escalatie van een
  // reactieve daling. Level-1 hypo-alert = 3.9, klinisch significant = 3.0.
  // Configureerbaar zodat het systeem voor iedereen bruikbaar is; de grootte
  // van de val zelf komt uit de per-persoon zelf-kalibratie (typicalDrop/...).
  watchMmol: 4.5,
  alertMmol: 3.9,
  seriousMmol: 3.0,
  samples: 0,
}

export function mmol(valueMgdl) {
  return Number(valueMgdl) / MGDL_PER_MMOL
}

export function mgdlFromMmol(valueMmol) {
  return Math.round(Number(valueMmol) * MGDL_PER_MMOL)
}

export function readingTime(entry) {
  return Number(entry?.date || entry?.mills || Date.parse(entry?.dateString))
}

export function findBaseline(readings, latestTime, minutesBack) {
  const target = latestTime - minutesBack * 60_000
  let best = null
  let bestDiff = Infinity

  readings.forEach((entry) => {
    const time = readingTime(entry)
    if (!Number.isFinite(time) || time >= latestTime) return

    const diff = Math.abs(time - target)
    if (diff < bestDiff) {
      best = entry
      bestDiff = diff
    }
  })

  return bestDiff <= MAX_BASELINE_DIFF_MS ? best : null
}

export function updateMealEpisodeMemory(readings, detectedMeal, cal, latestTime, currentMmol, options = {}) {
  const loadMealEpisode = options.loadMealEpisode || (() => options.episode || null)
  const saveMealEpisode = options.saveMealEpisode || ((episode) => { options.episode = episode })
  const clearMealEpisode = options.clearMealEpisode || (() => { options.episode = null })
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now()
  let existing = loadMealEpisode()

  if (existing && Number.isFinite(existing.baselineMmol) && currentMmol <= existing.baselineMmol + 0.3) {
    clearMealEpisode()
    existing = null
  }

  if (detectedMeal && detectedMeal.phase === 'rising') {
    const episode = existing || {
      schemaVersion: 1,
      phase: 'rising',
      startedAt: latestTime,
      troughTime: latestTime - (detectedMeal.minutesSinceMeal || 0) * 60_000,
      troughMmol: currentMmol - (detectedMeal.riseFromTrough || 0),
      baselineMmol: currentMmol - (detectedMeal.riseFromTrough || 0),
    }
    episode.phase = detectedMeal.speed === 'snel' ? 'rising' : (detectedMeal.riseFromTrough >= cal.typicalRiseMmol ? 'rising' : episode.phase)
    episode.lastUpdatedAt = latestTime
    episode.peakMmol = Math.max(Number(episode.peakMmol) || currentMmol, currentMmol)
    if (episode.peakMmol <= currentMmol) episode.peakTime = latestTime
    episode.troughTime = episode.troughTime || (latestTime - (detectedMeal.minutesSinceMeal || 0) * 60_000)
    episode.troughMmol = Number.isFinite(episode.troughMmol) ? Math.min(episode.troughMmol, currentMmol - (detectedMeal.riseFromTrough || 0)) : currentMmol
    episode.baselineMmol = Number.isFinite(episode.baselineMmol) ? episode.baselineMmol : episode.troughMmol
    episode.expiresAt = latestTime + 180 * 60_000
    saveMealEpisode(episode)
    return episode
  }

  if (!existing) return null
  existing.lastUpdatedAt = latestTime
  if (currentMmol > existing.peakMmol) {
    existing.peakMmol = currentMmol
    existing.peakTime = latestTime
    existing.phase = 'rising'
    existing.expiresAt = latestTime + 180 * 60_000
    saveMealEpisode(existing)
    return existing
  }

  const minutesSincePeak = (latestTime - existing.peakTime) / 60_000
  const dropFromPeak = existing.peakMmol - currentMmol
  let rate10 = null
  const prev10 = findBaseline(readings, latestTime, 10)
  if (prev10) {
    const dt = (latestTime - readingTime(prev10)) / 60_000
    if (dt > 0) rate10 = (currentMmol - mmol(Number(prev10.sgv))) / dt
  }
  if (minutesSincePeak >= 10 && dropFromPeak < 0.7 && Math.abs(rate10 || 0) <= 0.03) existing.phase = 'plateau'
  if (dropFromPeak >= 0.7 && (rate10 === null || rate10 < -0.02)) existing.phase = 'reactive-drop'
  if (nowMs > existing.expiresAt) {
    clearMealEpisode()
    return null
  }
  saveMealEpisode(existing)
  return existing
}

export function mealFromEpisodeMemory(episode, cal, latestTime, currentMmol) {
  if (!episode || !Number.isFinite(episode.peakTime) || !Number.isFinite(episode.peakMmol)) return null
  const minutesSincePeak = (latestTime - episode.peakTime) / 60_000
  if (!Number.isFinite(minutesSincePeak) || minutesSincePeak < 0 || minutesSincePeak > 180) return null
  const dropFromPeak = episode.peakMmol - currentMmol
  const dropRate = minutesSincePeak > 0 ? dropFromPeak / minutesSincePeak : 0
  if (episode.phase === 'reactive-drop' && dropFromPeak >= 0.7 && dropRate >= cal.dropWatchRate) {
    return {
      phase: 'reactive-drop',
      speed: dropRate >= cal.dropUrgentRate ? 'urgent' : (dropRate >= cal.dropHighRate ? 'hoog' : 'let op'),
      minutesSincePeak: Math.round(minutesSincePeak),
      dropRate,
      dropFromPeak,
      peakMmol: episode.peakMmol,
      currentMmol,
      expectedDipAt: episode.peakTime + cal.dipToNadirMin * 60_000,
      fromMemory: true,
    }
  }
  if ((episode.phase === 'plateau' || episode.phase === 'rising') && dropFromPeak < 0.7 && currentMmol > (episode.baselineMmol || 0) + 0.6) {
    return {
      phase: 'plateau',
      speed: 'plateau',
      minutesSincePeak: Math.round(minutesSincePeak),
      peakMmol: episode.peakMmol,
      currentMmol,
      expectedDipAt: episode.peakTime + cal.dipToNadirMin * 60_000,
    }
  }
  return null
}

export function detectMealState(readings, options = {}) {
  if (!readings || readings.length < 2) return null
  const cal = options.calibration || MEAL_DEFAULTS
  const latest = readings[0]
  const latestTime = readingTime(latest)
  const currentMmol = mmol(Number(latest.sgv))
  if (!Number.isFinite(latestTime) || !Number.isFinite(currentMmol)) return null

  function finalizeMealState(meal) {
    const episode = updateMealEpisodeMemory(readings, meal, cal, latestTime, currentMmol, options)
    return meal || mealFromEpisodeMemory(episode, cal, latestTime, currentMmol)
  }

  const prev10 = findBaseline(readings, latestTime, 10)
  let rate10 = null
  if (prev10) {
    const dt = (latestTime - readingTime(prev10)) / 60_000
    if (dt > 0) rate10 = (currentMmol - mmol(Number(prev10.sgv))) / dt
  }

  const recent = readings.filter((entry) => {
    const time = readingTime(entry)
    const value = mmol(Number(entry.sgv))
    return Number.isFinite(time) && Number.isFinite(value) && time <= latestTime && time >= latestTime - 150 * 60_000
  })
  if (recent.length >= 4) {
    const peak = recent.reduce((best, entry) => (Number(entry.sgv) > Number(best.sgv) ? entry : best), recent[0])
    const peakTime = readingTime(peak)
    const peakMmol = mmol(Number(peak.sgv))
    const minutesSincePeak = (latestTime - peakTime) / 60_000
    if (Number.isFinite(peakTime) && Number.isFinite(peakMmol) && minutesSincePeak >= 5 && minutesSincePeak <= cal.dipToNadirMin + 45) {
      const beforePeak = recent.filter((entry) => {
        const time = readingTime(entry)
        return Number.isFinite(time) && time < peakTime && time >= peakTime - 90 * 60_000
      })
      if (beforePeak.length >= 2) {
        const priorTrough = beforePeak.reduce((lowest, entry) => (Number(entry.sgv) < Number(lowest.sgv) ? entry : lowest), beforePeak[0])
        const priorTroughMmol = mmol(Number(priorTrough.sgv))
        const riseIntoPeak = peakMmol - priorTroughMmol
        const dropFromPeak = peakMmol - currentMmol
        const dropRate = minutesSincePeak > 0 ? dropFromPeak / minutesSincePeak : 0
        const activelyFalling = rate10 === null || rate10 < -0.02
        if (activelyFalling && riseIntoPeak >= 0.6 && dropFromPeak >= 0.7 && dropRate >= cal.dropWatchRate) {
          const dropSpeed = dropRate >= cal.dropUrgentRate ? 'urgent' : (dropRate >= cal.dropHighRate ? 'hoog' : 'let op')
          return finalizeMealState({
            phase: 'reactive-drop',
            speed: dropSpeed,
            minutesSincePeak: Math.round(minutesSincePeak),
            dropRate,
            dropFromPeak,
            peakMmol,
            currentMmol,
            expectedDipAt: peakTime + cal.dipToNadirMin * 60_000,
          })
        }
      }
    }
  }

  let trough = null
  let troughMmol = Infinity
  for (let i = 0; i < readings.length; i += 1) {
    const t = readingTime(readings[i])
    if (!Number.isFinite(t) || t > latestTime || t < latestTime - MEAL_TROUGH_WINDOW_MS) continue
    const v = mmol(Number(readings[i].sgv))
    if (Number.isFinite(v) && v < troughMmol) {
      troughMmol = v
      trough = readings[i]
    }
  }
  if (!trough) return null
  const ageMin = (latestTime - readingTime(trough)) / 60_000
  const riseFromTrough = currentMmol - troughMmol
  const afterTrough = readings.filter((entry) => {
    const time = readingTime(entry)
    return Number.isFinite(time) && time > readingTime(trough) && time <= latestTime
  })
  const sustainedRisePoints = afterTrough.filter((entry) => mmol(Number(entry.sgv)) >= troughMmol + 0.45).length
  const sustainedRise = sustainedRisePoints >= 2

  const rising = rate10 !== null ? rate10 > 0 : riseFromTrough >= 0.8
  if (rising && riseFromTrough > 0) {
    const fastGate = rate10 !== null && rate10 >= cal.slowRate && riseFromTrough >= 0.5 && ageMin >= 5 && sustainedRise
    const medium = riseFromTrough >= 0.6 && ageMin >= 10 && sustainedRise && (rate10 === null || rate10 >= 0.04 || riseFromTrough >= 1.2)
    const slow = riseFromTrough >= 0.9 && ageMin >= 25 && sustainedRise
    if (fastGate || medium || slow) {
      const avgRate = ageMin > 0 ? riseFromTrough / ageMin : 0
      const effRate = Math.max(rate10 || 0, avgRate)
      const speed = effRate >= cal.fastRate ? 'snel' : (effRate < cal.slowRate ? 'langzaam' : 'normaal')
      return finalizeMealState({
        phase: 'rising',
        speed,
        minutesSinceMeal: Math.round(ageMin),
        expectedDipAt: latestTime + cal.dipToNadirMin * 60_000,
        riseFromTrough,
        effRate,
        sustainedRisePoints,
        currentMmol,
      })
    }
  }

  let preSum = 0
  let preN = 0
  for (let p = 0; p < readings.length; p += 1) {
    const pt = readingTime(readings[p])
    const dtp = (latestTime - pt) / 60_000
    const ddt = (readingTime(trough) - pt) / 60_000
    if (ddt >= 20 && ddt <= 35) {
      preSum += mmol(Number(readings[p].sgv))
      preN += 1
    }
    if (dtp > 50) break
  }
  if (preN > 0) {
    const preDip = (preSum / preN) - troughMmol
    const bottoming = rate10 === null || (rate10 >= -0.02 && rate10 <= 0.05)
    if (preDip >= cal.preDipMmol && ageMin <= 15 && riseFromTrough < 0.5 && bottoming) {
      return finalizeMealState({ phase: 'dip', preDipMmol: preDip, currentMmol })
    }
  }
  return finalizeMealState(null)
}

// Verwachte bodem (mmol/L) van een lopende reactieve daling/plateau: het
// huidige niveau minus de resterende verwachte val. De totale val van piek tot
// bodem (incl. undershoot) komt uit de zelf-gekalibreerde typische waarden, dus
// de schatting personaliseert vanzelf. Geeft null als er te weinig info is.
export function projectReactiveNadir(meal, cal) {
  if (!meal || !Number.isFinite(meal.currentMmol)) return null
  const expectedFall = (Number(cal.typicalDropMmol) || 0) + (Number(cal.typicalUndershootMmol) || 0)
  const alreadyFell = Number.isFinite(meal.dropFromPeak)
    ? meal.dropFromPeak
    : (Number.isFinite(meal.peakMmol) ? meal.peakMmol - meal.currentMmol : 0)
  const remainingFall = Math.max(0, expectedFall - alreadyFell)
  return meal.currentMmol - remainingFall
}

export function classifyMealRisk(score) {
  if (score >= 80) return 'urgent'
  if (score >= 60) return 'high'
  if (score >= 35) return 'watch'
  return 'low'
}

// Escalatieniveau van het maaltijd-vak. Voor een reactieve daling stuurt dit op
// de VERWACHTE BODEM t.o.v. universele klinische drempels (niet op de kale
// daalsnelheid): een daling 11->9 die ruim boven 3.9 bodemt blijft 'low', een
// daling die richting <3.9 of <3.0 projecteert wordt high/urgent. Een snelle
// val geeft een kleine extra (adrenerge symptomen kunnen ook boven 3.9 optreden).
export function scoreReactiveMealRisk(meal, cal, hypoRisk, peakSignal) {
  if (!meal) return null
  let score = 0

  if (meal.phase === 'dip') {
    score += 18
    if (Number.isFinite(meal.preDipMmol) && meal.preDipMmol >= cal.preDipMmol * 1.5) score += 12
  } else if (meal.phase === 'plateau') {
    score += 22
    if (Number.isFinite(meal.peakMmol) && Number.isFinite(meal.currentMmol) && meal.peakMmol - meal.currentMmol < 0.4) score += 6
  } else if (meal.phase === 'rising') {
    score += 25
    if (meal.speed === 'snel') score += 18
    else if (meal.speed === 'normaal') score += 10
    if (Number.isFinite(meal.riseFromTrough) && meal.riseFromTrough >= cal.typicalRiseMmol) score += 12
    if (Number.isFinite(meal.effRate) && meal.effRate >= cal.fastRate) score += 12
  } else if (meal.phase === 'reactive-drop') {
    score += 10
    const nadir = projectReactiveNadir(meal, cal)
    const serious = Number.isFinite(cal.seriousMmol) ? cal.seriousMmol : 3.0
    const alert = Number.isFinite(cal.alertMmol) ? cal.alertMmol : 3.9
    const watch = Number.isFinite(cal.watchMmol) ? cal.watchMmol : 4.5
    if (Number.isFinite(nadir)) {
      if (nadir < serious) score += 70
      else if (nadir < alert) score += 50
      else if (nadir < watch) score += 25
    }
    if (Number.isFinite(meal.dropRate)) {
      if (meal.dropRate >= cal.dropUrgentRate) score += 12
      else if (meal.dropRate >= cal.dropHighRate) score += 6
    }
  }

  if (peakSignal) {
    if (peakSignal.severity === 'urgent') score += 18
    else if (peakSignal.severity === 'high') score += 12
    else if (peakSignal.severity === 'watch') score += 7
  }
  if (hypoRisk) {
    if (hypoRisk.css === 'urgent' || hypoRisk.css === 'hypo') score += 25
    else if (hypoRisk.css === 'warning') score += 16
    else if (hypoRisk.css === 'watch') score += 8
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  return { score, level: classifyMealRisk(score) }
}

export function timelineFromMmolReadings(readings, nowMs) {
  return readings
    .map((entry) => ({
      date: nowMs - Number(entry.minutesAgo) * 60_000,
      sgv: mgdlFromMmol(entry.mmol),
    }))
    .sort((a, b) => b.date - a.date)
}
