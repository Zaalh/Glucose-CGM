// Reactieve-hypo detector V2 — uitlegbare, component-gebaseerde risicoscore.
//
// Geen zwarte doos: elk onderdeel levert losse punten en een reden op. De som
// (minus demping) mapt naar low/watch/likely/urgent, met harde overrides voor
// veiligheid. Werkt op de featureset uit hypo-features.mjs plus optionele
// context (persoonlijke patroonmatch, feedback). Pure functie, geen I/O.

import { round, clamp } from './hypo-features.mjs'
import { DEFAULT_SIMILARITY_PARAMS } from './episode-similarity.mjs'

export const MODEL_VERSION = 'reactive-hypo-v2'

// Drempels — bewust als constanten zodat ze later configureerbaar kunnen worden.
const TH = {
  near: 4.5,
  low: 4.0,
  fastFall: -0.05,
  veryFastFall: -0.08,
  extremeFall: -0.1,
  slowFall: -0.03,
}

// Tunebare parameters. De auto-tuner (tune-reactive-hypo-v2.mjs) zoekt hierover
// en schrijft de beste set weg; live + backtest geven ze door via context.params.
export const DEFAULT_PARAMS = {
  scoreCut: { urgent: 8, likely: 5, watch: 3 }, // score -> risk grenzen
  accelDownBonus: 1, // extra rate-punt bij versnellende daling (FP-gevoelig)
  worstCaseToLikely: true, // worst-case <4.0 dwingt minimaal 'likely'
  safeNadirDamping: false, // demp drop-context naar 'watch' als zelfs worst-case >=4.5 blijft
  patternRecencyDays: null, // half-life voor persoonlijke pattern-match; null = alle vectors gelijk
  similarity: DEFAULT_SIMILARITY_PARAMS, // vector-match tuning; gebruikt door patternFromFeatures
  safeUncertaintyDamping: false, // demp onzekerheids-only escalatie als harde low-signalen ontbreken
  recentLowRecoveryDamping: false, // demp post-hypo nasleep als herstel objectief stabiel lijkt
}

function mergeParams(params) {
  const p = params || {}
  return {
    scoreCut: { ...DEFAULT_PARAMS.scoreCut, ...(p.scoreCut || {}) },
    accelDownBonus: Number.isFinite(p.accelDownBonus) ? p.accelDownBonus : DEFAULT_PARAMS.accelDownBonus,
    worstCaseToLikely:
      typeof p.worstCaseToLikely === 'boolean' ? p.worstCaseToLikely : DEFAULT_PARAMS.worstCaseToLikely,
    safeNadirDamping:
      typeof p.safeNadirDamping === 'boolean' ? p.safeNadirDamping : DEFAULT_PARAMS.safeNadirDamping,
    patternRecencyDays:
      Number.isFinite(p.patternRecencyDays) && p.patternRecencyDays > 0
        ? p.patternRecencyDays
        : DEFAULT_PARAMS.patternRecencyDays,
    similarity: {
      ...DEFAULT_PARAMS.similarity,
      ...(p.similarity || {}),
      scales: {
        ...DEFAULT_PARAMS.similarity.scales,
        ...(p.similarity?.scales || {}),
      },
    },
    safeUncertaintyDamping:
      typeof p.safeUncertaintyDamping === 'boolean'
        ? p.safeUncertaintyDamping
        : DEFAULT_PARAMS.safeUncertaintyDamping,
    recentLowRecoveryDamping:
      typeof p.recentLowRecoveryDamping === 'boolean'
        ? p.recentLowRecoveryDamping
        : DEFAULT_PARAMS.recentLowRecoveryDamping,
  }
}

function num(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback
}

// --- Scenario-projecties -------------------------------------------------
// Meerdere lijnen i.p.v. één rechte voorspelling; we kijken naar het laagste
// plausibele punt binnen de horizon (oref0-idee), niet alleen het gemiddelde.
const HORIZONS = [10, 20, 30]
const DECAY_TAU = 20

function projectMomentum(current, rate, h) {
  return clamp(current + rate * h, 1.5, 33)
}

function projectDecay(current, rate, h) {
  // Rate vlakt geleidelijk af: verplaatsing satureert richting rate*tau.
  const disp = rate * DECAY_TAU * (1 - Math.exp(-h / DECAY_TAU))
  return clamp(current + disp, 1.5, 33)
}

