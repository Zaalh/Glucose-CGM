// Fase 0 — validatie: vangt de bestaande vorm-/episode-match het terugkerende
// patroon dip -> harde stijging -> harde daling, en wat is de vals-alarm-kost?
//
// Dit verandert NIETS aan de live-flow. Het meet alleen of het zinvol is om de
// drop-context-gate te verzachten (zie dynamische-patroonherkenning-plan.md).
//
// Beantwoordt de twee beslis-risico's uit het plan:
//   #3 Steekproef: hoeveel dip->rise->drop-episodes bestaan er uberhaupt?
//   #1 Vangt curve-/episode-match ze, en wat kost het aan valse alarmen?
//
// Draaien tegen echte data (Mongo in container op de iMac):
//   docker compose -f docker-compose.nightscout.yml --profile libre run --rm \
//     libreview-sync node scripts/validate-dip-rise-drop.mjs
// Offline rook-test (synthetische vectors, geen Mongo):
//   node scripts/validate-dip-rise-drop.mjs --self-test

import { MongoClient } from 'mongodb'
import { findCurveMatches, findSimilarEpisodes } from './lib/episode-similarity.mjs'

// --- vorm-detectie op de opgeslagen genormaliseerde curve --------------------
// episode_vectors.vector = 24 punten over [piek-20m, piek+40m], zero-mean unit-norm.
// Een "dip voor de stijging" toont zich als een lokaal minimum VOOR de piek dat
// duidelijk onder het beginpunt van het venster ligt.
//
// PROFIELNEUTRAAL: deze drempels zijn UNIVERSELE vorm-heuristieken (fracties van de
// curve-amplitude, dus schaal-/niveau-onafhankelijk), GEEN persoonlijk patroon. Ze
// zijn via env overschrijfbaar zodat ze op meerdere datasets te herijken zijn zonder
// code te wijzigen, en zodat een tuner ze later kan zoeken.
const num = (key, dflt) => (Number.isFinite(Number(process.env[key])) ? Number(process.env[key]) : dflt)
const DIP_FRACTION = num('DIP_FRACTION', 0.12) // dip-diepte als fractie van de totale curve-amplitude
const RISE_FRACTION = num('RISE_FRACTION', 0.25) // stijging dip->piek als fractie van de amplitude

function amplitude(curve) {
  return Math.max(...curve) - Math.min(...curve)
}

function peakIndex(curve) {
  let idx = 0
  for (let i = 1; i < curve.length; i += 1) if (curve[i] > curve[idx]) idx = i
  return idx
}

// Classificeert de curve-vorm. Geeft { isDipRiseDrop, dipDepth, riseToPeak, dropFromPeak }.
export function classifyShape(curve) {
  if (!Array.isArray(curve) || curve.length < 6) return null
  const amp = amplitude(curve)
  if (!(amp > 0)) return null
  const pIdx = peakIndex(curve)
  // dip moet voor de piek liggen en niet het allereerste punt zijn
  let preMinIdx = 0
  for (let i = 1; i <= pIdx; i += 1) if (curve[i] < curve[preMinIdx]) preMinIdx = i
  const dipDepth = curve[0] - curve[preMinIdx]
  const riseToPeak = curve[pIdx] - curve[preMinIdx]
  const dropFromPeak = curve[pIdx] - curve[curve.length - 1]
  const hasLeadingDip = preMinIdx > 0 && preMinIdx < pIdx && dipDepth >= DIP_FRACTION * amp
  const hasRise = riseToPeak >= RISE_FRACTION * amp
  const hasDrop = dropFromPeak >= RISE_FRACTION * amp
  return {
    isDipRiseDrop: hasLeadingDip && hasRise && hasDrop,
    dipDepth: dipDepth / amp,
    riseToPeak: riseToPeak / amp,
    dropFromPeak: dropFromPeak / amp,
    preMinIdx,
    peakIdx: pIdx,
  }
}

function isHypoOutcome(outcome) {
  return outcome === 'hypo' || outcome === 'near_hypo'
}

// Zero-mean unit-norm (zelfde als episode-similarity.normalize, hier lokaal zodat
// we een curve-PREFIX kunnen normaliseren voor de vroege-waarschuwing-variant).
function normalizeShape(values) {
  if (!values || !values.length) return null
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const centered = values.map((v) => v - mean)
  const norm = Math.sqrt(centered.reduce((s, v) => s + v * v, 0))
  if (norm < 1e-9) return centered.map(() => 0)
  return centered.map((v) => v / norm)
}

