// Shadow-evaluator voor de rebound-forecast. Verandert NIETS live: hij speelt
// de historie af, traint het herstelprofiel op de oudste episodes en toetst het
// out-of-sample op de nieuwste (verleden -> toekomst). Rapporteert MAE per
// horizon, band-kalibratie (dekt p10-p90 ~80%?) en baselines.
//
// Dit is de "stille meeloper": draai 'm periodiek terwijl episodes groeien om te
// zien of de OOS-fout stabiel blijft vóór er ooit een band op de UI verschijnt.
//
// Draaien (mongo in compose-netwerk):
//   docker compose -f docker-compose.nightscout.yml --profile libre \
//     run --rm libreview-sync node scripts/evaluate-rebound-forecast.mjs
//   (of: npm run rebound:eval)
// Lokaal zonder database (synthetisch):
//   node scripts/evaluate-rebound-forecast.mjs --self-test

import { MongoClient } from 'mongodb'
import {
  prepareEntries,
  extractRecoverySamples,
  bandFromSamples,
  median,
  meanAbsError,
  syntheticReboundData,
} from './lib/rebound-profile.mjs'

const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://nightscout-mongo:27017/nightscout'
const MAX_ENTRIES = Number(process.env.EPISODE_MAX_ENTRIES ?? 200_000)
const TRAIN_FRACTION = Number(process.env.REBOUND_TRAIN_FRACTION ?? 0.6)
const EVAL_HORIZONS = [15, 30, 45, 60]
const fmt = (v) => (Number.isFinite(v) ? (Math.round(v * 100) / 100).toFixed(2) : 'n/a')

async function loadFromMongo() {
  const client = new MongoClient(MONGO_URI)
  await client.connect()
  try {
    const db = client.db()
    const episodes = await db
      .collection('reactive_hypo_episodes')
      .find({}, { projection: { _id: 0 } })
      .toArray()
    const entries = await db
      .collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true } }, { projection: { _id: 0, date: 1, sgv: 1 } })
      .sort({ date: 1 })
      .limit(MAX_ENTRIES)
      .toArray()
    return { episodes, entries }
  } finally {
    await client.close().catch(() => undefined)
  }
}

export function evaluate(episodes, entries) {
  const prepared = prepareEntries(entries)
  const rows = extractRecoverySamples(episodes, prepared).sort((a, b) => a.nadirT - b.nadirT)
  if (rows.length < 10) {
    console.log(`Te weinig bruikbare herstelcurves (${rows.length}) voor een betrouwbare split.`)
    return
  }

  // Temporele split: train op de oudste, test op de nieuwste episodes.
  const cut = Math.floor(rows.length * TRAIN_FRACTION)
  const train = rows.slice(0, cut)
  const test = rows.slice(cut)
  const band = bandFromSamples(train, { minSamples: 1 }) // lage drempel: kleine train-set
  const byMinute = new Map(band.map((p) => [p.minute, p]))
  // Twee klinisch betekenisvolle baselines, beide uit train geschat:
  //  - set-point: "je veert direct terug naar je persoonlijke rebound-piek (~7.3)"
  //  - plat@nadir: "je blijft op het nadir-niveau hangen"
  const setPoint = median(train.map((r) => r.reboundPeakMmol).filter(Number.isFinite))
  const flatNadir = median(train.map((r) => r.byHorizon[0]).filter((v) => v != null))

  console.log(`Bruikbare herstelcurves: ${rows.length}  (train ${train.length} -> test ${test.length}, oudste->nieuwste)`)
  console.log(`Baselines: set-point=${fmt(setPoint)} mmol, plat@nadir=${fmt(flatNadir)} mmol`)
  console.log('\nOUT-OF-SAMPLE forecast-fout + band-kalibratie:')
  console.log('  horizon | profiel | OOS-MAE | binnen p10-p90 | MAE set-point | MAE plat@nadir')
  for (const h of EVAL_HORIZONS) {
    const p = byMinute.get(h)
    const actuals = test.map((r) => r.byHorizon[h]).filter((v) => v != null)
    if (!p || !actuals.length) {
      console.log(`  +${h}m     | n/a`)
      continue
    }
    const maeProfile = meanAbsError(actuals, p.median)
    const within = actuals.filter((v) => v >= p.p10 && v <= p.p90).length
    const coverage = (100 * within) / actuals.length
    console.log(
      `  +${String(h).padStart(2)}m     |  ${fmt(p.median)}   |  ${fmt(maeProfile)}  |  ${coverage.toFixed(0)}% (n=${actuals.length})  |  ${fmt(meanAbsError(actuals, setPoint))}         |  ${fmt(meanAbsError(actuals, flatNadir))}`,
    )
  }
  console.log('\n  Lezen: OOS-MAE moet beide baselines verslaan; dekking p10-p90 idealiter ~80% (goed gekalibreerde band).')
}

async function main() {
  const selfTest = process.argv.includes('--self-test')
  const { episodes, entries } = selfTest ? syntheticReboundData(40) : await loadFromMongo()
  evaluate(episodes, entries)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[rebound-eval] mislukt: ${err && err.message ? err.message : err}`)
    process.exit(1)
  })
}