function scenarioFrom(name, current, rate, weight, projector) {
  const mmol = {}
  let min30 = current
  for (const h of HORIZONS) {
    const v = round(projector(current, rate, h), 3)
    mmol[`mmol${h}`] = v
    if (v < min30) min30 = v
  }
  return { name, ...mmol, min30: round(min30, 3), weight }
}

function buildScenarios(features) {
  const current = num(features.currentMmol, 99)
  const blended = num(features.blendedRate, 0)
  const worstRate = Math.min(blended, num(features.maxFallRate30m, 0))

  const items = [
    scenarioFrom('momentum', current, blended, 0.4, projectMomentum),
    scenarioFrom('rateDecay', current, blended, 0.3, projectDecay),
    scenarioFrom('patternWorstSafe', current, worstRate, 0.3, projectMomentum),
  ]

  let wsum = 0
  let expected = 0
  let worst = Infinity
  let best = -Infinity
  for (const s of items) {
    wsum += s.weight
    expected += s.weight * s.min30
    if (s.min30 < worst) worst = s.min30
    if (s.min30 > best) best = s.min30
  }
  const expectedMin30 = wsum > 0 ? expected / wsum : current
  const uncertaintyWidth = best - worst
  // Scenario-overeenstemming: hoe smaller de spreiding, hoe hoger.
  const scenarioAgreement = clamp(1 - uncertaintyWidth / 2, 0, 1)

  return {
    expectedMin30: round(expectedMin30, 3),
    worstCaseMin30: round(worst, 3),
    bestCaseMin30: round(best, 3),
    uncertaintyWidth: round(uncertaintyWidth, 3),
    scenarioAgreement: round(scenarioAgreement, 3),
    items,
  }
}

// --- Risk-niveau helpers -------------------------------------------------
const ORDER = { low: 0, watch: 1, likely: 2, urgent: 3 }

function scoreToRisk(score, cut) {
  if (score >= cut.urgent) return 'urgent'
  if (score >= cut.likely) return 'likely'
  if (score >= cut.watch) return 'watch'
  return 'low'
}

function atLeast(current, floor) {
  return ORDER[floor] > ORDER[current] ? floor : current
}

