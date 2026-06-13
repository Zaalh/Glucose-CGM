// Gedeelde AI-review kernlogica, gebruikt door zowel de CLI (scripts/ai-review.mjs)
// als de HTTP-server (scripts/libreview-nightscout-sync.mjs).
//
// Ollama Cloud ondersteunt geen strikte structured outputs (JSON-schema), maar wel
// JSON-mode via response_format:{type:'json_object'}. Daarom: lage temperature,
// schema in de prompt benoemd, en bij ongeldige JSON eenmalig opnieuw proberen.
import { randomUUID } from 'node:crypto'
import { aiRouterConfigured, callAiRouter, readAiRouterConfig } from './ai-router.mjs'

export const DEFAULT_LIMIT = 24
const CONFIDENCE = new Set(['low', 'medium', 'high'])
// Retentie: oudere observaties/vragen worden bij elke run opgeruimd zodat de
// collecties niet onbegrensd groeien (vooral met de periodieke loop).
const RETENTION_DAYS = Math.max(1, Number(process.env.AI_REVIEW_RETENTION_DAYS ?? 90))

// Indexen één keer per proces aanmaken (createIndex is idempotent). Versnelt de
// `/latest` sort en de retentie-prune naarmate de collecties groeien.
let aiIndexesEnsured = false
async function ensureAiIndexes(db) {
  if (aiIndexesEnsured) return
  await db.collection('ai_observations').createIndex({ createdAt: -1 })
  await db.collection('ai_observations').createIndex({ runId: 1 })
  await db.collection('ai_questions').createIndex({ createdAt: -1 })
  await db.collection('ai_questions').createIndex({ runId: 1 })
  await db.collection('ai_reports').createIndex({ createdAt: -1 })
  await db.collection('ai_reports').createIndex({ type: 1 })
  aiIndexesEnsured = true
}

async function pruneOldAiDocs(db) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString()
  await Promise.all([
    db.collection('ai_observations').deleteMany({ createdAt: { $lt: cutoff } }),
    db.collection('ai_questions').deleteMany({ createdAt: { $lt: cutoff } }),
    db.collection('ai_reports').deleteMany({ createdAt: { $lt: cutoff } }),
  ])
}

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

