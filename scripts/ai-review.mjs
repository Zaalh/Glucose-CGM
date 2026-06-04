import { MongoClient } from 'mongodb'

const DEFAULT_MONGO_URI = 'mongodb://nightscout-mongo:27017/nightscout'
const DEFAULT_MODEL = 'gpt-4.1-mini'
const DEFAULT_LIMIT = 24
const DEFAULT_TIMEOUT_MS = 30_000

const CONFIDENCE = new Set(['low', 'medium', 'high'])

function optionalEnv(name) {
  const value = process.env[name] ?? ''
  if (value.includes('example.com') || value.startsWith('your-')) return ''
  return value.trim()
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

function readConfig() {
  return {
    mongoUri: process.env.MONGODB_URI ?? DEFAULT_MONGO_URI,
    apiKey: optionalEnv('AI_CHAT_API_KEY'),
    baseUrl: optionalEnv('AI_CHAT_BASE_URL'),
    model: optionalEnv('AI_CHAT_MODEL') || DEFAULT_MODEL,
    limit: Math.max(1, Math.min(100, Number(process.env.AI_REVIEW_LIMIT ?? DEFAULT_LIMIT))),
    timeoutMs: Math.max(1000, Number(process.env.AI_CHAT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)),
    dryRun: process.argv.includes('--dry-run'),
    force: process.argv.includes('--force'),
  }
}

function configured(config) {
  return Boolean(config.apiKey && config.baseUrl && config.model)
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
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const res = await fetch(`${trimTrailingSlash(config.baseUrl)}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: userPrompt(snapshots) },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`AI chat HTTP ${res.status}: ${text.slice(0, 500)}`)
    }
    const json = await res.json()
    const content = json?.choices?.[0]?.message?.content
    if (!content) throw new Error('AI chat gaf geen message.content terug.')
    return JSON.parse(content)
  } finally {
    clearTimeout(timeout)
  }
}

function cleanObservation(raw, now) {
  const confidence = CONFIDENCE.has(raw?.confidence) ? raw.confidence : 'low'
  return {
    createdAt: now,
    source: 'ai-chat-v1',
    scope: ['episode', 'day', 'week', 'model_review'].includes(raw?.scope) ? raw.scope : 'model_review',
    relatedEventIds: Array.isArray(raw?.relatedEventIds) ? raw.relatedEventIds.slice(0, 10) : [],
    summary: String(raw?.summary || '').slice(0, 500),
    hypothesis: String(raw?.hypothesis || '').slice(0, 800),
    confidence,
    needsUserConfirmation: Boolean(raw?.needsUserConfirmation),
    acceptedByUser: null,
  }
}

function cleanQuestion(raw, now) {
  return {
    createdAt: now,
    source: 'ai-chat-v1',
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
  if (!configured(config)) {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: 'AI_CHAT_API_KEY, AI_CHAT_BASE_URL of AI_CHAT_MODEL ontbreekt; AI-laag staat uit.',
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
    const now = new Date().toISOString()
    const observations = Array.isArray(ai?.observations)
      ? ai.observations.map((o) => cleanObservation(o, now)).filter((o) => o.summary || o.hypothesis).slice(0, 5)
      : []
    const questions = Array.isArray(ai?.questions)
      ? ai.questions.map((q) => cleanQuestion(q, now)).filter((q) => q.question).slice(0, 3)
      : []

    if (config.dryRun) {
      console.log(JSON.stringify({ ok: true, dryRun: true, observations, questions }, null, 2))
      return
    }

    if (observations.length) await db.collection('ai_observations').insertMany(observations)
    if (questions.length) await db.collection('ai_questions').insertMany(questions)
    console.log(JSON.stringify({ ok: true, observations: observations.length, questions: questions.length }))
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, message: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
