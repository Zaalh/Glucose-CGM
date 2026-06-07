// Auto-tuner voor de V2 reactieve-hypo detector.
//
// Methodiek (CGM-literatuur): temporele train/test-split (geen tuning op de
// data waarop je rapporteert), grid search over V2-parameters, en een
// recall-gebonden objective (veiligheid eerst): kies onder de combo's met de
// hoogste recall degene met de beste precision, dan lead-time. Rapporteert
// in-sample (train) én out-of-sample (test) zodat de overfit-kloof zichtbaar is.
//
// Draaien op echte data:
//   docker compose ... run --rm libreview-sync node scripts/tune-reactive-hypo-v2.mjs
//   (of npm run hypo:tune)  ->  schrijft scripts/reactive-hypo-v2-state.json
// Lokaal proefdraaien zonder database:
//   node scripts/tune-reactive-hypo-v2.mjs --self-test

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MongoClient } from 'mongodb'
import { MGDL_PER_MMOL } from './lib/hypo-features.mjs'
import { DEFAULT_PARAMS } from './lib/reactive-hypo-detector.mjs'
import { buildReplayContext, evaluateV1, evaluateV2, loadEpisodeVectors } from './evaluate-hypo-detector.mjs'

const MS_PER_MIN = 60_000
const TRAIN_FRACTION = Number(process.env.HYPO_TUNE_TRAIN_FRACTION ?? 0.7)
// Onder dit aantal hypo-events in train/test is een split statistisch zinloos;
// dan schrijven we GEEN state-file (anders lijkt default ten onrechte "getuned").
// Met de nadir-gebaseerde (korte-dip) event-definitie geeft een 70/30-split bij ~4
// dagen data ~12/4 events; 2 per helft is het minimum waarbij de gate eerlijk blijft.
const MIN_EVENTS = Number(process.env.HYPO_TUNE_MIN_EVENTS ?? 2)
const STATE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'reactive-hypo-v2-state.json')

// Parameterruimte (klein en uitlegbaar; de FP-gevoelige knoppen).
function paramGrid() {
  const grid = []
  for (const likely of [5, 6, 7]) {
    for (const urgent of [8, 9, 10]) {
      if (urgent <= likely) continue
      for (const accelDownBonus of [0, 1]) {
        for (const worstCaseToLikely of [true, false]) {
          for (const safeNadirDamping of [false, true]) {
            for (const patternRecencyDays of [null, 7, 14, 21]) {
              grid.push({
                scoreCut: { watch: 3, likely, urgent },
                accelDownBonus,
                worstCaseToLikely,
                safeNadirDamping,
                patternRecencyDays,
                safeUncertaintyDamping: false,
                recentLowRecoveryDamping: false,
              })
            }
          }
        }
      }
    }
  }
  return grid
}

function dampingRefinementGrid(baseParams) {
  const base = {
    ...baseParams,
    safeUncertaintyDamping: false,
    recentLowRecoveryDamping: false,
  }
  return [
    base,
    { ...base, safeUncertaintyDamping: true },
    { ...base, recentLowRecoveryDamping: true },
    { ...base, safeUncertaintyDamping: true, recentLowRecoveryDamping: true },
  ]
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return null
  }
}

function line(m) {
  return {
    recall: m.recall,
    precision: m.precision,
    leadMin: m.medianLeadTimeMinutes,
    falsePositive: m.falsePositive,
    predictiveAlerts: m.predictiveAlerts,
    missed: m.missed,
    earlyCovered: m.earlyCovered,
  }
}

// Recall eerst (geen vangbare hypo opofferen), dan precision, dan lead-time,
// dan minder vals alarm. Werkt op TRAIN-metrics.
function pickBest(results) {
  const bestRecall = Math.max(...results.map((r) => r.train.recall ?? 0))
  const candidates = results.filter((r) => (r.train.recall ?? 0) === bestRecall)
  candidates.sort((a, b) => {
    const pa = a.train.precision ?? 0
    const pb = b.train.precision ?? 0
    if (pb !== pa) return pb - pa
    const la = a.train.medianLeadTimeMinutes ?? 0
    const lb = b.train.medianLeadTimeMinutes ?? 0
    if (lb !== la) return lb - la
    return (a.train.falsePositive ?? 0) - (b.train.falsePositive ?? 0)
  })
  return candidates[0]
}

