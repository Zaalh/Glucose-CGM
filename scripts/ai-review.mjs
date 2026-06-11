import { MongoClient } from 'mongodb'
import { aiRouterConfigured, callAiRouter, readAiRouterConfig } from './lib/ai-router.mjs'

const DEFAULT_MONGO_URI = 'mongodb://nightscout-mongo:27017/nightscout'
const DEFAULT_LIMIT = 24

const CONFIDENCE = new Set(['low', 'medium', 'high'])

function readConfig() {
  return {
    mongoUri: process.env.MONGODB_URI ?? DEFAULT_MONGO_URI,
    aiRouter: readAiRouterConfig(),
    limit: Math.max(1, Math.min(100, Number(process.env.AI_REVIEW_LIMIT ?? DEFAULT_LIMIT))),
    dryRun: process.argv.includes('--dry-run'),
    force: process.argv.includes('--force'),
  }
}

function recentSnapshotProjection() {
  return {
    _id: 1,
    createdAt: 1,
    entryIdentifier: 1,
    currentMmol: 1,
    risk: 1,
    riskScore: 1,
    reasons: 1,
    predictedMmol: 1,
    probabilities: 1,
    modelVersion: 1,
    legacyRisk: 1,
    legacyScore: 1,
    shadowRisk: 1,
    shadowScore: 1,
    shadowConfidence: 1,
    shadowReasons: 1,
    shadowTuned: 1,
    features: 1,
    pattern: 1,
  }
}

function compactSnapshot(s) {
  return {
    id: String(s._id),
    createdAt: s.createdAt,
    entryIdentifier: s.entryIdentifier ?? null,
    currentMmol: s.currentMmol ?? null,
    risk: s.risk ?? null,
    riskScore: s.riskScore ?? null,
    reasons: Array.isArray(s.reasons) ? s.reasons.slice(0, 8) : [],
    predictedMmol: s.predictedMmol ?? null,
    probabilities: s.probabilities ?? null,
    modelVersion: s.modelVersion ?? null,
    v2: {
      risk: s.shadowRisk ?? null,
      score: s.shadowScore ?? null,
      confidence: s.shadowConfidence ?? null,
      reasons: Array.isArray(s.shadowReasons) ? s.shadowReasons.slice(0, 8) : [],
      tuned: Boolean(s.shadowTuned),
    },
    features: s.features
      ? {
          timeOfDay: s.features.timeOfDay ?? null,
          weekday: s.features.weekday ?? null,
          rate10m: s.features.rate10m ?? null,
          blendedRate: s.features.blendedRate ?? null,
          peakMmol120m: s.features.peakMmol120m ?? null,
          minutesSincePeak: s.features.minutesSincePeak ?? null,
          dropFromPeakMmol: s.features.dropFromPeakMmol ?? null,
          mealOnset: Boolean(s.features.mealOnset),
          recoverySignal: Boolean(s.features.recoverySignal),
          isBottoming: Boolean(s.features.isBottoming),
        }
      : null,
    pattern: s.pattern
      ? {
          similarEpisodeCount: s.pattern.similarEpisodeCount ?? null,
          similarHypoCount: s.pattern.similarHypoCount ?? null,
          similarHypoRatio: s.pattern.similarHypoRatio ?? null,
          patternNadirMmol: s.pattern.patternNadirMmol ?? null,
          curveMatchCount: s.pattern.curveMatchCount ?? null,
          curveHypoRatio: s.pattern.curveHypoRatio ?? null,
          weekdayRiskHigh: Boolean(s.pattern.weekdayRiskHigh),
        }
      : null,
  }
}

function systemPrompt() {
  return [
    'Je analyseert CGM hypo-voorspellingen voor een single-user monitor.',
    'Je mag NOOIT live alarmbeslissingen nemen, drempels aanpassen of medisch advies geven.',
    'Geef alleen korte uitleg, hypotheses en maximaal drie nuttige vragen voor latere gebruikersfeedback.',
    'Baseer je alleen op de meegegeven samenvatting. Wees voorzichtig bij weinig data.',
    'Antwoord strikt als JSON met keys: observations, questions.',
    'observations: array van objecten {scope, summary, hypothesis, confidence, needsUserConfirmation}.',
    'questions: array van objecten {question, reason, relatedEntryIdentifier}.',
    'confidence is low, medium of high. Gebruik meestal low/medium.',
  ].join('\n')
}

