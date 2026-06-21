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
// Minimale datadekking (§21 W5) waaronder stats te mager zijn om de review op te
// laten draaien bij afwezigheid van snapshots/episodes.
const COVERAGE_MIN_PCT = 10
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
          curveHypoCount: s.pattern.curveHypoCount ?? null,
          curveHypoRatio: s.pattern.curveHypoRatio ?? null,
          weekdayRiskHigh: Boolean(s.pattern.weekdayRiskHigh),
        }
      : null,
  }
}

// Compacte AGP-samenvatting voor de observatie-review (§21). Principe: de LLM
// narreert, rekent niet — alle waarden komen deterministisch uit getAiStats.
// Eenheid-in-sleutel + TBR-first (de hoofdmetric bij reactieve hypo zonder insuline).
// `heatmap`/`perWeekday`/`gmi` en de per-uur-percentielen worden bewust weggelaten om
// het token-budget te bewaken; `perHour` wordt gereduceerd tot {hour, lowPct} (precies
// wat "wanneer dip ik" nodig heeft).
function compactStats(stats) {
  if (!stats) return null
  const perHourLowPct = Array.isArray(stats.perHour)
    ? stats.perHour.filter((p) => p && p.n).map((p) => ({ hour: p.hour, lowPct: p.lowPct }))
    : []
  return {
    window_days: stats.window?.days ?? null,
    coverage_pct: stats.coveragePct ?? null,
    // TBR-first: tijd onder 3.9 en 3.0 is de hoofdmetric voor deze use-case.
    'tbr_3.9_pct': stats.tbr ?? null,
    'tbr_3.0_pct': stats.veryLow ?? null,
    'tir_3.9_10_pct': stats.tir ?? null,
    'tar_10_pct': stats.tar ?? null,
    mean_mmol: stats.mean ?? null,
    cv_pct: stats.cv ?? null,
    lows_count: stats.lows?.count ?? null,
    trend: stats.trend ?? null,
    // De reactieve-episode-digest is de meest use-case-relevante samenvatting.
    reactive: stats.reactive ?? null,
    perHourLowPct,
  }
}

// Het kwetsbaarste uur (hoogste lowPct met genoeg metingen) als structureel feit,
// i.p.v. de al-genarreerde pattern-card-string.
function vulnerableWindow(stats) {
  const perHour = Array.isArray(stats?.perHour) ? stats.perHour : []
  const worst = perHour.filter((p) => p && p.n >= 10).sort((a, b) => b.lowPct - a.lowPct)[0]
  return worst ? { hour: worst.hour, lowPct: worst.lowPct } : null
}