// --- Hoofdfunctie --------------------------------------------------------
export function evaluateReactiveHypoRiskV2(features, context = {}) {
  const f = features || {}
  const P = mergeParams(context.params)
  const pattern = context.pattern || null
  const reasons = []
  const components = {}

  const current = num(f.currentMmol, 99)
  const rate5m = num(f.rate5m, 0)
  const rate10m = num(f.rate10m, 0)
  const rate15m = num(f.rate15m, 0)
  const blended = num(f.blendedRate, 0)
  const drop = num(f.dropFromPeakMmol, 0)
  const dropPct = num(f.dropFromPeakPercent, 0)
  const peak = num(f.peakMmol120m, 0)
  const minSincePeak = num(f.minutesSincePeak, 999)
  const lagAdjusted = num(f.lagAdjustedMmol, current)
  const recentLow = num(f.recentLowMmol, current)
  const minutesSinceRecentLow = num(f.minutesSinceRecentLow, 999)
  const reboundFromRecentLow = num(f.reboundFromRecentLowMmol, 0)
  const ageSeconds = Number.isFinite(f.ageSeconds) ? f.ageSeconds : 0
  const dataQuality = f.dataQuality || null
  const qualityLevel = dataQuality?.level || 'good'
  const qualityDegraded = qualityLevel === 'degraded'
  const qualityWatch = qualityLevel === 'watch'

  const falling = blended < -0.005
  const fastReactive = drop >= 2 && minSincePeak <= 45 && rate10m <= -0.04

  // 1. Actuele veiligheid
  let currentScore = 0
  if (current < TH.low) {
    currentScore = 5
    reasons.push('Actuele waarde onder 4.0 mmol/L')
  } else if (current < TH.near) {
    currentScore = 3
    reasons.push('Actuele waarde onder 4.5 mmol/L')
  } else if (current < 5.0) {
    currentScore = 1
  }
  components.currentScore = currentScore

  // 2. Trend / snelheid
  let rateScore = 0
  const steepest = Math.min(rate5m, rate10m, blended)
  if (steepest <= TH.extremeFall) {
    rateScore = 3
    reasons.push('Zeer snelle daling')
  } else if (steepest <= TH.veryFastFall) {
    rateScore = 3
    reasons.push('Snelle daling')
  } else if (steepest <= TH.fastFall) {
    rateScore = 2
    reasons.push('Verhoogde dalingssnelheid')
  } else if (steepest <= TH.slowFall) {
    rateScore = 1
  }
  if (rate15m <= -0.04) rateScore += 1
  // Stap 1 — versnelling: expliciete acceleratie scoort zwaarder dan de vage
  // isAcceleratingDown-vlag; isDecelerating (vlakker wordende daling) geeft demping.
  if (f.acceleration !== null && f.acceleration < -0.005 && P.accelDownBonus > 0) {
    rateScore += P.accelDownBonus
    reasons.push('Daling versnelt')
  } else if (f.isAcceleratingDown && P.accelDownBonus > 0 && f.acceleration === null) {
    // Fallback als acceleration niet beschikbaar is (weinig meetpunten).
    rateScore += P.accelDownBonus
    reasons.push('Daling versnelt')
  }
  components.rateScore = rateScore

  // 3. Reactieve context (piek/drop)
  let reactiveScore = 0
  if (peak >= 10 && minSincePeak <= 30) {
    reactiveScore += 3
    reasons.push('Recente piek boven 10.0 mmol/L')
  } else if (peak >= 8.5 && minSincePeak <= 45 && fastReactive) {
    reactiveScore += 2
    reasons.push('Matige piek met snelle post-piek daling')
  }
  if (drop >= 3) {
    reactiveScore += 3
    reasons.push('Grote daling vanaf piek')
  } else if (drop >= 2) {
    reactiveScore += 2
    reasons.push('Snelle daling vanaf piek')
  } else if (drop >= 1.5) {
    reactiveScore += 1
  }
  if (dropPct >= 30) reactiveScore += 2
  else if (dropPct >= 25) reactiveScore += 1
  // Laag 4 — dagdeel-context: lunch/middagreacties zijn historisch relevanter,
  // maar alleen als er al een echte post-piek daling is. Geen zelfstandig alarm.
  if ((f.timeOfDay === 'middag' || f.timeOfDay === 'middag2') && fastReactive) {
    reactiveScore += 1
    reasons.push('Dagdeel past bij reactieve post-maaltijddaling')
  }
  components.reactiveScore = reactiveScore

  // 4. Voorspelling (deterministisch, uit features)
  let forecastScore = 0
  if (f.minutesTo45 !== null && f.minutesTo45 >= 0 && f.minutesTo45 <= 20) {
    forecastScore += 2
    reasons.push(`Voorspeld onder 4.5 binnen ${Math.round(f.minutesTo45)} min`)
  }
  if (f.minutesTo40 !== null && f.minutesTo40 >= 0 && f.minutesTo40 <= 20) {
    forecastScore += 3
    reasons.push(`Voorspeld onder 4.0 binnen ${Math.round(f.minutesTo40)} min`)
  }
  // Laag 1/3 — persoonlijke nadir-schatting uit vergelijkbare episodes. Dit is
  // aanvullend bewijs naast rate/forecast; zonder genoeg matches blijft het neutraal.
  if (pattern && num(pattern.similarEpisodeCount, 0) >= 5 && Number.isFinite(pattern.patternNadirMmol)) {
    if (pattern.patternNadirMmol < TH.low) {
      forecastScore += 2
      reasons.push(`Vergelijkbare episodes hadden nadir rond ${pattern.patternNadirMmol} mmol/L`)
    } else if (pattern.patternNadirMmol < TH.near) {
      forecastScore += 1
      reasons.push(`Vergelijkbare episodes kwamen rond ${pattern.patternNadirMmol} mmol/L`)
    }
  }
  components.forecastScore = forecastScore

  // 5. CGM-lag correctie
  let lagScore = 0
  if (falling && lagAdjusted < TH.low) {
    lagScore = 2
    reasons.push('CGM-lag: snelle daling kan echte glucose onder 4.0 brengen')
  } else if (falling && lagAdjusted < TH.near) {
    lagScore = 1
    reasons.push('CGM-lag: snelle daling kan echte glucose onder 4.5 brengen')
  }
  components.lagScore = lagScore

  // 6. Recent-hypo context: bij jouw patroon kan de sensor na een diepe dip kort
  // opveren, maar het risico is pas echt weg als de waarde stabiel boven near-low
  // blijft. Een recente level-2 dip (<3.0) of level-1 dip met dalende trend houdt
  // daarom een risicovloer vast.
  let recentLowScore = 0
  const recentHypo = recentLow < TH.low && minutesSinceRecentLow <= 120
  const recentDeepHypo = recentLow < 3.0 && minutesSinceRecentLow <= 120
  const unstableAfterLow =
    recentHypo &&
    minutesSinceRecentLow <= 90 &&
    (current < 5.5 || falling || lagAdjusted < TH.near || reboundFromRecentLow < 1.2)
  if (recentDeepHypo) {
    recentLowScore += 3
    reasons.push(`Recente diepe hypo: nadir ${recentLow} mmol/L`)
  } else if (recentHypo && unstableAfterLow) {
    recentLowScore += 2
    reasons.push(`Recente hypo: nadir ${recentLow} mmol/L`)
  } else if (recentHypo && current < 5.5) {
    recentLowScore += 1
  }
  if (unstableAfterLow && falling) {
    recentLowScore += 1
    reasons.push('Herstel na hypo is nog instabiel')
  }
  components.recentLowScore = recentLowScore

  // 7. Persoonlijke patroonmatch (optioneel; neutraal zonder data)
  let patternScore = 0
  if (pattern && num(pattern.similarEpisodeCount, 0) >= 5) {
    const ratio = num(pattern.similarHypoRatio, 0)
    if (ratio >= 0.6) {
      patternScore = 2
      reasons.push(
        `Lijkt op ${pattern.similarEpisodeCount} beste patronen; ${pattern.similarHypoCount ?? '?'} gingen onder 4.5`,
      )
    } else if (ratio >= 0.4) {
      patternScore = 1
    }
  }
  if (pattern && num(pattern.curveMatchCount, 0) >= 5) {
    const curveRatio = num(pattern.curveHypoRatio, 0)
    if (curveRatio >= 0.6) {
      patternScore += 2
      reasons.push(
        `Curvevorm lijkt op ${pattern.curveMatchCount} beste patronen; ${pattern.curveHypoCount ?? '?'} gingen onder 4.5`,
      )
    } else if (curveRatio >= 0.4) {
      patternScore += 1
    }
  }
  if (pattern && pattern.weekdayRiskHigh && fastReactive) {
    patternScore += 1
    reasons.push(`Weekdag ${pattern.weekday} was historisch riskanter`)
  }
  components.patternScore = patternScore

  // 8. Meal-onset (Laag 8): de sterkste vroege voorspelling is niet "er daalt iets"
  // maar "er is een maaltijdpiek begonnen die op een reactieve-hypo-curve lijkt".
  // Geeft ~10-15 min extra voorlooptijd door al in de stijgende fase een lage
  // 'watch' te zetten. Werkt als risk-floor (net als de worst-case override), NIET
  // als score-bijdrage: meal-onset mag nooit zelf tot een alarm (likely/urgent)
  // leiden — dat blijft voorbehouden aan de dalende fase.
  let mealOnsetScore = 0
  const mealOnsetActive = Boolean(f.mealOnset) && peak >= 7.5 && rate10m >= 0.04 && blended > 0
  if (mealOnsetActive) {
    mealOnsetScore = 3
    reasons.push('Maaltijdpiek begonnen — reactieve daling kan binnen 30-60 min volgen')
  }
  components.mealOnsetScore = mealOnsetScore

  // 9. Demping voor veilig/stabiel patroon
  let dampingScore = 0
  if (current >= 7.0 && steepest > TH.fastFall) dampingScore += 3
  if (blended >= 0) dampingScore += 2
  if (drop < 1.0) dampingScore += 1
  if (ageSeconds > 600) dampingScore += 2
  // Stap 2 — hersteldemping: daling vlakt af of draait al om → minder alarm.
  // Dit is de grootste bron van vals alarm: daling is al voorbij maar score blijft hoog.
  if (f.isDecelerating) {
    dampingScore += 2
    // Reden alleen tonen als het een meaningvol verschil maakt.
    if (current >= TH.near) reasons.push('Daling vlakt af')
  }
  if (f.isBottoming) {
    dampingScore += 2
    if (current >= TH.near) reasons.push('Daling haast gestopt')
  }
  if (f.recoverySignal) {
    dampingScore += 3
    if (current >= TH.near) reasons.push('Daling keert om')
  }
  if (unstableAfterLow) {
    dampingScore = Math.max(0, dampingScore - 2)
  }
  // Nachtmetingen zijn gevoeliger voor compressie/ruis en minder vaak een maaltijdrespons.
  // Maak V2 daar iets conservatiever, behalve bij duidelijke actuele/voorspelde low.
  if (f.timeOfDay === 'nacht' && current >= TH.near && steepest > TH.veryFastFall) {
    dampingScore += 1
    reasons.push('Nachtcontext: conservatiever voor vals alarm')
  }
  if (qualityDegraded && current >= TH.near) {
    dampingScore += 2
    reasons.push('Datakwaliteit onvoldoende: conservatiever voor trend-alarm')
  } else if (qualityWatch && current >= TH.near) {
    dampingScore += 1
    reasons.push('Datakwaliteit watch: trend-alarm minder zeker')
  }
  // Niet dempen als het echt risicovol is (veiligheidsklep).
  if (current < TH.near || steepest <= TH.veryFastFall || (f.minutesTo40 !== null && f.minutesTo40 <= 15)) {
    dampingScore = 0
  }
  components.dampingScore = dampingScore

  // mealOnsetScore telt bewust NIET mee in de score: het is een risk-floor (watch),
  // geen bewijs richting urgent. Zo kan een stijgende fase nooit een alarm worden.
  const rawScore =
    currentScore + rateScore + reactiveScore + forecastScore + lagScore + recentLowScore + patternScore - dampingScore
  const score = Math.max(0, rawScore)

  const scenarios = buildScenarios(f)
  let risk = scoreToRisk(score, P.scoreCut)

  // --- Harde overrides (veiligheid) ---
  if (current < TH.low) risk = 'urgent'
  if (current < TH.near && falling) risk = atLeast(risk, 'likely')
  if (f.minutesTo40 !== null && f.minutesTo40 >= 0 && f.minutesTo40 <= 10) risk = atLeast(risk, 'urgent')
  if (f.minutesTo45 !== null && f.minutesTo45 >= 0 && f.minutesTo45 <= 15 && drop >= 1.5) {
    risk = atLeast(risk, 'likely')
  }
  if (recentDeepHypo && unstableAfterLow) risk = atLeast(risk, 'likely')
  if (recentDeepHypo && falling && current < 5.5) risk = atLeast(risk, 'urgent')
  if (recentHypo && falling && lagAdjusted < TH.low) risk = atLeast(risk, 'urgent')

  // --- Onzekerheids-overrides (worst-case scenario) ---
  if (P.worstCaseToLikely && scenarios.worstCaseMin30 < TH.low) {
    risk = atLeast(risk, 'likely')
    reasons.push('Worst-case scenario komt onder 4.0 binnen 30 min')
  } else if (scenarios.worstCaseMin30 < TH.near && scenarios.uncertaintyWidth >= 1.0) {
    risk = atLeast(risk, 'watch')
    reasons.push('Worst-case onder 4.5 bij wisselend patroon')
  }

  // --- Veilige-bodem demping (precision, tunebaar; default uit) ---
  // Grootste gemeten bron van vals alarm: een reële piekdaling/snelle rate die tóch
  // veilig uitbodemt. Als de actuele waarde >= 4.5 is én zelfs het pessimistische
  // scenario (worstCaseMin30) boven 4.5 blijft, mag drop-context alleen niet naar
  // high/urgent escaleren -> terug naar 'watch'. Alle hard-low triggers (actuele/
  // voorspelde low, post-hypo-instabiliteit) worden expliciet uitgesloten. Alleen
  // actief als de auto-tuner deze param op true zet en de out-of-sample gate slaagt.
  if (P.safeNadirDamping === true) {
    const hardLowActive =
      current < TH.near ||
      (f.minutesTo40 !== null && f.minutesTo40 >= 0 && f.minutesTo40 <= 15) ||
      (recentDeepHypo && falling) ||
      (recentHypo && falling && lagAdjusted < TH.low)
    if (
      !hardLowActive &&
      current >= TH.near &&
      scenarios.worstCaseMin30 >= TH.near &&
      (risk === 'likely' || risk === 'urgent')
    ) {
      risk = 'watch'
      reasons.push('Veilig uitbodemend: piekdaling maar voorspelde bodem blijft boven 4.5')
    }
  }

  // --- Onzekerheids-only demping (precision, tunebaar; default uit) ---
  // Meetdata laat veel FP's zien waar het enige near-low bewijs een brede worst-case
  // projectie is. Houd watch als informatie, maar voorkom likely/urgent als actuele
  // waarde, lag-adjusted waarde en near-term 4.0-forecast veilig blijven.
  if (P.safeUncertaintyDamping === true) {
    const hardNearTermLow = f.minutesTo40 !== null && f.minutesTo40 >= 0 && f.minutesTo40 <= 15
    const uncertaintyOnlyLow =
      current >= 5.5 &&
      lagAdjusted >= TH.near &&
      !hardNearTermLow &&
      !recentDeepHypo &&
      !(recentHypo && falling && lagAdjusted < TH.low) &&
      scenarios.worstCaseMin30 < TH.near &&
      scenarios.expectedMin30 >= TH.near &&
      scenarios.uncertaintyWidth >= 1.0
    if (uncertaintyOnlyLow && (risk === 'likely' || risk === 'urgent')) {
      risk = 'watch'
      reasons.push('Onzekerheidsprojectie gedempt: geen harde near-term low')
    }
  }

  // --- Stabiel herstel na recente hypo (precision, tunebaar; default uit) ---
  // Recent-low context is nodig voor het bekende "opveren en opnieuw dalen" patroon,
  // maar mag niet te lang luid blijven als herstel ruim boven 4.5 en vlak/stijgend is.
  if (P.recentLowRecoveryDamping === true) {
    const stableRecovery =
      recentHypo &&
      current >= 5.8 &&
      blended >= -0.02 &&
      lagAdjusted >= TH.near &&
      reboundFromRecentLow >= 1.8 &&
      minutesSinceRecentLow > 45 &&
      !(f.minutesTo40 !== null && f.minutesTo40 >= 0 && f.minutesTo40 <= 15)
    if (stableRecovery && (risk === 'likely' || risk === 'urgent')) {
      risk = 'watch'
      reasons.push('Recente hypo gedempt: herstel lijkt stabiel')
    }
  }

  // Meal-onset: gegarandeerd minimaal 'watch' (informatief, geen alarm). De damping
  // voor stijgend patroon zou de losse punten anders wegstrepen; als risk-floor
  // overleeft de vroege heads-up. Nooit hoger dan watch via deze weg.
  if (mealOnsetActive) risk = atLeast(risk, 'watch')

  if ((qualityDegraded || qualityWatch) && current >= TH.near) {
    const hardNearTermLow = f.minutesTo40 !== null && f.minutesTo40 >= 0 && f.minutesTo40 <= 10
    const hardPostHypoInstability = recentDeepHypo && unstableAfterLow && falling && current < 5.5
    if (qualityDegraded && risk === 'urgent' && !hardNearTermLow && !hardPostHypoInstability) {
      risk = 'likely'
      reasons.push('Urgent gedempt door datakwaliteit')
    } else if (qualityDegraded && risk === 'likely' && !fastReactive && !hardNearTermLow) {
      risk = 'watch'
      reasons.push('Likely gedempt door datakwaliteit')
    } else if (qualityWatch && risk === 'urgent' && !hardNearTermLow && !hardPostHypoInstability) {
      risk = 'likely'
      reasons.push('Urgent gedempt door datakwaliteit watch')
    }
  }

  // Onzekerheid: spreiding scenario's + ontbrekende/oude data.
  let uncertainty = scenarios.uncertaintyWidth / 2
  if (!Number.isFinite(f.rate10m)) uncertainty += 0.3
  if (ageSeconds > 600) uncertainty += 0.3
  if (qualityWatch) uncertainty += 0.15
  if (qualityDegraded) uncertainty += 0.3
  if (pattern && num(pattern.similarEpisodeCount, 0) >= 5) uncertainty -= 0.2
  uncertainty = round(clamp(uncertainty, 0, 1), 3)

  // Confidence: hoog bij verse data, scenario-overeenstemming en patroon.
  let confidence = 0.5 + scenarios.scenarioAgreement * 0.3
  if (pattern && num(pattern.similarEpisodeCount, 0) >= 5) confidence += 0.15
  if (ageSeconds > 600) confidence -= 0.2
  if (qualityWatch) confidence -= 0.1
  if (qualityDegraded) confidence -= 0.25
  if (!Number.isFinite(f.rate10m)) confidence -= 0.2
  confidence = round(clamp(confidence, 0, 1), 3)

  const predicted = {
    mmol10: scenarios.items[0].mmol10,
    mmol20: scenarios.items[0].mmol20,
    mmol30: scenarios.items[0].mmol30,
    minutesTo45: f.minutesTo45 ?? null,
    minutesTo40: f.minutesTo40 ?? null,
    lagAdjustedMmol: f.lagAdjustedMmol ?? null,
  }

  return {
    modelVersion: MODEL_VERSION,
    risk,
    score: round(score, 2),
    confidence,
    uncertainty,
    components,
    predicted,
    scenarios,
    pattern: pattern || null,
    reasons,
  }
}