// --- leave-one-out evaluatie -------------------------------------------------
// Voor elke episode: houd hem achter, match zijn (volledige of prefix-)curve tegen
// alle andere episodes, en kijk of de buren-stemming zijn outcome voorspelt.
// HYPO_RATIO_GATE = drempel waarop we "zou alarm geven" zeggen.
// MIN_RELIABLE_EPISODES = onder dit aantal eigen episodes is het per-persoon signaal
// niet betrouwbaar -> cold-start: terugvallen op de universele regel-detector. Beide
// universeel + env-overschrijfbaar (profielneutraal, geen persoonlijke tuning in code).
const HYPO_RATIO_GATE = num('HYPO_RATIO_GATE', 0.5)
const MIN_RELIABLE_EPISODES = num('MIN_RELIABLE_EPISODES', 8)

function evaluate(vectors, { prefixPoints = null, label = 'volledige curve' } = {}) {
  const usable = vectors.filter((v) => Array.isArray(v.vector) && v.vector.length >= 8)
  // Base-rate van (near-)hypo in het corpus. Cruciaal: episode_vectors zijn
  // gecureerde events, dus de base-rate is hoog. Een absolute ratio-drempel meet dan
  // niets — we meten ONDERSCHEID t.o.v. deze base-rate (lift).
  const baseRate = usable.length ? usable.filter((v) => isHypoOutcome(v.outcome)).length / usable.length : 0

  let dipCount = 0
  let dipHypo = 0
  // Buurt-hypo-ratio per doel, gesplitst op werkelijke uitkomst. Als de vorm-match
  // onderscheidt, krijgen hypo-doelen een HOGERE buurt-ratio dan stabiele doelen.
  const hypoTargetRatios = []
  const stableTargetRatios = []
  let noNeighbours = 0
  // Gecalibreerde gate = buurt-ratio boven de base-rate (relatief, niet absoluut 0.5).
  const stats = { flaggedHypo: 0, missedHypo: 0, falseAlarm: 0, stableSeen: 0 }

  for (const target of usable) {
    const shape = classifyShape(target.vector)
    const isDip = shape && shape.isDipRiseDrop
    if (isDip) dipCount += 1
    if (isDip && isHypoOutcome(target.outcome)) dipHypo += 1

    const others = usable.filter((v) => v !== target)
    let live = target.vector
    if (prefixPoints) live = normalizeShape(target.vector.slice(0, prefixPoints))
    const match = findCurveMatches(live, others)

    if (!match || match.count < 3) {
      noNeighbours += 1
      if (isDip && isHypoOutcome(target.outcome)) stats.missedHypo += 1
      continue
    }
    const ratio = match.hypoRatio
    // Relatieve, base-rate-gecalibreerde gate i.p.v. absolute 0.5.
    const wouldFlag = ratio >= baseRate + (1 - baseRate) * (HYPO_RATIO_GATE)

    if (isHypoOutcome(target.outcome)) {
      hypoTargetRatios.push(ratio)
      if (isDip) { if (wouldFlag) stats.flaggedHypo += 1; else stats.missedHypo += 1 }
    } else {
      stableTargetRatios.push(ratio)
      stats.stableSeen += 1
      if (wouldFlag) stats.falseAlarm += 1
    }
  }

  const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null)
  const meanRatioHypo = mean(hypoTargetRatios)
  const meanRatioStable = mean(stableTargetRatios)
  // Onderscheid: hoeveel hoger is de buurt-ratio voor hypo-doelen dan voor stabiele.
  // > 0 = de vorm draagt signaal; ~0 = de vorm zegt niets bovenop de base-rate.
  const separation = meanRatioHypo !== null && meanRatioStable !== null ? meanRatioHypo - meanRatioStable : null
  const liftHypo = meanRatioHypo !== null && baseRate > 0 ? meanRatioHypo / baseRate : null
  const recall = dipHypo > 0 ? stats.flaggedHypo / dipHypo : null
  const falseAlarmRate = stats.stableSeen > 0 ? stats.falseAlarm / stats.stableSeen : null
  const reliablePerPerson = dipHypo >= MIN_RELIABLE_EPISODES
  const r2 = (x) => (x === null ? null : Math.round(x * 100) / 100)
  return {
    label,
    prefixPoints,
    totalUsable: usable.length,
    baseRate: r2(baseRate),
    dipRiseDropEpisodes: dipCount,
    dipRiseDropHypo: dipHypo,
    reliablePerPerson,
    minReliableEpisodes: MIN_RELIABLE_EPISODES,
    meanNeighbourRatioHypo: r2(meanRatioHypo),
    meanNeighbourRatioStable: r2(meanRatioStable),
    separation: r2(separation),
    liftHypo: r2(liftHypo),
    recall: r2(recall),
    falseAlarmRate: r2(falseAlarmRate),
    noNeighbours,
    ...stats,
  }
}