function tune(timeline, options = {}) {
  if (timeline.length < 20) return { ok: false, reason: 'te weinig data' }
  // Split op reading-index, niet op kalendertijd. De datadichtheid is sterk
  // ongelijk (sparse history-backfill in april vs. dichte 1-min-stroom vanaf eind
  // mei), dus 70% van de wandklok kan bijna geen metingen — en 0 hypo-events —
  // bevatten, waardoor de gate degenereert. 70% van de gesorteerde readings houdt
  // de split temporeel (één tijdsgrens, geen leakage) maar verdeelt de events
  // evenredig met de datadichtheid, zodat train én test events krijgen.
  const frac = options.trainFraction ?? TRAIN_FRACTION
  const splitIdx = Math.min(timeline.length - 1, Math.max(1, Math.floor(timeline.length * frac)))
  const splitMs = timeline[splitIdx].date
  // episode_vectors meegeven zodat V2 in train/test hetzelfde pattern (component 6 /
  // patternScore) krijgt als de live-sync — anders tunen we op een andere score dan
  // we serveren. Matcht de live-sync, die de volledige vectorset gebruikt.
  const ctxOpts = { sustainMin: options.sustainMin, episodeVectors: options.episodeVectors ?? null }

  const trainCtx = buildReplayContext(timeline, { ...ctxOpts, toMs: splitMs })
  const testCtx = buildReplayContext(timeline, { ...ctxOpts, fromMs: splitMs })

  const grid = options.refineDamping && options.baseParams
    ? dampingRefinementGrid(options.baseParams)
    : paramGrid()
  const results = grid.map((params) => ({
    params,
    train: evaluateV2(trainCtx, params).metrics,
    test: evaluateV2(testCtx, params).metrics,
  }))

  const best = pickBest(results)
  const defaultTrain = evaluateV2(trainCtx, DEFAULT_PARAMS).metrics
  const defaultTest = evaluateV2(testCtx, DEFAULT_PARAMS).metrics
  const v1Train = evaluateV1(trainCtx).metrics
  const v1Test = evaluateV1(testCtx).metrics

  const minEvents = options.minEvents ?? MIN_EVENTS
  const degenerate = trainCtx.hypoOnsets.length < minEvents || testCtx.hypoOnsets.length < minEvents

  return {
    ok: true,
    degenerate,
    split: {
      at: new Date(splitMs).toISOString(),
      by: 'reading-index',
      splitIndex: splitIdx,
      totalReadings: timeline.length,
      trainFraction: options.trainFraction ?? TRAIN_FRACTION,
      trainHypoOnsets: trainCtx.hypoOnsets.length,
      testHypoOnsets: testCtx.hypoOnsets.length,
      sustainMinutes: trainCtx.sustainMin,
    },
    bestParams: best.params,
    comparison: {
      v1: { train: line(v1Train), test: line(v1Test) },
      v2_default: { train: line(defaultTrain), test: line(defaultTest) },
      v2_tuned: { train: line(best.train), test: line(best.test) },
    },
    gridSize: grid.length,
  }
}

