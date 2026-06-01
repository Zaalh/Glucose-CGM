// Bouwt de canonieke `reactive_hypo_episodes` collection uit Nightscout-entries.
//
// Dunne I/O-laag rond de pure episode-builder (scripts/lib/episode-builder.mjs),
// zodat live, deze builder en de backtest dezelfde episode-logica delen.
//
// Draaien (in het compose-netwerk, mongo is daar bereikbaar op service-naam):
//   docker compose -f docker-compose.nightscout.yml --profile libre \
//     run --rm libreview-sync node scripts/build-reactive-hypo-episodes.mjs
//
// Of via npm: npm run episodes:build

import { MongoClient } from 'mongodb'
import { buildEpisodes, outcomeHistogram } from './lib/episode-builder.mjs'

const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://nightscout-mongo:27017/nightscout'
const MAX_ENTRIES = Number(process.env.EPISODE_MAX_ENTRIES ?? 200_000)

// Stabiele sleutel per episode zodat herhaald draaien upsert i.p.v. dupliceert.
function episodeKey(ep) {
  return `${ep.peakAt}|${ep.nadirAt}`
}

async function main() {
  const client = new MongoClient(MONGO_URI)
  await client.connect()
  try {
    const db = client.db()

    const entries = await db
      .collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true } }, { projection: { _id: 0, date: 1, dateString: 1, sgv: 1 } })
      .sort({ date: 1 })
      .limit(MAX_ENTRIES)
      .toArray()

    if (entries.length < 4) {
      console.log(JSON.stringify({ ok: false, reason: 'te weinig entries', entries: entries.length }))
      return
    }

    const episodes = buildEpisodes(entries)
    const coll = db.collection('reactive_hypo_episodes')

    await coll.createIndex({ start: 1 })
    await coll.createIndex({ outcome: 1, peakMmol: 1 })
    await coll.createIndex({ 'featureVector.peakMmol': 1 })
    await coll.createIndex({ 'featureVector.dropFromPeakMmol': 1 })
    await coll.createIndex({ episodeKey: 1 }, { unique: true })

    const now = new Date().toISOString()
    let upserted = 0
    for (const ep of episodes) {
      const key = episodeKey(ep)
      await coll.updateOne(
        { episodeKey: key },
        {
          $set: { ...ep, episodeKey: key, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      )
      upserted += 1
    }

    const hist = outcomeHistogram(episodes)
    const examples = episodes
      .filter((e) => e.outcome === 'hypo' || e.outcome === 'near_hypo')
      .slice(0, 3)
      .map((e) => ({
        peakMmol: e.peakMmol,
        nadirMmol: e.nadirMmol,
        dropFromPeakMmol: e.dropFromPeakMmol,
        minutesPeakToNadir: e.minutesPeakToNadir,
        outcome: e.outcome,
        peakAt: e.peakAt,
      }))

    console.log(
      JSON.stringify(
        {
          ok: true,
          scannedEntries: entries.length,
          episodes: episodes.length,
          upserted,
          outcomes: hist,
          examples,
          collection: 'reactive_hypo_episodes',
        },
        null,
        2,
      ),
    )
  } finally {
    await client.close().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error(`[episodes] mislukt: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
