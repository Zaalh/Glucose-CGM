import { MongoClient } from 'mongodb'
import { aiRouterConfigured, resolveAiRouterConfig, runAiReview } from './lib/ai-review-core.mjs'

const DEFAULT_MONGO_URI = 'mongodb://nightscout-mongo:27017/nightscout'
// CLI gelijktrekken met de server-review (§21 #5): haal dezelfde AGP-verrijking
// (stats + episodes) op via de bestaande HTTP-endpoints van de draaiende server, zodat
// `npm run ai:review` dezelfde verrijkte review draait zonder getAiStats/getAiEpisodes uit
// het server-bestand te kopiëren. Onbereikbaar → nette fallback naar de dunne review.
const DEFAULT_SERVER_URL = 'http://localhost:8787'

async function fetchReviewEnrichment(baseUrl) {
  try {
    const [statsRes, epsRes] = await Promise.all([
      fetch(`${baseUrl}/ai-review/stats?days=14`),
      fetch(`${baseUrl}/ai-review/episodes?limit=20&days=14`),
    ])
    if (!statsRes.ok || !epsRes.ok) return null
    const statsJson = await statsRes.json()
    const epsJson = await epsRes.json()
    return {
      stats: statsJson && statsJson.ok !== false ? statsJson : null,
      episodes: epsJson && Array.isArray(epsJson.episodes) ? epsJson.episodes : [],
    }
  } catch {
    return null
  }
}

function readCliArg(name) {
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const idx = process.argv.indexOf(`--${name}`)
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1]
  }
  return ''
}

async function main() {
  const mongoUri = process.env.MONGODB_URI ?? DEFAULT_MONGO_URI
  // --model overschrijft het model van alle providers, zodat je per run een
  // ander Ollama-cloud model kunt kiezen zonder de env aan te passen.
  const aiRouter = resolveAiRouterConfig(readCliArg('model'))
  const dryRun = process.argv.includes('--dry-run')
  const force = process.argv.includes('--force')
  const limit = process.env.AI_REVIEW_LIMIT

  // Vroege exit zonder Mongo-connectie als er geen AI-provider is.
  if (!aiRouterConfigured(aiRouter)) {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: 'Geen AI-provider geconfigureerd; zet AI_ROUTER_PROVIDERS met AI_<PROVIDER>_* of legacy AI_CHAT_*.',
    }))
    return
  }

  let client = null
  try {
    client = new MongoClient(mongoUri)
    await client.connect()
    // Verrijking ophalen van de server (zelfde context als de knop/loop); lukt dat niet,
    // dan draait de review dunner op snapshots/feedback (stats=null, episodes=[]).
    const serverUrl = process.env.AI_REVIEW_SERVER_URL ?? DEFAULT_SERVER_URL
    const enrichment = await fetchReviewEnrichment(serverUrl)
    if (!enrichment) console.error(`[ai-review] geen server-verrijking via ${serverUrl}; dunne review (snapshots/feedback).`)
    const result = await runAiReview({
      db: client.db(), aiRouter, dryRun, force, limit,
      stats: enrichment?.stats ?? null,
      episodes: enrichment?.episodes ?? [],
    })

    if (result.skipped) {
      console.log(JSON.stringify({ ok: true, skipped: true, reason: result.reason }))
      return
    }
    if (dryRun) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    console.log(JSON.stringify({
      ok: true,
      provider: result.provider,
      model: result.model,
      observations: result.observations.length,
      questions: result.questions.length,
    }))
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, message: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
