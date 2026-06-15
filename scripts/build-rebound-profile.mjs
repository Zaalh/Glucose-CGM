// Offline generator: bouwt het persoonlijke rebound-herstelprofiel uit de
// reactive_hypo_episodes + entries en schrijft het naar
// scripts/rebound-recovery-profile.json. Verandert NIETS live — alleen lezen
// + een artefact wegschrijven (shadow-first, net als het V2-draaiboek).
//
// Draaien (mongo bereikbaar in het compose-netwerk):
//   docker compose -f docker-compose.nightscout.yml --profile libre \
//     run --rm libreview-sync node scripts/build-rebound-profile.mjs
//   (of: npm run rebound:profile)
// Lokaal zonder database (synthetisch):
//   node scripts/build-rebound-profile.mjs --self-test

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MongoClient } from 'mongodb'
import { buildReboundProfile, prepareEntries, syntheticReboundData } from './lib/rebound-profile.mjs'

const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://nightscout-mongo:27017/nightscout'
const MAX_ENTRIES = Number(process.env.EPISODE_MAX_ENTRIES ?? 200_000)
const here = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = join(here, 'rebound-recovery-profile.json')

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

async function main() {
  const selfTest = process.argv.includes('--self-test')
  const { episodes, entries } = selfTest ? syntheticReboundData() : await loadFromMongo()

  const profile = buildReboundProfile(episodes, prepareEntries(entries))

  if (profile.episodesUsed < profile.minSamplesPerHorizon) {
    console.error(
      `[rebound] te weinig bruikbare episodes (${profile.episodesUsed} < ${profile.minSamplesPerHorizon}); profiel niet geschreven.`,
    )
    process.exit(1)
  }

  // Self-test schrijft naar een apart pad zodat het echte artefact niet met
  // synthetische data wordt overschreven.
  const outPath = selfTest ? OUT_PATH.replace(/\.json$/, '.selftest.json') : OUT_PATH
  writeFileSync(outPath, JSON.stringify(profile, null, 2) + '\n')
  console.log(`[rebound] profiel geschreven: ${outPath}`)
  console.log(
    `  episodes=${profile.episodesUsed}  set-point=${profile.setPointMmol} mmol  overshoot>=10mmol=${profile.overshootHighPct}%`,
  )
  console.log('  curve (min: med [p25-p75], n):')
  for (const p of profile.curve) {
    if (p.minute % 15 !== 0) continue
    console.log(`    +${String(p.minute).padStart(2)}m: ${p.median} [${p.p25}-${p.p75}]  n=${p.n}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[rebound] mislukt: ${err && err.message ? err.message : err}`)
    process.exit(1)
  })
}