function userPrompt(snapshots) {
  return JSON.stringify({
    task: 'Vat recente CGM prediction_snapshots samen voor ai_observations en ai_questions.',
    constraints: {
      noAlarmDecision: true,
      noThresholdChanges: true,
      noMedicalAdvice: true,
      maxObservations: 5,
      maxQuestions: 3,
    },
    snapshots: snapshots.map(compactSnapshot),
  })
}

async function callChat(config, snapshots) {
  const result = await callAiRouter(config.aiRouter, {
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userPrompt(snapshots) },
    ],
  })

  try {
    return {
      provider: result.provider,
      model: result.model,
      parsed: JSON.parse(result.content),
    }
  } catch {
    throw new Error(`AI-provider ${result.provider} gaf geen geldige JSON terug.`)
  }
}

function sourceName(aiResult) {
  const provider = aiResult?.provider ? String(aiResult.provider).slice(0, 60) : 'unknown'
  return `ai-router:${provider}`
}

function cleanObservation(raw, now, source) {
  const confidence = CONFIDENCE.has(raw?.confidence) ? raw.confidence : 'low'
  return {
    createdAt: now,
    source,
    scope: ['episode', 'day', 'week', 'model_review'].includes(raw?.scope) ? raw.scope : 'model_review',
    relatedEventIds: Array.isArray(raw?.relatedEventIds) ? raw.relatedEventIds.slice(0, 10) : [],
    summary: String(raw?.summary || '').slice(0, 500),
    hypothesis: String(raw?.hypothesis || '').slice(0, 800),
    confidence,
    needsUserConfirmation: Boolean(raw?.needsUserConfirmation),
    acceptedByUser: null,
  }
}

function cleanQuestion(raw, now, source) {
  return {
    createdAt: now,
    source,
    question: String(raw?.question || '').slice(0, 300),
    reason: String(raw?.reason || '').slice(0, 500),
    relatedEntryIdentifier: raw?.relatedEntryIdentifier ? String(raw.relatedEntryIdentifier).slice(0, 200) : null,
    relatedEntryId: null,
    relatedEventId: null,
    answeredAt: null,
    answer: null,
  }
}

async function main() {
  const config = readConfig()
  if (!aiRouterConfigured(config.aiRouter)) {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: 'Geen AI-provider geconfigureerd; zet AI_ROUTER_PROVIDERS met AI_<PROVIDER>_* of legacy AI_CHAT_*.',
    }))
    return
  }

  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const db = client.db()
    const snapshots = await db.collection('prediction_snapshots')
      .find(config.force ? {} : { risk: { $in: ['watch', 'high', 'urgent'] } }, { projection: recentSnapshotProjection() })
      .sort({ createdAt: -1 })
      .limit(config.limit)
      .toArray()

    if (!snapshots.length) {
      console.log(JSON.stringify({ ok: true, skipped: true, reason: 'Geen relevante recente snapshots.' }))
      return
    }

    const ai = await callChat(config, snapshots)
    const source = sourceName(ai)
    const now = new Date().toISOString()
    const observations = Array.isArray(ai.parsed?.observations)
      ? ai.parsed.observations.map((o) => cleanObservation(o, now, source)).filter((o) => o.summary || o.hypothesis).slice(0, 5)
      : []
    const questions = Array.isArray(ai.parsed?.questions)
      ? ai.parsed.questions.map((q) => cleanQuestion(q, now, source)).filter((q) => q.question).slice(0, 3)
      : []

    if (config.dryRun) {
      console.log(JSON.stringify({ ok: true, dryRun: true, provider: ai.provider, model: ai.model, observations, questions }, null, 2))
      return
    }

    if (observations.length) await db.collection('ai_observations').insertMany(observations)
    if (questions.length) await db.collection('ai_questions').insertMany(questions)
    console.log(JSON.stringify({ ok: true, provider: ai.provider, model: ai.model, observations: observations.length, questions: questions.length }))
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, message: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
