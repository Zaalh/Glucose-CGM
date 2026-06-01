// Reactieve-hypo detector V2 — uitlegbare, component-gebaseerde risicoscore.
//
// Geen zwarte doos: elk onderdeel levert losse punten en een reden op. De som
// (minus demping) mapt naar low/watch/likely/urgent, met harde overrides voor
// veiligheid. Werkt op de featureset uit hypo-features.mjs plus optionele
// context (persoonlijke patroonmatch, feedback). Pure functie, geen I/O.

import { round, clamp } from './hypo-features.mjs'

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

function scoreToRisk(score) {
  if (score >= 8) return 'urgent'
  if (score >= 5) return 'likely'
  if (score >= 3) return 'watch'
  return 'low'
}

function atLeast(current, floor) {
  return ORDER[floor] > ORDER[current] ? floor : current
}

// --- Hoofdfunctie --------------------------------------------------------
export function evaluateReactiveHypoRiskV2(features, context = {}) {
  const f = features || {}
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
  const ageSeconds = Number.isFinite(f.ageSeconds) ? f.ageSeconds : 0

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
  if (f.isAcceleratingDown) {
    rateScore += 1
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

  // 6. Persoonlijke patroonmatch (optioneel; neutraal zonder data)
  let patternScore = 0
  if (pattern && num(pattern.similarEpisodeCount, 0) >= 5) {
    const ratio = num(pattern.similarHypoRatio, 0)
    if (ratio >= 0.6) {
      patternScore = 2
      reasons.push(
        `Lijkt op ${pattern.similarEpisodeCount} eerdere episodes; ${pattern.similarHypoCount ?? '?'} gingen onder 4.5`,
      )
    } else if (ratio >= 0.4) {
      patternScore = 1
    }
  }
  components.patternScore = patternScore

  // 7. Demping voor veilig/stabiel patroon
  let dampingScore = 0
  if (current >= 7.0 && steepest > TH.fastFall) dampingScore += 3
  if (blended >= 0) dampingScore += 2
  if (drop < 1.0) dampingScore += 1
  if (ageSeconds > 600) dampingScore += 2
  // Niet dempen als het echt risicovol is.
  if (current < TH.near || steepest <= TH.veryFastFall || (f.minutesTo40 !== null && f.minutesTo40 <= 15)) {
    dampingScore = 0
  }
  components.dampingScore = dampingScore

  const rawScore =
    currentScore + rateScore + reactiveScore + forecastScore + lagScore + patternScore - dampingScore
  const score = Math.max(0, rawScore)

  const scenarios = buildScenarios(f)
  let risk = scoreToRisk(score)

  // --- Harde overrides (veiligheid) ---
  if (current < TH.low) risk = 'urgent'
  if (current < TH.near && falling) risk = atLeast(risk, 'likely')
  if (f.minutesTo40 !== null && f.minutesTo40 >= 0 && f.minutesTo40 <= 10) risk = atLeast(risk, 'urgent')
  if (f.minutesTo45 !== null && f.minutesTo45 >= 0 && f.minutesTo45 <= 15 && drop >= 1.5) {
    risk = atLeast(risk, 'likely')
  }

  // --- Onzekerheids-overrides (worst-case scenario) ---
  if (scenarios.worstCaseMin30 < TH.low) {
    risk = atLeast(risk, 'likely')
    reasons.push('Worst-case scenario komt onder 4.0 binnen 30 min')
  } else if (scenarios.worstCaseMin30 < TH.near && scenarios.uncertaintyWidth >= 1.0) {
    risk = atLeast(risk, 'watch')
    reasons.push('Worst-case onder 4.5 bij wisselend patroon')
  }

  // Onzekerheid: spreiding scenario's + ontbrekende/oude data.
  let uncertainty = scenarios.uncertaintyWidth / 2
  if (!Number.isFinite(f.rate10m)) uncertainty += 0.3
  if (ageSeconds > 600) uncertainty += 0.3
  if (pattern && num(pattern.similarEpisodeCount, 0) >= 5) uncertainty -= 0.2
  uncertainty = round(clamp(uncertainty, 0, 1), 3)

  // Confidence: hoog bij verse data, scenario-overeenstemming en patroon.
  let confidence = 0.5 + scenarios.scenarioAgreement * 0.3
  if (pattern && num(pattern.similarEpisodeCount, 0) >= 5) confidence += 0.15
  if (ageSeconds > 600) confidence -= 0.2
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
