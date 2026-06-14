// Eenmalige dedup-migratie voor `reactive_hypo_episodes`.
//
// Achtergrond: tot de fix gebruikte de builder `episodeKey = peakAt|nadirAt`.
// Omdat de nadir dieper/later verschuift terwijl een live daling nog loopt,
// kreeg elke tussenstand van dezelfde daling een eigen sleutel → meerdere
// documenten met identieke peakAt (de "dips" die 3x dezelfde piek toonden).
// De builder ankert nu op peakAt alleen; dit script ruimt de bestaande dubbelen op.
//
// Per peakAt-groep:
//   - survivor = de volledig-ontwikkelde episode: diepste nadir (laagste nadirMmol),
//     bij gelijke nadir de meest recent geüpdatete (updatedAt).
//   - feedback van alle duplicaten wordt samengevoegd op de survivor.
//   - createdAt = vroegste van de groep.
//   - episodeKey wordt herschreven naar het nieuwe formaat (peakAt).
//   - overige duplicaten worden verwijderd.
//
// Standaard DRY-RUN (toont alleen wat er zou gebeuren). Echt schrijven: voeg --apply toe.
//
// Draaien (in het compose-netwerk):
//   docker compose -f docker-compose.nightscout.yml --profile libre \
//     run --rm libreview-sync node scripts/dedup-reactive-hypo-episodes.mjs --apply

import { MongoClient } from 'mongodb'

const MONGO_URI = process.env.MONGODB_URI ?? 'mongodb://nightscout-mongo:27017/nightscout'
const APPLY = process.argv.includes('--apply')

// Kies de survivor binnen één peakAt-groep: diepste nadir, tie-break op nieuwste updatedAt.
function pickSurvivor(docs) {
  return docs.slice().sort((a, b) => {
    const na = Number(a.nadirMmol)
    const nb = Number(b.nadirMmol)
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  })[0]
}

function earliest(values) {
  return values.filter(Boolean).sort()[0] ?? null
}

async function main() {
  const client = new MongoClient(MONGO_URI)
  await client.connect()
  try {
    const coll = client.db().collection('reactive_hypo_episodes')

    // Groepen met meer dan één document per peakAt.
    const groups = await coll.aggregate([
      { $group: { _id: '$peakAt', count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray()

    const summary = { dupGroups: groups.length, docsToDelete: 0, docsToKeep: 0, examples: [] }

    for (const g of groups) {
      const docs = await coll.find({ _id: { $in: g.ids } }).toArray()
      const survivor = pickSurvivor(docs)
      const losers = docs.filter((d) => !d._id.equals(survivor._id))

      // Feedback samenvoegen + vroegste createdAt behouden.
      const mergedFeedback = docs.flatMap((d) => Array.isArray(d.feedback) ? d.feedback : [])
      const createdAt = earliest(docs.map((d) => d.createdAt))

      summary.docsToKeep += 1
      summary.docsToDelete += losers.length
      if (summary.examples.length < 8) {
        summary.examples.push({
          peakAt: g._id,
          keptNadirMmol: survivor.nadirMmol,
          removedNadirMmol: losers.map((d) => d.nadirMmol),
        })
      }

      if (APPLY) {
        await coll.updateOne(
          { _id: survivor._id },
          {
            $set: {
              episodeKey: g._id,
              feedback: mergedFeedback,
              ...(createdAt ? { createdAt } : {}),
            },
          },
        )
        await coll.deleteMany({ _id: { $in: losers.map((d) => d._id) } })
      }
    }

    console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', ...summary }, null, 2))
  } finally {
    await client.close().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error(`[dedup] mislukt: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