// --- self-test (offline, synthetische vectors) -------------------------------
function syntheticVectors() {
  // Bouw 24-punts curves: dip(0..6) -> piek(8) -> daling(23). Hypo-uitkomsten
  // krijgen een diepere staart-daling; stable blijft hoog eindigen.
  function curve({ dip, drop }) {
    const pts = []
    for (let i = 0; i < 24; i += 1) {
      let v
      if (i <= 4) v = 6 - dip * (i / 4) // dip omlaag
      else if (i <= 8) v = 6 - dip + (3 + dip) * ((i - 4) / 4) // stijging naar piek 9
      else v = 9 - drop * ((i - 8) / 15) // daling
      pts.push(v)
    }
    const mean = pts.reduce((s, v) => s + v, 0) / pts.length
    const c = pts.map((v) => v - mean)
    const norm = Math.sqrt(c.reduce((s, v) => s + v * v, 0))
    return c.map((v) => v / norm)
  }
  const out = []
  for (let i = 0; i < 8; i += 1) out.push({ vector: curve({ dip: 1.2, drop: 5.5 }), outcome: 'hypo' })
  for (let i = 0; i < 4; i += 1) out.push({ vector: curve({ dip: 1.1, drop: 2.0 }), outcome: 'stable' })
  return out
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const vectors = syntheticVectors()
    const full = evaluate(vectors, { label: 'self-test volledige curve' })
    console.log(JSON.stringify(full, null, 2))
    const ok = full.dipRiseDropEpisodes >= 8 && full.recall !== null && full.totalUsable === 12
    console.log(`\n${ok ? 'SELF-TEST OK' : 'SELF-TEST FAIL'}`)
    process.exit(ok ? 0 : 1)
  }

  const uri = process.env.MONGODB_URI ?? 'mongodb://nightscout-mongo:27017/nightscout'
  const client = new MongoClient(uri)
  await client.connect()
  try {
    const vectors = await client
      .db()
      .collection('episode_vectors')
      .find({}, { projection: { vector: 1, featureVector: 1, outcome: 1, peakDate: 1 } })
      .limit(2000)
      .toArray()

    console.log(`episode_vectors geladen: ${vectors.length}\n`)

    // #3 steekproef + #1 recall/vals-alarm op de volledige curve
    const full = evaluate(vectors, { label: 'volledige curve (piek+daling bekend)' })
    // vroege-waarschuwing: alleen de aanloop t/m ~piek (eerste 10 punten = ~piek-20..+5m)
    const early = evaluate(vectors, { prefixPoints: 10, label: 'vroege prefix (10 pt, ~t/m piek)' })

    console.log(JSON.stringify({ full, early }, null, 2))

    console.log('\n--- duiding ---')
    console.log(`dip->rise->drop episodes: ${full.dipRiseDropEpisodes} (waarvan ${full.dipRiseDropHypo} (near-)hypo)`)
    if (full.dipRiseDropEpisodes < 3) {
      console.log('LET OP: < 3 zulke episodes — vorm-match kan principieel niet vuren (risico #3). Stop hier.')
    }
    if (!full.reliablePerPerson) {
      console.log(`COLD-START: < ${full.minReliableEpisodes} (near-)hypo dip-episodes — per-persoon signaal nog niet betrouwbaar.`)
      console.log('  Live hoort hier terug te vallen op de universele regel-detector (werkt zo ook voor nieuwe gebruikers).')
    }
    console.log(`base-rate (near-)hypo in corpus: ${full.baseRate}  <- absolute ratio meet hierboven niets`)
    console.log('ONDERSCHEID = buurt-ratio hypo-doelen minus stabiele-doelen (>0 = vorm draagt signaal):')
    console.log(`  volledige curve: hypo=${full.meanNeighbourRatioHypo} stable=${full.meanNeighbourRatioStable} -> separation=${full.separation} (lift=${full.liftHypo})`)
    console.log(`  vroege prefix:   hypo=${early.meanNeighbourRatioHypo} stable=${early.meanNeighbourRatioStable} -> separation=${early.separation} (lift=${early.liftHypo})`)
    const verdict = (s) => (s === null ? 'onbepaald' : s >= 0.1 ? 'BRUIKBAAR signaal' : s >= 0.03 ? 'zwak signaal' : 'GEEN signaal bovenop base-rate')
    console.log(`oordeel volledige curve: ${verdict(full.separation)}`)
    console.log(`oordeel vroege prefix:   ${verdict(early.separation)}`)
    console.log(`(base-rate-gecalibreerde gate) volledige: recall=${full.recall} vals-alarm=${full.falseAlarmRate}`)
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
