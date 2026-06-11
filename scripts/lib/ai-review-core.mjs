// Gedeelde AI-review kernlogica, gebruikt door zowel de CLI (scripts/ai-review.mjs)
// als de HTTP-server (scripts/libreview-nightscout-sync.mjs).
//
// Ollama Cloud ondersteunt geen strikte structured outputs (JSON-schema), maar wel
// JSON-mode via response_format:{type:'json_object'}. Daarom: lage temperature,
// schema in de prompt benoemd, en bij ongeldige JSON eenmalig opnieuw proberen.
import { aiRouterConfigured, callAiRouter, readAiRouterConfig } from './ai-router.mjs'

export const DEFAULT_LIMIT = 24
const CONFIDENCE = new Set(['low', 'medium', 'high'])

// Past een model-override toe op alle providers, zodat per run een ander
// (Ollama-cloud) model gekozen kan worden zonder de env aan te passen.
export function resolveAiRouterConfig(modelOverride) {
  const aiRouter = readAiRouterConfig()
  const model = String(modelOverride ?? '').trim()
  if (model) {
    aiRouter.providers = aiRouter.providers.map((p) => ({ ...p, model }))
  }
  return aiRouter
}

export { aiRouterConfigured }

export function reviewLimit(rawLimit) {
  return Math.max(1, Math.min(100, Number(rawLimit ?? DEFAULT_LIMIT)))
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

// Compacte weergave van gebruikersfeedback. Sluit de lus: de AI weet wat de
// gebruiker eerder bevestigde (confirmed/feels_hypo/fingerstick) of ontkende
// (false_alarm), zodat observaties persoonlijk en cumulatief worden (roadmap 10.1).
function compactFeedback(f) {
  return {
    createdAt: f.createdAt ?? null,
    type: f.type ?? null,
    note: f.note ? String(f.note).slice(0, 200) : null,
    relatedEntryIdentifier: f.relatedEntryIdentifier ?? null,
    glucoseMmol: f.relatedEntryMmol ?? null,
    riskAtFeedback: f.riskAtFeedback ?? null,
  }
}

const SCHEMA_HINT =
  '{"observations":[{"scope":"model_review","summary":"...","hypothesis":"...","confidence":"low|medium|high","needsUserConfirmation":false}],"questions":[{"question":"...","reason":"...","relatedEntryIdentifier":null}]}'

function systemPrompt() {
  return [
    'Je analyseert CGM hypo-voorspellingen voor een single-user monitor.',
    'Schrijf ALLE tekst (summary, hypothesis, question, reason) in het Nederlands.',
    'Je mag NOOIT live alarmbeslissingen nemen, drempels aanpassen of medisch advies geven.',
    'Geef alleen korte uitleg, hypotheses en maximaal drie nuttige vragen voor latere gebruikersfeedback.',
    'Baseer je alleen op de meegegeven samenvatting. Wees voorzichtig bij weinig data.',
    'Gebruik de meegegeven gebruikersfeedback om je hypotheses te verfijnen: feedback',
    '"confirmed"/"feels_hypo"/"fingerstick_confirmed" bevestigt een echte dip; "false_alarm"',
    'betekent dat een waarschuwing onterecht was; "ate_now" betekent dat de gebruiker ingreep.',
    'Stel geen vragen die de feedback al beantwoordt.',
    'Antwoord UITSLUITEND met geldige JSON, zonder extra tekst, codeblokken of commentaar.',
    `Gebruik exact deze structuur: ${SCHEMA_HINT}`,
    'confidence is low, medium of high. Gebruik meestal low/medium.',
  ].join('\n')
}

function userPrompt(snapshots, feedback) {
  return JSON.stringify({
    task: 'Vat recente CGM prediction_snapshots samen voor ai_observations en ai_questions, rekening houdend met eerdere gebruikersfeedback.',
    constraints: {
      noAlarmDecision: true,
      noThresholdChanges: true,
      noMedicalAdvice: true,
      maxObservations: 5,
      maxQuestions: 3,
    },
    recentUserFeedback: feedback.map(compactFeedback),
    snapshots: snapshots.map(compactSnapshot),
  })
}

// Roept de AI-router aan en parseert JSON. Bij ongeldige JSON: eenmalig opnieuw
// proberen met een expliciete correctie-instructie (Ollama Cloud kan geen schema
// afdwingen, dus we leunen op prompt + retry).
async function callChat(aiRouter, snapshots, feedback) {
  const baseMessages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userPrompt(snapshots, feedback) },
  ]

  let result = await callAiRouter(aiRouter, {
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: baseMessages,
  })

  try {
    return { provider: result.provider, model: result.model, parsed: JSON.parse(result.content) }
  } catch {
    // Retry: geef de vorige (ongeldige) output terug met de opdracht om alsnog
    // uitsluitend geldige JSON volgens het schema te produceren.
    result = await callAiRouter(aiRouter, {
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        ...baseMessages,
        { role: 'assistant', content: String(result.content).slice(0, 4000) },
        {
          role: 'user',
          content: `Je vorige antwoord was geen geldige JSON. Geef nu UITSLUITEND geldige JSON volgens dit schema, niets anders: ${SCHEMA_HINT}`,
        },
      ],
    })
    try {
      return { provider: result.provider, model: result.model, parsed: JSON.parse(result.content) }
    } catch {
      throw new Error(`AI-provider ${result.provider} gaf geen geldige JSON terug (na retry).`)
    }
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

// Draait één AI-review. `db` is een verbonden MongoDB Db-handle; de aanroeper
// beheert de connectie. Schrijft alleen weg als dryRun false is.
export async function runAiReview({ db, aiRouter, dryRun = false, force = false, limit } = {}) {
  if (!aiRouterConfigured(aiRouter)) {
    return {
      ok: true,
      skipped: true,
      reason: 'Geen AI-provider geconfigureerd; zet AI_ROUTER_PROVIDERS met AI_<PROVIDER>_* of legacy AI_CHAT_*.',
    }
  }

  const snapshots = await db.collection('prediction_snapshots')
    .find(force ? {} : { risk: { $in: ['watch', 'high', 'urgent'] } }, { projection: recentSnapshotProjection() })
    .sort({ createdAt: -1 })
    .limit(reviewLimit(limit))
    .toArray()

  if (!snapshots.length) {
    return { ok: true, skipped: true, reason: 'Geen relevante recente snapshots.' }
  }

  // Recente gebruikersfeedback meenemen (roadmap 10.1: feedback-lus sluiten).
  const feedback = await db.collection('user_feedback')
    .find({}, { projection: { createdAt: 1, type: 1, note: 1, relatedEntryIdentifier: 1, relatedEntryMmol: 1, riskAtFeedback: 1 } })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray()

  const ai = await callChat(aiRouter, snapshots, feedback)
  const source = sourceName(ai)
  const now = new Date().toISOString()
  const observations = Array.isArray(ai.parsed?.observations)
    ? ai.parsed.observations.map((o) => cleanObservation(o, now, source)).filter((o) => o.summary || o.hypothesis).slice(0, 5)
    : []
  const questions = Array.isArray(ai.parsed?.questions)
    ? ai.parsed.questions.map((q) => cleanQuestion(q, now, source)).filter((q) => q.question).slice(0, 3)
    : []

  if (!dryRun) {
    if (observations.length) await db.collection('ai_observations').insertMany(observations)
    if (questions.length) await db.collection('ai_questions').insertMany(questions)
  }

  return { ok: true, dryRun, provider: ai.provider, model: ai.model, observations, questions }
}
