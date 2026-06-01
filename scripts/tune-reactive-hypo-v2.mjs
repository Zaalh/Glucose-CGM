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

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MongoClient } from 'mongodb'
import { MGDL_PER_MMOL } from './lib/hypo-features.mjs'
import { DEFAULT_PARAMS } from './lib/reactive-hypo-detector.mjs'
import { buildReplayContext, evaluateV1, evaluateV2 } from './evaluate-hypo-detector.mjs'

const MS_PER_MIN = 60_000
const TRAIN_FRACTION = Number(process.env.HYPO_TUNE_TRAIN_FRACTION ?? 0.7)
const STATE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'reactive-hypo-v2-state.json')

// Parameterruimte (klein en uitlegbaar; de FP-gevoelige knoppen).
function paramGrid() {
  const grid = []
  for (const likely of [5, 6, 7]) {
    for (const urgent of [8, 9, 10]) {
      if (urgent <= likely) continue
      for (const accelDownBonus of [0, 1]) {
        for (const worstCaseToLikely of [true, false]) {
          grid.push({ scoreCut: { watch: 3, likely, urgent }, accelDownBonus, worstCaseToLikely })
        }
      }
    }
  }
  return grid
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
  const t0 = timeline[0].date
  const t1 = timeline[timeline.length - 1].date
  const splitMs = t0 + (t1 - t0) * (options.trainFraction ?? TRAIN_FRACTION)
  const ctxOpts = { sustainMin: options.sustainMin }

  const trainCtx = buildReplayContext(timeline, { ...ctxOpts, toMs: splitMs })
  const testCtx = buildReplayContext(timeline, { ...ctxOpts, fromMs: splitMs })

  const grid = paramGrid()
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

  return {
    ok: true,
    split: {
      at: new Date(splitMs).toISOString(),
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

function buildState(result) {
  return {
    modelVersion: 'reactive-hypo-v2',
    active: false, // shadow-mode default; pas activeren in M6
    params: result.bestParams,
    tuning: {
      method: 'temporal-split grid-search, recall-constrained',
      split: result.split,
      comparison: result.comparison,
      gridSize: result.gridSize,
    },
    note:
      'Auto-getuned op de backtest. Klein aantal hypo-events: indicatief, geen ' +
      'definitief oordeel. Wordt betrouwbaarder met meer 1-min data.',
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
  let timeline
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
  }

  try {
    const result = tune(timeline, { sustainMin: selfTest ? 5 : undefined })
    if (!result.ok) {
      console.log(JSON.stringify(result))
      process.exit(1)
    }
    const state = buildState(result)
    if (!selfTest) writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n')
    console.log(JSON.stringify(state, null, 2))
    console.log(`\n${selfTest ? 'SELF-TEST OK' : `state geschreven: ${STATE_PATH}`}`)
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error(`[tune] mislukt: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