function cleanObservation(raw, now, source, runId, model) {
  const confidence = CONFIDENCE.has(raw?.confidence) ? raw.confidence : 'low'
  return {
    createdAt: now,
    runId,
    model,
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

function cleanQuestion(raw, now, source, runId, model) {
  return {
    createdAt: now,
    runId,
    model,
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
  const runId = randomUUID()
  const observations = Array.isArray(ai.parsed?.observations)
    ? ai.parsed.observations.map((o) => cleanObservation(o, now, source, runId, ai.model)).filter((o) => o.summary || o.hypothesis).slice(0, 5)
    : []
  const questions = Array.isArray(ai.parsed?.questions)
    ? ai.parsed.questions.map((q) => cleanQuestion(q, now, source, runId, ai.model)).filter((q) => q.question).slice(0, 3)
    : []

  if (!dryRun) {
    await ensureAiIndexes(db)
    if (observations.length) await db.collection('ai_observations').insertMany(observations)
    if (questions.length) await db.collection('ai_questions').insertMany(questions)
    await pruneOldAiDocs(db)
  }

  return { ok: true, dryRun, runId, provider: ai.provider, model: ai.model, observations, questions }
}

// --- Rapporten (C/D): narratief dag-/triggerverslag bovenop de cijfers --------
const AI_REPORT_TYPES = new Set(['daily', 'weekly', 'trigger'])

function reportSystemPrompt() {
  return [
    'Je schrijft een kort, feitelijk CGM-overzichtsrapport voor één gebruiker met reactieve hypoglykemie (geen insuline, geen closed-loop).',
    'Schrijf in het Nederlands. Wees beschrijvend en voorzichtig: GEEN medisch advies, geen voorschriften, geen alarm-/actiebeslissingen.',
    'Gebruik UITSLUITEND de meegegeven cijfers (statistiek, episodes, feedback). Verzin niets en noem geen waarden die er niet staan.',
    'Benoem concrete patronen: op welke tijdstippen lows clusteren (uit perHour), piek→dal-gedrag uit de episodes, en mogelijke samenhang met gemelde feedback.',
    'Je mag algemeen bekende, niet-persoonlijke context noemen (bv. dat eiwit/vet vóór koolhydraten de piek vertraagt) maar formuleer dit als observatie, niet als instructie.',
    // Safety guardrail (§17): datadekking bepaalt hoe stellig het rapport mag zijn.
    'Als de datadekking (coveragePct) laag is of er weinig episodes zijn, formuleer dan expliciet voorzichtig en vermeld dat conclusies onzeker zijn.',
    'Antwoord UITSLUITEND met geldige JSON: {"title":"...","body":"..."}. body = 3–6 korte zinnen of bullets in platte tekst (geen markdown-koppen).',
  ].join('\n')
}

function reportUserPrompt({ stats, episodes, feedback, type }) {
  return JSON.stringify({
    reportType: type,
    stats: stats || null,
    episodes: Array.isArray(episodes) ? episodes.slice(0, 20) : [],
    recentUserFeedback: Array.isArray(feedback) ? feedback.map(compactFeedback) : [],
  })
}

// Genereert één narratief rapport (1 LLM-call) en slaat het op in `ai_reports`.
// stats/episodes/feedback worden door de aanroeper (server) aangeleverd.
export async function runAiReport({ db, aiRouter, stats, episodes = [], feedback = [], type = 'daily' } = {}) {
  if (!aiRouterConfigured(aiRouter)) {
    return { ok: true, skipped: true, reason: 'Geen AI-provider geconfigureerd.' }
  }
  const t = AI_REPORT_TYPES.has(type) ? type : 'daily'
  const messages = [
    { role: 'system', content: reportSystemPrompt() },
    { role: 'user', content: reportUserPrompt({ stats, episodes, feedback, type: t }) },
  ]
  let result = await callAiRouter(aiRouter, { temperature: 0.2, response_format: { type: 'json_object' }, messages })
  let parsed
  try {
    parsed = JSON.parse(result.content)
  } catch {
    result = await callAiRouter(aiRouter, {
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        ...messages,
        { role: 'assistant', content: String(result.content).slice(0, 2000) },
        { role: 'user', content: 'Je vorige antwoord was geen geldige JSON. Geef nu UITSLUITEND {"title":"...","body":"..."}.' },
      ],
    })
    try {
      parsed = JSON.parse(result.content)
    } catch {
      throw new Error(`AI-provider ${result.provider} gaf geen geldige JSON terug (rapport).`)
    }
  }

  const doc = {
    createdAt: new Date().toISOString(),
    runId: randomUUID(),
    model: result.model,
    source: sourceName(result),
    type: t,
    period: stats && stats.window ? stats.window : null,
    stats: stats || null,
    title: String(parsed?.title || 'Rapport').slice(0, 200),
    body: String(parsed?.body || '').slice(0, 4000),
  }
  await ensureAiIndexes(db)
  await db.collection('ai_reports').insertOne(doc)
  await pruneOldAiDocs(db)
  return { ok: true, provider: result.provider, model: result.model, report: doc }
}

// --- Chat: vrije vraag/antwoord gegrond in de data (1 LLM-call per bericht) ----
function chatSystemPrompt() {
  return [
    'Je bent een behulpzame assistent die vragen beantwoordt over de CGM-data van één gebruiker met reactieve hypoglykemie (geen insuline, geen closed-loop).',
    'Schrijf in het Nederlands, kort en concreet.',
    'GEEN medisch advies, geen voorschriften, geen alarm-/actiebeslissingen — de V1/V2-detector blijft de enige alarmbron.',
    'Gebruik de meegegeven datacontext (statistiek, episodes, observaties, feedback) om te antwoorden; verzin geen waarden. Weet je iets niet uit de data, zeg dat eerlijk.',
    'Je mag algemeen bekende, niet-persoonlijke context noemen (bv. dat eiwit/vet vóór koolhydraten de piek vertraagt) maar als observatie, niet als instructie.',
    // Safety guardrails (§17): wees minder stellig bij slechte datakwaliteit en verwijs door bij ernst.
    'Benoem onzekerheid expliciet. Als de datakwaliteit/dekking matig of slecht is, formuleer dan voorzichtig ("lijkt op", "mogelijk") en trek geen harde conclusies.',
    'Bij vragen over ernstige of aanhoudende symptomen, flauwvallen, of medische keuzes: geef geen oordeel, maar verwijs naar een arts of spoedhulp.',
  ].join('\n')
}

function chatContext({ stats, episodes, observations, feedback }) {
  return 'Datacontext (JSON, alleen ter onderbouwing): ' + JSON.stringify({
    stats: stats || null,
    episodes: Array.isArray(episodes) ? episodes.slice(0, 10) : [],
    recentObservations: Array.isArray(observations)
      ? observations.slice(0, 8).map((o) => ({ summary: o.summary, confidence: o.confidence, createdAt: o.createdAt }))
      : [],
    recentUserFeedback: Array.isArray(feedback) ? feedback.map(compactFeedback) : [],
  })
}

// Beantwoordt één chatbericht. `messages` is de (door de client bijgehouden) historie;
// alleen de laatste ~10 user/assistant-berichten worden meegestuurd. Geen opslag.
export async function runAiChat({ aiRouter, messages = [], stats, episodes = [], observations = [], feedback = [] } = {}) {
  if (!aiRouterConfigured(aiRouter)) {
    return { ok: true, skipped: true, reason: 'Geen AI-provider geconfigureerd.' }
  }
  const history = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-10)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }))
  if (!history.length || history[history.length - 1].role !== 'user') {
    const err = new Error('Laatste bericht moet van de gebruiker zijn.')
    err.statusCode = 400
    throw err
  }
  const result = await callAiRouter(aiRouter, {
    temperature: 0.3,
    messages: [
      { role: 'system', content: chatSystemPrompt() },
      { role: 'system', content: chatContext({ stats, episodes, observations, feedback }) },
      ...history,
    ],
  })
  return { ok: true, provider: result.provider, model: result.model, reply: String(result.content || '') }
}
