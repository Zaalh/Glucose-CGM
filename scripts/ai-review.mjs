import { MongoClient } from 'mongodb'
import { aiRouterConfigured, resolveAiRouterConfig, runAiReview } from './lib/ai-review-core.mjs'

const DEFAULT_MONGO_URI = 'mongodb://nightscout-mongo:27017/nightscout'

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
    const result = await runAiReview({ db: client.db(), aiRouter, dryRun, force, limit })

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