// Compacte episode zonder ruwe `readings`: alleen de duiding-relevante metrics.
function compactEpisode(e) {
  return {
    peakAt: e.peakAt ?? null,
    peakMmol: e.peakMmol ?? null,
    nadirMmol: e.nadirMmol ?? null,
    minutesPeakToNadir: e.minutesPeakToNadir ?? null,
    fallRateMmolPerMin: e.fallRateMmolPerMin ?? null,
    severity: e.severity ?? null,
    shape: e.shape ?? null,
    timeOfDayBucket: e.timeOfDayBucket ?? null,
    recoveryMinutes: e.recoveryMinutes ?? null,
    outcome: e.outcome ?? null,
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
  '{"observations":[{"scope":"model_review","summary":"...","hypothesis":"...","confidence":"low|medium|high","needsUserConfirmation":false,"evidence":["welke metric/episode/feedback gebruikt is"]}],"questions":[{"question":"...","reason":"...","relatedEntryIdentifier":null}]}'

// Profielneutrale, data-gegronde guardrail — werkt voor ELKE gebruiker (met of zonder
// diabetes/insuline). De dataset bevat alleen glucose + afgeleiden, geen behandel-
// of medicatie-info; zonder deze regel valt het model terug op diabetes-aannames en
// schrijft het dips ten onrechte toe aan insuline/basaal. Niets over de specifieke
// gebruiker hard-coderen, juist verbieden om context te verzinnen die er niet is.
const DATA_GROUNDING_RULE =
  'Verklaar patronen UITSLUITEND uit wat in de data zit (glucosewaarden en -timing, curvevorm, episodes, gelogde events en feedback). Veronderstel GEEN klinische context die niet is meegegeven — zoals insuline, basaal/bolus, medicatie, diabetestype of behandelregime; die informatie zit niet in deze dataset. Behandel zulke factoren als onbekend en gebruik ze niet als verklaring of als onderwerp van een vraag.'

function systemPrompt() {
  return [
    'Je analyseert CGM hypo-voorspellingen voor een single-user monitor.',
    'Schrijf ALLE tekst (summary, hypothesis, question, reason) in het Nederlands.',
    'Je mag NOOIT live alarmbeslissingen nemen, drempels aanpassen of medisch advies geven.',
    'Geef alleen korte uitleg, hypotheses en maximaal drie nuttige vragen voor latere gebruikersfeedback.',
    'Baseer je alleen op de meegegeven samenvatting. Wees voorzichtig bij weinig data.',
    DATA_GROUNDING_RULE,
    'Gebruik agpSummary (TBR/TIR/CV/perHourLowPct), vulnerableWindow en recentEpisodes om week- en dagpatronen te benoemen, niet alleen losse snapshots.',
    'Herbereken geen getallen en bereken geen nieuwe statistieken; citeer uitsluitend de meegegeven waarden.',
    'Vul per observatie het veld "evidence" met de concrete metric/episode/feedback waarop je je baseert.',
    'Bij lage coverage_pct of weinig episodes: formuleer expliciet voorzichtig en benoem dat conclusies onzeker zijn.',
    // Klinische guardrails (medische review): voorkom dat lage CGM-waarden ten onrechte
    // als bevestigde (reactieve) hypo's worden gepresenteerd. Het model heeft de
    // ontkrachtende velden in `reactive` al; deze regels dwingen het ze te wegen.
    'Datakwaliteit-weging: lage waarden met snel herstel (reactive.medianRecoveryMin laag, bv. < ~10 min), losse punten (byShape.isolated_point, artefactFlags.singlePoint/possibleCompression) of hoge reactive.pctPoorQuality zijn mogelijk sensorartefact (o.a. compression-low in slaapuren). Benoem ze als "mogelijk artefact", niet als bevestigde daling, en zet needsUserConfirmation op true.',
    'Nachtelijke lows (perHourLowPct/vulnerableWindow tussen ~00:00–08:00) zijn tijdens slaap extra artefactgevoelig. Presenteer een nachtelijk "kwetsbaar venster" niet als gedragsmatig daalrisico zonder die kanttekening.',
    'Reactieve hypoglykemie is per definitie postprandiaal. Als reactive.pctPostprandialCandidate ≈ 0 is, gebruik het label "reactieve hypo" NIET; beschrijf dips dan als mogelijk fysiologisch/nachtelijk of artefact, en stel needsUserConfirmation op true tot fingerprik/symptoom dit bevestigt.',
    'Erken eerst het basisprofiel: een hoge TIR (bv. > ~70%) en lage CV (bv. < ~36%) duiden op een gunstig, stabiel profiel. Noem kleine week-op-week-deltas (trend) pas "verslechtering" als de verandering substantieel is én niet door dekking/artefacten kan komen; anders: "binnen normale variatie".',
    'Markeer een low-patroon alleen als bevestigd risico wanneer recentUserFeedback (feels_hypo/fingerstick_confirmed) of een postprandiale koppeling dat onderbouwt; anders needsUserConfirmation true.',
    'Als je pattern-velden noemt: noem similarEpisodeCount/curveMatchCount "top-matches" of "gebruikte matches", niet het totaal aantal vergelijkbare episodes.',
    'Noem similarHypoCount/curveHypoCount nooit "bevestigde hypo’s"; dit zijn detector-uitkomsten onder 4.5 (hypo/near_hypo), tenzij recentUserFeedback expliciet bevestiging geeft.',
    'Vermeng feature-match en curve-match niet: rapporteer hun counts/ratios apart of kies één bron.',
    'Gebruik de meegegeven gebruikersfeedback om je hypotheses te verfijnen: feedback',
    '"confirmed"/"feels_hypo"/"fingerstick_confirmed" bevestigt een echte dip; "false_alarm"',
    'betekent dat een waarschuwing onterecht was; "ate_now" betekent dat de gebruiker ingreep.',
    'Stel geen vragen die de feedback al beantwoordt.',
    'Antwoord UITSLUITEND met geldige JSON, zonder extra tekst, codeblokken of commentaar.',
    `Gebruik exact deze structuur: ${SCHEMA_HINT}`,
    'confidence is low, medium of high. Gebruik meestal low/medium.',
  ].join('\n')
}

// Payload-volgorde is bewust "lost-in-the-middle"-aware (§21.2.3): de kernsamenvatting
// staat BOVENAAN (hoogste aandacht), de lange detaillijsten in het MIDDEN, en de
// kernopdracht wordt ONDERAAN herhaald (ook hoge aandacht).
function userPrompt(snapshots, feedback, stats, episodes) {
  return JSON.stringify({
    // BOVEN — kernsamenvatting.
    agpSummary: compactStats(stats),
    vulnerableWindow: vulnerableWindow(stats),
    highToLowContext: stats?.highToLowContext ?? null,
    // MIDDEN — detaillijsten.
    recentEpisodes: Array.isArray(episodes) ? episodes.slice(0, 5).map(compactEpisode) : [],
    snapshots: snapshots.map(compactSnapshot),
    recentUserFeedback: feedback.map(compactFeedback),
    patternSemantics: {
      similarEpisodeCount: 'Aantal gebruikte top-matches uit de similarity-laag; dit is begrensd en geen totaal aantal historische episodes.',
      similarHypoCount: 'Aantal top-matches met detector-uitkomst hypo of near_hypo; dit zijn geen door gebruiker bevestigde hypo’s.',
      similarHypoRatio: 'Gewogen fractie van die top-matches met detector-uitkomst hypo of near_hypo.',
      curveMatchCount: 'Aantal gebruikte top-matches uit curvevorm-matching; dit is begrensd en geen totaal aantal historische episodes.',
      curveHypoCount: 'Aantal curve-top-matches met detector-uitkomst hypo of near_hypo; dit zijn geen door gebruiker bevestigde hypo’s.',
      curveHypoRatio: 'Gewogen fractie van curve-top-matches met detector-uitkomst hypo of near_hypo.',
    },
    constraints: {
      noAlarmDecision: true,
      noThresholdChanges: true,
      noMedicalAdvice: true,
      maxObservations: 5,
      maxQuestions: 3,
    },
    // ONDER — herhaalde kernopdracht als allerlaatste sleutel (§21 F): de positie met
    // de hoogste eind-aandacht (lost-in-the-middle), dus ná de constraints.
    task: 'Benoem week- en dagpatronen op basis van agpSummary, vulnerableWindow en recentEpisodes: wanneer clusteren dips, hoe gedragen piek→dal-episodes zich, en hoe sluit dit aan op recentUserFeedback. Gebruik UITSLUITEND de meegegeven cijfers; herbereken niets.',
  })
}

// §21.5: bouwt de exacte review-prompt (system + user) ZONDER LLM-call, zodat een
// smoke kan controleren dat AGP-stats/episodes + evidence-schema erin zitten.
export function previewReviewPrompt({ snapshots = [], feedback = [], stats = null, episodes = [] } = {}) {
  return { system: systemPrompt(), user: userPrompt(snapshots, feedback, stats, episodes) }
}

// Roept de AI-router aan en parseert JSON. Bij ongeldige JSON: eenmalig opnieuw
// proberen met een expliciete correctie-instructie (Ollama Cloud kan geen schema
// afdwingen, dus we leunen op prompt + retry).
async function callChat(aiRouter, snapshots, feedback, stats, episodes) {
  const baseMessages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userPrompt(snapshots, feedback, stats, episodes) },
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
    // Traceerbaarheid (§17.1/§21.4): welke metric/episode/feedback de claim onderbouwt.
    evidence: Array.isArray(raw?.evidence)
      ? raw.evidence.map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 6)
      : [],
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
export async function runAiReview({ db, aiRouter, dryRun = false, force = false, limit, stats = null, episodes = [] } = {}) {
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

  // §21 W5: verzacht de skip-conditie. Vroeger sloeg de review volledig over zodra er
  // geen risico-snapshots waren (een rustige dag → leeg paneel). Nu draait de review
  // zolang er íets te duiden valt: risico-snapshots, episodes, of bruikbare stats
  // (genoeg datadekking voor een AGP-overzicht).
  const hasEpisodes = Array.isArray(episodes) && episodes.length > 0
  const hasUsableStats = stats && Number(stats.coveragePct) >= COVERAGE_MIN_PCT
  if (!snapshots.length && !hasEpisodes && !hasUsableStats) {
    return { ok: true, skipped: true, reason: 'Geen relevante recente snapshots, episodes of bruikbare stats.' }
  }

  // Recente gebruikersfeedback meenemen (roadmap 10.1: feedback-lus sluiten).
  const feedback = await db.collection('user_feedback')
    .find({}, { projection: { createdAt: 1, type: 1, note: 1, relatedEntryIdentifier: 1, relatedEntryMmol: 1, riskAtFeedback: 1 } })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray()

  const ai = await callChat(aiRouter, snapshots, feedback, stats, episodes)
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
const AI_REPORT_TYPES = new Set(['daily', 'weekly', 'period', 'episode', 'trigger'])

function reportSystemPrompt() {
  return [
    'Je schrijft een kort, feitelijk CGM-overzichtsrapport voor één gebruiker, op basis van diens CGM-data.',
    'Schrijf in het Nederlands. Wees beschrijvend en voorzichtig: GEEN medisch advies, geen voorschriften, geen alarm-/actiebeslissingen.',
    'Gebruik UITSLUITEND de meegegeven cijfers (statistiek, episodes, feedback). Verzin niets en noem geen waarden die er niet staan.',
    DATA_GROUNDING_RULE,
    'Benoem concrete patronen: op welke tijdstippen lows clusteren (uit perHour), piek→dal-gedrag uit de episodes, en mogelijke samenhang met gemelde feedback.',
    'Je mag algemeen bekende, niet-persoonlijke context noemen (bv. dat eiwit/vet vóór koolhydraten de piek vertraagt) maar formuleer dit als observatie, niet als instructie.',
    // Safety guardrail (§17): datadekking bepaalt hoe stellig het rapport mag zijn.
    'Als de datadekking (coveragePct) laag is of er weinig episodes zijn, formuleer dan expliciet voorzichtig en vermeld dat conclusies onzeker zijn.',
    'Antwoord UITSLUITEND met geldige JSON: {"title":"...","body":"..."}. body = 3–6 korte zinnen of bullets in platte tekst (geen markdown-koppen).',
  ].join('\n')
}

function reportUserPrompt({ stats, episodes, feedback, type, context }) {
  return JSON.stringify({
    reportType: type,
    stats: stats || null,
    episodes: Array.isArray(episodes) ? episodes.slice(0, 20) : [],
    recentUserFeedback: Array.isArray(feedback) ? feedback.map(compactFeedback) : [],
    context: context || null,
  })
}

// Genereert één narratief rapport (1 LLM-call) en slaat het op in `ai_reports`.
// stats/episodes/feedback worden door de aanroeper (server) aangeleverd.
export async function runAiReport({ db, aiRouter, stats, episodes = [], feedback = [], type = 'daily', context = null } = {}) {
  if (!aiRouterConfigured(aiRouter)) {
    return { ok: true, skipped: true, reason: 'Geen AI-provider geconfigureerd.' }
  }
  const t = AI_REPORT_TYPES.has(type) ? type : 'daily'
  const messages = [
    { role: 'system', content: reportSystemPrompt() },
    { role: 'user', content: reportUserPrompt({ stats, episodes, feedback, type: t, context }) },
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
    scope: context && context.scope ? context.scope : null,
    contextSnapshot: context || null,
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
    'Je bent een behulpzame assistent die vragen beantwoordt over de CGM-data van één gebruiker.',
    'Schrijf in het Nederlands, kort en concreet.',
    'GEEN medisch advies, geen voorschriften, geen alarm-/actiebeslissingen — de V1/V2-detector blijft de enige alarmbron.',
    'Gebruik de meegegeven datacontext (statistiek, episodes, observaties, feedback) om te antwoorden; verzin geen waarden. Weet je iets niet uit de data, zeg dat eerlijk.',
    DATA_GROUNDING_RULE,
    'Je mag algemeen bekende, niet-persoonlijke context noemen (bv. dat eiwit/vet vóór koolhydraten de piek vertraagt) maar als observatie, niet als instructie.',
    // Safety guardrails (§17): wees minder stellig bij slechte datakwaliteit en verwijs door bij ernst.
    'Benoem onzekerheid expliciet. Als de datakwaliteit/dekking matig of slecht is, formuleer dan voorzichtig ("lijkt op", "mogelijk") en trek geen harde conclusies.',
    'Bij vragen over ernstige of aanhoudende symptomen, flauwvallen, of medische keuzes: geef geen oordeel, maar verwijs naar een arts of spoedhulp.',
  ].join('\n')
}

function chatContext({ stats, episodes, observations, feedback, context }) {
  return 'Datacontext (JSON, alleen ter onderbouwing): ' + JSON.stringify({
    stats: stats || null,
    episodes: Array.isArray(episodes) ? episodes.slice(0, 10) : [],
    recentObservations: Array.isArray(observations)
      ? observations.slice(0, 8).map((o) => ({ summary: o.summary, confidence: o.confidence, createdAt: o.createdAt }))
      : [],
    recentUserFeedback: Array.isArray(feedback) ? feedback.map(compactFeedback) : [],
    context: context || null,
  })
}

// Beantwoordt één chatbericht. `messages` is de (door de client bijgehouden) historie;
// alleen de laatste ~10 user/assistant-berichten worden meegestuurd. Geen opslag.
export async function runAiChat({ aiRouter, messages = [], stats, episodes = [], observations = [], feedback = [], context = null } = {}) {
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
      { role: 'system', content: chatContext({ stats, episodes, observations, feedback, context }) },
      ...history,
    ],
  })
  return { ok: true, provider: result.provider, model: result.model, reply: String(result.content || '') }
}