// Kwaliteitsgate (M6): V2 mag alleen automatisch het alarm overnemen als er
// genoeg events zijn ÉN V2 op out-of-sample (test) data niet slechter is dan V1
// — recall niet lager (geen extra gemiste hypo's) en precision niet lager (geen
// extra vals alarm). Conservatief: bij twijfel blijft V2 in shadow.
function buildState(result) {
  const v1 = result.comparison.v1.test
  const v2 = result.comparison.v2_tuned.test
  const gate = {
    enoughEvents: !result.degenerate,
    recallNotWorse: (v2.recall ?? 0) >= (v1.recall ?? 0),
    precisionNotWorse: (v2.precision ?? 0) >= (v1.precision ?? 0),
  }
  const active = gate.enoughEvents && gate.recallNotWorse && gate.precisionNotWorse
  return {
    modelVersion: 'reactive-hypo-v2',
    active,
    activationGate: gate,
    params: result.bestParams,
    tuning: {
      method: 'temporal-split grid-search, recall-constrained',
      split: result.split,
      comparison: result.comparison,
      gridSize: result.gridSize,
    },
    note: active
      ? 'V2 AUTO-GEACTIVEERD: op out-of-sample data minstens zo goed als V1 (recall en precision niet slechter).'
      : 'V2 in shadow: nog niet aantoonbaar >= V1 op out-of-sample data, of te weinig events.',
    trainedAt: new Date().toISOString(),
  }
}

function selfTimeline() {
  const now = Date.UTC(2026, 5, 1, 12, 0, 0)
  const readings = []
  // genoeg herhaalde piek->hypo blokken voor een train/test split
  const hypo = [5.2, 6.8, 9.0, 10.0, 8.6, 6.8, 5.2, 4.2, 3.6, 3.5, 3.7, 4.2, 5.0, 5.4]
  const flat = [5.5, 5.5, 5.4, 5.6, 5.5]
  let t = -((hypo.length + flat.length) * 8) * 5
  for (let k = 0; k < 8; k += 1) {
    for (const mmol of [...hypo, ...flat]) {
      readings.push({ date: now + t * MS_PER_MIN, sgv: Math.round(mmol * MGDL_PER_MMOL) })
      t += 5
    }
  }
  return readings.sort((a, b) => a.date - b.date)
}

async function main() {
  const selfTest = process.argv.includes('--self-test')
  const refineDamping = process.argv.includes('--refine-damping')
  const currentState = process.argv.includes('--current-state')
  let timeline
  let episodeVectors = null
  let client = null
  if (selfTest) {
    timeline = selfTimeline()
  } else {
    const uri = process.env.MONGODB_URI ?? 'mongodb://nightscout-mongo:27017/nightscout'
    client = new MongoClient(uri)
    await client.connect()
    timeline = await client
      .db()
      .collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true } }, { projection: { _id: 0, date: 1, dateString: 1, sgv: 1 } })
      .sort({ date: 1 })
      .toArray()
    episodeVectors = await loadEpisodeVectors(client)
  }

  try {
    const baseOptions = selfTest ? { sustainMin: 5, minEvents: 1 } : { episodeVectors }
    const existingState = currentState ? loadState() : null
    if (currentState && !existingState?.params) {
      console.log(JSON.stringify({ ok: false, reason: 'geen huidige state params gevonden' }))
      process.exit(1)
    }
    const baseResult = currentState
      ? null
      : tune(timeline, baseOptions)
    const result = refineDamping && currentState
      ? tune(timeline, { ...baseOptions, refineDamping: true, baseParams: existingState.params })
      : refineDamping && baseResult.ok
        ? tune(timeline, { ...baseOptions, refineDamping: true, baseParams: baseResult.bestParams })
        : baseResult
    if (!result.ok) {
      console.log(JSON.stringify(result))
      process.exit(1)
    }
    const state = buildState(result)
    console.log(JSON.stringify(state, null, 2))
    if (result.degenerate) {
      console.log(
        `\nWAARSCHUWING: te weinig hypo-events in train (${result.split.trainHypoOnsets}) ` +
          `of test (${result.split.testHypoOnsets}); minimaal ${MIN_EVENTS} nodig. ` +
          `GEEN state geschreven — verzamel eerst meer 1-min data (M5 shadow-mode).`,
      )
      process.exit(2)
    }
    if (!selfTest && process.env.HYPO_TUNE_DRY_RUN !== '1') {
      writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n')
      console.log(`\nstate geschreven: ${STATE_PATH}`)
    } else if (!selfTest) {
      console.log('\ndry-run: state niet geschreven')
    } else {
      console.log('\nSELF-TEST OK')
    }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error(`[tune] mislukt: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
