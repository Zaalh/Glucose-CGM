import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { MongoClient } from 'mongodb'
import { buildHypoFeatures, cleanGlucoseTimeline } from './lib/hypo-features.mjs'
import { evaluateReactiveHypoRiskV2 } from './lib/reactive-hypo-detector.mjs'
import { patternFromFeatures } from './lib/episode-similarity.mjs'
import { aiRouterConfigured, resolveAiRouterConfig, runAiReview, runAiReport, runAiChat } from './lib/ai-review-core.mjs'
import { buildReactiveHypoEpisodes } from './build-reactive-hypo-episodes.mjs'
import { buildGlucoseEvents } from './lib/glucose-events.mjs'

const LIBRE_API = 'https://api-eu.libreview.io'
const DEFAULT_INTERVAL_SECONDS = 60
// Nominale cadans = sync-poll-interval (default 60s → 1 meting/min). Fallback voor de
// dekkings-noemer wanneer medianIntervalMinutes() niets oplevert. Staat hier (boven de
// top-level await) i.v.m. de module-TDZ in --loop-modus.
const NOMINAL_INTERVAL_MIN = DEFAULT_INTERVAL_SECONDS / 60
const DEFAULT_GRACE_WINDOW_MINUTES = 30
const DEFAULT_RETRY_ATTEMPTS = 3
const DEFAULT_RETRY_BASE_DELAY_MS = 750
const DEFAULT_RETRY_MAX_DELAY_MS = 12_000
const DEFAULT_HTTP_TIMEOUT_MS = 12_000
const DEFAULT_RETRY_JITTER_MS = 300
const HISTORY_PERIOD_MINUTES = 7
const RATE_WINDOWS_MINUTES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 30, 45, 60, 90, 120]
const RATE_MAX_BASELINE_DIFF_MS = 45_000
const MGDL_PER_MMOL = 18.0182
const FORECAST_HORIZONS = [10, 15, 20, 30, 60, 120, 180]
// Vanaf >30 min satureert het rate-effect: glucose keert terug naar baseline,
// dus 120/180 min mag niet puur lineair doorlopen (anders altijd in de clamp).
const RATE_DECAY_TAU = 45
// Similarity-dimensies die offline (episode_vectors) en live identiek zijn.
// maxFallRate bewust weggelaten: offline uit 1-min diffs (ruizig), live uit
// gladde 5/10/15-min rates -> niet vergelijkbaar.
// CGM-lag correctie: bij snelle daling ligt de echte bloedglucose lager dan de
// sensorwaarde. We schatten dat met blendedRate over dit aantal minuten vooruit.
const CGM_LAG_MINUTES = 5
// Door de wekelijkse auto-tuner geleerde V2-parameters (op jouw eigen episodes).
// Gitignored runtime-state; afwezig = V2 draait op defaults. Wordt per sync-cyclus
// opnieuw gelezen, zodat een verse tuning vanzelf wordt toegepast (in shadow).
const V2_STATE_PATH = new URL('./reactive-hypo-v2-state.json', import.meta.url)
const FEEDBACK_TYPES = new Set([
  'confirmed',
  'false_alarm',
  'feels_hypo',
  'ate_now',
  'fingerstick_confirmed',
])

// Toegestane cgm_events-types (notes/event-logging). MOET hierboven de top-level
// await staan (TDZ), want writeCgmEvent leest dit vanuit een request-handler.
const CGM_EVENT_TYPES = new Set(['meal', 'snack', 'symptom', 'exercise', 'stress', 'sleep', 'illness', 'alcohol', 'fingerstick', 'action', 'note'])
// Idem (TDZ): buildPattern (request-handler) leest TOD_LABEL.
const TOD_LABEL = { night: 'nacht', morning: 'ochtend', afternoon: 'middag', evening: 'avond' }

// NB: deze module heeft een top-level `await runForever()` die nooit terugkeert.
// Alle module-scope const/let MOET hierboven staan, anders blijven ze in de
// temporal dead zone (TDZ) en falen runtime-toegangen.

const LLU_BASE_HEADERS = {
  'Content-Type': 'application/json',
  product: 'llu.android',
  version: '4.16.0',
  'Accept-Encoding': 'gzip',
  'cache-control': 'no-cache',
  connection: 'Keep-Alive',
}

const args = new Set(process.argv.slice(2))
const loop = args.has('--loop')
const server = args.has('--server')
let config = readConfig(false)

// AI-review state (lock + min-interval + modellen-cache). MOET hierboven de
// top-level `await runForever()` staan, anders blijven deze in de TDZ in
// --loop-modus (runForever keert nooit terug) en falen de /ai-review routes.
const AI_REVIEW_MIN_INTERVAL_MS = Math.max(0, Number(process.env.AI_REVIEW_MIN_INTERVAL_MS ?? 30_000))
let aiReviewRunning = false
let aiReviewLastAt = 0
let aiModelsCache = { at: 0, models: null }
// Korte cache: source-health wordt bij het openen van het paneel meermaals opgevraagd
// (banner + reminders + patterns). 15s is ruim binnen de meet-resolutie (minuten).
let sourceHealthCache = { at: 0, data: null }
// Indexen op de notes/reminder-collecties één keer per proces (idempotent).
let auxIndexesEnsured = false

// Periodieke episode-build in de --loop-modus zodat reactive_hypo_episodes
// vanzelf bijblijft (anders loopt het achter tot iemand handmatig episodes:build
// draait). 0 = uit. MOET boven de top-level await staan (TDZ).
const EPISODES_BUILD_INTERVAL_MS = Math.max(0, Number(process.env.EPISODES_BUILD_INTERVAL_MINUTES ?? 15)) * 60_000
let episodesBuildLastAt = 0
let episodesBuildRunning = false

if (server) startServer()

if (loop) {
  await runForever()
} else if (!server) {
  await syncOnce()
}

async function runForever() {
  while (true) {
    await syncOnce().catch((err) => {
      console.error(`[libreview-sync] ${formatError(err)}`)
    })
    await maybeBuildEpisodes().catch((err) => {
      console.error(`[libreview-sync] episode-build: ${formatError(err)}`)
    })
    await sleep(readConfig(false).intervalSeconds * 1000)
  }
}

// Bouwt reactive_hypo_episodes opnieuw op zodra het interval verstreken is.
// Deelt de builder met scripts/build-reactive-hypo-episodes.mjs (CLI) zodat
// live en handmatig identieke episodes opleveren. Niet-blokkerend bij falen.
async function maybeBuildEpisodes() {
  if (!EPISODES_BUILD_INTERVAL_MS || episodesBuildRunning) return
  const now = Date.now()
  if (episodesBuildLastAt && now - episodesBuildLastAt < EPISODES_BUILD_INTERVAL_MS) return
  episodesBuildRunning = true
  try {
    const result = await buildReactiveHypoEpisodes({ mongoUri: config.mongoUri })
    episodesBuildLastAt = Date.now()
    if (result && result.ok) {
      console.log(`[libreview-sync] episodes herbouwd: ${result.episodes} episode(s) uit ${result.scannedEntries} entries`)
    }
  } finally {
    episodesBuildRunning = false
  }
}

async function syncOnce() {
  config = readConfig(true)
  const { lluToken, baseUrl, accountId } = await libreLogin(config.email, config.password)
  const { readings, debugInfo } = await collectReadings(lluToken, accountId, baseUrl)
  const knownIdentifiers = await getKnownNightscoutIdentifiers()
  const previousEntries = await getRecentNightscoutEntries()
  const collectedEntries = readings
    .filter((pt) => (pt.Timestamp ?? pt.FactoryTimestamp) && (pt.Value ?? pt.ValueInMgPerDl))
    .map(toNightscoutEntry)
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.identifier === entry.identifier) === index)
    .sort((a, b) => a.date - b.date)
  addRateFields(collectedEntries, previousEntries)

  // Influx/Grafana is een time-series view: refresh ook bekende recente punten,
  // zodat richting/rate uit LibreView de oudere xDrip/Flat velden corrigeert.
  await writeInfluxGlucoseEntries(collectedEntries)

  const entries = collectedEntries
    .filter((entry) => !knownIdentifiers.has(entry.identifier))
    .sort((a, b) => a.date - b.date)
  addRateFields(entries, previousEntries)

  if (entries.length === 0) {
    console.log(`[libreview-sync] Geen nieuwe metingen. ${debugInfo}`)
    return { success: true, processed: readings.length, uploaded: 0, message: 'Geen nieuwe metingen.', debug: debugInfo }
  }

  await uploadEntries(entries)
  await writePredictionSnapshots(entries, previousEntries)
  console.log(`[libreview-sync] ${entries.length} metingen naar Nightscout geschreven. ${debugInfo}`)
  return {
    success: true,
    processed: readings.length,
    uploaded: entries.length,
    message: `${entries.length} metingen naar Nightscout geschreven.`,
    debug: debugInfo,
  }
}

async function writeInfluxGlucoseEntries(entries) {
  if (!config.influxUrl || !entries.length) return

  const lines = entries
    .map(toInfluxGlucoseLine)
    .filter(Boolean)

  if (!lines.length) return

  const url = new URL('/write', config.influxUrl)
  url.searchParams.set('db', config.influxDb)
  url.searchParams.set('precision', 'ns')

  const headers = { 'Content-Type': 'text/plain' }
  if (config.influxUser && config.influxPassword) {
    headers.Authorization = `Basic ${Buffer.from(`${config.influxUser}:${config.influxPassword}`).toString('base64')}`
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: lines.join('\n'),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[libreview-sync] Influx write mislukt (${res.status}): ${text.slice(0, 300)}`)
    }
  } catch (err) {
    console.warn(`[libreview-sync] Influx write netwerkfout: ${formatError(err)}`)
  }
}

function toInfluxGlucoseLine(entry) {
  const mgdl = Number(entry.sgv)
  const date = Number(entry.date)
  if (!Number.isFinite(mgdl) || !Number.isFinite(date)) return null

  const mmol = mgdl / MGDL_PER_MMOL
  const fields = [
    `value_mgdl=${Math.round(mgdl)}i`,
    `value_mmol=${round(mmol, 6)}`,
    `direction=${quoteInfluxString(entry.direction ?? 'NOT COMPUTABLE')}`,
  ]

  const rate5m = entry.glucoseRateMmolPerMin?.['5m']
  if (rate5m && Number.isFinite(rate5m.delta)) fields.push(`delta=${round(rate5m.delta, 6)}`)
  if (rate5m && Number.isFinite(rate5m.rate)) fields.push(`rate_5m=${round(rate5m.rate, 6)}`)

  return `glucose ${fields.join(',')} ${Math.trunc(date * 1_000_000)}`
}

function quoteInfluxString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

async function writePredictionSnapshots(entries, previousEntries = []) {
  if (!entries.length) return

  const timeline = [...previousEntries, ...entries]
    .filter((entry) => Number.isFinite(Number(entry.sgv)) && Number.isFinite(Number(entry.date)))
    .sort((a, b) => a.date - b.date)
  const workTimeline = cleanGlucoseTimeline(timeline)

  const episodes = await loadPatternEpisodes()
  const episodeVectors = await loadEpisodeVectors()
  const v2State = loadReactiveHypoV2State() // geleerde params (of null -> defaults)
  const snapshots = entries.map((entry) => {
    const idx = workTimeline.findIndex((candidate) => candidate.identifier === entry.identifier)
    if (idx < 0) return null

    const windowStart = entry.date - 120 * 60_000
    const currentEntry = workTimeline[idx]
    let peak = currentEntry
    for (let i = idx; i >= 0; i -= 1) {
      if (workTimeline[i].date < windowStart) break
      if (workTimeline[i].sgv > peak.sgv) peak = workTimeline[i]
    }

    const currentMmol = Number(currentEntry.sgv) / MGDL_PER_MMOL
    const peakMmol = Number(peak.sgv) / MGDL_PER_MMOL
    const dropFromPeakMmol = peakMmol - currentMmol
    const dropFromPeakPercent = peakMmol > 0 ? (dropFromPeakMmol / peakMmol) * 100 : 0
    const minutesSincePeak = (entry.date - peak.date) / 60_000

    const rate5m = calcRateFromTimeline(workTimeline, idx, 5)
    const rate10m = calcRateFromTimeline(workTimeline, idx, 10)
    const rate15m = calcRateFromTimeline(workTimeline, idx, 15)

    const shadowFeaturesFull = buildHypoFeatures(workTimeline, idx, { nowMs: entry.date, cleanTimeline: false })
    const features = shadowFeaturesFull

    // Eén patroon-match voor zowel de V1-forecast als V2 (component 6). Voorheen deed
    // de sync hier een aparte findSimilarEpisodes met minder dimensies en de lokale
    // piek, terwijl V2 patternFromFeatures op de featureset draaide — die liepen sinds
    // de aanloop-features uiteen. Nu voedt de gedeelde helper beide met dezelfde buren
    // (incl. drop-context-gate, riseRate15m/riseFromBaseline en curve-match).
    const pattern = patternFromFeatures(shadowFeaturesFull, episodeVectors, {
      recencyDays: v2State ? v2State.params?.patternRecencyDays : null,
    })

    const risk = evaluateRiskRuleV1({
      currentMmol,
      rate5m,
      rate10m,
      rate15m,
      peakMmol,
      minutesSincePeak,
      dropFromPeakMmol,
      dropFromPeakPercent,
      dataQuality: features.dataQuality,
    })
    if (pattern && pattern.similarEpisodeCount >= 3 && pattern.similarHypoRatio >= 0.5) {
      risk.reasons = risk.reasons.concat(
        `Lijkt op ${pattern.similarEpisodeCount} eerdere episodes; ${pattern.similarHypoCount} gingen onder 4.5`,
      )
    }

    const forecast = buildForecast({
      currentMmol,
      rate5m,
      rate10m,
      rate15m,
      peakMmol,
      minutesSincePeak,
      dropFromPeakMmol,
      episodes,
      patternDrop: pattern ? pattern.correction : null,
    })

    const blendedRate = risk.details.blendedRate
    const lagAdjustedMmol = Number.isFinite(blendedRate)
      ? round(currentMmol + blendedRate * CGM_LAG_MINUTES, 3)
      : null

    const predicted = {
      mmol10: forecast.predictedMmol['10'] ?? null,
      mmol20: forecast.predictedMmol['20'] ?? null,
      mmol30: forecast.predictedMmol['30'] ?? null,
      minutesTo45: risk.details.minutesTo45,
      minutesTo40: risk.details.minutesTo40,
      lagAdjustedMmol,
    }

    // V2 (reactieve detector) berekenen — hergebruik de al gebouwde featureset.
    let shadow = null
    let v2 = null
    try {
      v2 = evaluateReactiveHypoRiskV2(shadowFeaturesFull, { params: v2State ? v2State.params : undefined, pattern })
      shadow = {
        shadowModelVersion: v2.modelVersion,
        shadowRisk: v2.risk,
        shadowScore: v2.score,
        shadowConfidence: v2.confidence,
        shadowReasons: v2.reasons,
        shadowTuned: Boolean(v2State), // true = geleerde params toegepast
      }
    } catch (err) {
      console.warn(`[libreview-sync] shadow V2 mislukt: ${formatError(err)}`)
    }

    // Auto-activatie (M6): V2 wordt pas de alarmbron als de auto-tuner hem op
    // out-of-sample data heeft goedgekeurd (state.active === true). Tot dan blijft
    // V1 (rules-v1.1) bepalen. V2-niveau 'likely' mapt naar 'high' (alarm-vocab van
    // de overlay); V1 wordt als legacyRisk bewaard ter vergelijking.
    const v2Active = Boolean(v2State && v2State.active === true && v2)
    const primary = v2Active
      ? { risk: mapV2Alarm(v2.risk), riskScore: v2.score, reasons: v2.reasons, modelVersion: v2.modelVersion, legacyRisk: risk.risk, legacyScore: risk.score }
      : { risk: risk.risk, riskScore: risk.score, reasons: risk.reasons, modelVersion: 'rules-v1.1', legacyRisk: null, legacyScore: null }
    const carbAdvice = buildCarbAdvice({ currentMmol, risk: primary, v2, features, pattern })

    return {
      createdAt: entry.dateString ?? new Date(entry.date).toISOString(),
      entryIdentifier: entry.identifier,
      currentMmol: round(currentMmol, 3),
      risk: primary.risk,
      riskScore: primary.riskScore,
      reasons: primary.reasons,
      riskDetails: risk.details,
      carbAdvice,
      legacyRisk: primary.legacyRisk,
      legacyScore: primary.legacyScore,
      predictedMmol: forecast.predictedMmol,
      probabilities: forecast.probabilities,
      features,
      rawCurrentMmol: currentEntry.rawSgv != null ? round(Number(currentEntry.rawSgv) / MGDL_PER_MMOL, 3) : null,
      spikeFiltered: Boolean(currentEntry.spikeFiltered),
      predicted,
      pattern,
      // V2 component-breakdown (incl. patternScore) + onzekerheid persisteren zodat de
      // patroon-bijdrage achteraf auditbaar is per snapshot. confidence zit al in shadow.
      v2Components: v2 ? v2.components : null,
      v2Uncertainty: v2 ? v2.uncertainty : null,
      ...(shadow || {}),
      modelVersion: primary.modelVersion,
      outcomeEvaluated: false,
    }
  }).filter(Boolean)

  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    await ensureAuxIndexes(client.db())
    const collection = client.db().collection('prediction_snapshots')

    for (const snapshot of snapshots) {
      await collection.updateOne(
        { entryIdentifier: snapshot.entryIdentifier },
        {
          $set: {
            createdAt: snapshot.createdAt,
            currentMmol: snapshot.currentMmol,
            risk: snapshot.risk,
            riskScore: snapshot.riskScore,
            reasons: snapshot.reasons,
            riskDetails: snapshot.riskDetails,
            carbAdvice: snapshot.carbAdvice,
            legacyRisk: snapshot.legacyRisk ?? null,
            legacyScore: snapshot.legacyScore ?? null,
            predictedMmol: snapshot.predictedMmol,
            probabilities: snapshot.probabilities,
            features: snapshot.features,
            predicted: snapshot.predicted,
            pattern: snapshot.pattern,
            v2Components: snapshot.v2Components ?? null,
            v2Uncertainty: snapshot.v2Uncertainty ?? null,
            shadowModelVersion: snapshot.shadowModelVersion ?? null,
            shadowRisk: snapshot.shadowRisk ?? null,
            shadowScore: snapshot.shadowScore ?? null,
            shadowConfidence: snapshot.shadowConfidence ?? null,
            shadowReasons: snapshot.shadowReasons ?? null,
            shadowTuned: snapshot.shadowTuned ?? null,
            modelVersion: snapshot.modelVersion,
            outcomeEvaluated: false,
            updatedAt: new Date().toISOString(),
          },
          $setOnInsert: {
            insertedAt: new Date().toISOString(),
          },
        },
        { upsert: true }
      )
    }
  } catch (err) {
    console.warn(`[libreview-sync] snapshot mongo write mislukt: ${formatError(err)}`)
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

// V2-niveau -> alarm-vocabulaire van de overlay/V1 ('likely' bestaat daar niet).
function mapV2Alarm(risk) {
  return risk === 'likely' ? 'high' : risk
}

function buildCarbAdvice({ currentMmol, risk, v2, features, pattern }) {
  const f = features || {}
  const predicted = v2?.predicted || {}
  const scenarios = v2?.scenarios || null
  const minutesTo40 = Number.isFinite(predicted.minutesTo40)
    ? predicted.minutesTo40
    : Number.isFinite(f.minutesTo40) ? f.minutesTo40 : null
  const minutesTo45 = Number.isFinite(predicted.minutesTo45)
    ? predicted.minutesTo45
    : Number.isFinite(f.minutesTo45) ? f.minutesTo45 : null
  const current = Number.isFinite(currentMmol) ? currentMmol : Number(f.currentMmol)
  const blended = Number.isFinite(f.blendedRate) ? f.blendedRate : 0
  const falling = blended < -0.01
  const dropContext =
    Number(f.dropFromPeakMmol) >= 1.5 &&
    Number(f.minutesSincePeak) <= 90 &&
    blended < -0.015
  const patternRisk =
    pattern &&
    Number(pattern.similarEpisodeCount) >= 5 &&
    Number(pattern.similarHypoRatio) >= 0.5
  const worstCaseMin30 = scenarios && Number.isFinite(scenarios.worstCaseMin30)
    ? scenarios.worstCaseMin30
    : null

  let action = 'none'
  let urgency = 'none'
  let title = 'Geen suikeradvies'
  let message = 'Geen aanwijzing om nu suiker te nemen.'
  let etaMinutes = null
  const reasons = []

  if (current < 4.0) {
    action = 'eat_now'
    urgency = 'urgent'
    etaMinutes = 0
    title = 'Neem nu snelle koolhydraten'
    message = 'Je glucose is al onder 4.0 mmol/L.'
    reasons.push('actueel onder 4.0')
  } else if (current < 4.5 && falling) {
    action = 'eat_now'
    urgency = 'high'
    etaMinutes = 0
    title = 'Neem nu suiker'
    message = 'Je zit onder 4.5 mmol/L en daalt nog.'
    reasons.push('onder 4.5 en dalend')
  } else if (minutesTo40 !== null && minutesTo40 >= 0 && minutesTo40 <= 15) {
    action = 'eat_now'
    urgency = 'high'
    etaMinutes = Math.round(minutesTo40)
    title = 'Neem nu suiker'
    message = `Projectie onder 4.0 binnen ${Math.round(minutesTo40)} min.`
    reasons.push('projectie onder 4.0 binnen 15 min')
  } else if (minutesTo45 !== null && minutesTo45 >= 0 && minutesTo45 <= 10 && dropContext) {
    action = 'eat_now'
    urgency = 'high'
    etaMinutes = Math.round(minutesTo45)
    title = 'Neem nu suiker'
    message = `Projectie onder 4.5 binnen ${Math.round(minutesTo45)} min bij post-piek daling.`
    reasons.push('projectie onder 4.5 binnen 10 min met post-piek daling')
  } else if (minutesTo40 !== null && minutesTo40 > 15 && minutesTo40 <= 30) {
    action = 'prepare'
    urgency = 'watch'
    etaMinutes = Math.round(minutesTo40)
    title = 'Houd suiker klaar'
    message = `Mogelijk onder 4.0 over ${Math.round(minutesTo40)} min als deze daling doorzet.`
    reasons.push('projectie onder 4.0 binnen 30 min')
  } else if (
    risk &&
    (risk.risk === 'high' || risk.risk === 'urgent') &&
    worstCaseMin30 !== null &&
    worstCaseMin30 < 4.5 &&
    (falling || dropContext || patternRisk)
  ) {
    action = 'prepare'
    urgency = risk.risk === 'urgent' ? 'high' : 'watch'
    title = urgency === 'high' ? 'Overweeg nu suiker' : 'Houd suiker klaar'
    message = `Worst-case voorspelling komt binnen 30 min onder ${worstCaseMin30.toFixed(1)} mmol/L.`
    reasons.push('worst-case onder 4.5 binnen 30 min')
  }

  return {
    action,
    urgency,
    title,
    message,
    etaMinutes,
    reasons,
    minutesTo40: minutesTo40 === null ? null : round(minutesTo40, 1),
    minutesTo45: minutesTo45 === null ? null : round(minutesTo45, 1),
    worstCaseMin30: worstCaseMin30 === null ? null : round(worstCaseMin30, 3),
    generatedAt: new Date().toISOString(),
  }
}

// Leest de geleerde V2-parameters van schijf (geschreven door de wekelijkse
// auto-tuner). Afwezig/ongeldig = null -> V2 draait op defaults.
function loadReactiveHypoV2State() {
  try {
    const state = JSON.parse(readFileSync(V2_STATE_PATH, 'utf8'))
    return state && state.params ? state : null
  } catch {
    return null
  }
}

async function loadPatternEpisodes() {
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const events = await client.db().collection('pattern_events')
      .find({}, { projection: { startMmol: 1, endMmol: 1, peakMmol: 1, minutesPeakToUnder45: 1, minutesPeakToUnder40: 1 } })
      .limit(2000)
      .toArray()
    return events
  } catch {
    return []
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

async function loadEpisodeVectors() {
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    return await client.db().collection('episode_vectors')
      .find({}, { projection: { vector: 1, featureVector: 1, outcome: 1, eventType: 1, peakDate: 1, startDate: 1, endDate: 1 } })
      .limit(2000)
      .toArray()
  } catch {
    return []
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

function buildForecast(input) {
  const baseRate = blendRate(input.rate5m, input.rate10m, input.rate15m)
  // Vector-similarity heeft voorrang; valt terug op de simpele peak-correctie.
  const corr = Number.isFinite(input.patternDrop)
    ? Math.max(0, input.patternDrop)
    : patternCorrection(input, input.episodes || [])
  const predictedMmol = {}
  const probabilities = {}
  for (const h of FORECAST_HORIZONS) {
    // Korte horizons lineair; vanaf >30 min satureert de bijdrage van de rate.
    const effMinutes = h <= 30 ? h : 30 + RATE_DECAY_TAU * (1 - Math.exp(-(h - 30) / RATE_DECAY_TAU))
    // Correctie schaalt tot ~30 min (codex: h/30 i.p.v. h/20), gecapt op 1 voor de lange horizons.
    const w = Math.min(1, h / 30)
    const v = clamp(input.currentMmol + baseRate * effMinutes - corr * w, 1.5, 33)
    predictedMmol[String(h)] = round(v, 3)
    probabilities[String(h)] = {
      lt45: probBelow(v, 4.5),
      lt40: probBelow(v, 4.0),
    }
  }
  return { predictedMmol, probabilities }
}

function blendRate(rate5m, rate10m, rate15m) {
  const r5 = Number.isFinite(rate5m) ? rate5m : null
  const r10 = Number.isFinite(rate10m) ? rate10m : null
  const r15 = Number.isFinite(rate15m) ? rate15m : null
  const num = (r5 ?? 0) * 0.5 + (r10 ?? 0) * 0.33 + (r15 ?? 0) * 0.17
  const den = (r5 === null ? 0 : 0.5) + (r10 === null ? 0 : 0.33) + (r15 === null ? 0 : 0.17)
  return den > 0 ? num / den : 0
}

function patternCorrection(input, episodes) {
  if (!episodes.length) return 0
  const similar = episodes
    .filter((e) => Number.isFinite(e.peakMmol) && Number.isFinite(e.startMmol))
    .filter((e) => Math.abs(e.peakMmol - input.peakMmol) <= 1.2)
    .map((e) => Number(e.peakMmol) - Number(e.endMmol))
    .filter((x) => Number.isFinite(x) && x > 0)
  if (similar.length < 3) return 0
  similar.sort((a, b) => a - b)
  return Math.max(0, similar[Math.floor(similar.length / 2)] * 0.18)
}

function probBelow(value, threshold) {
  const d = threshold - value
  const p = 1 / (1 + Math.exp(-d * 2.4))
  return round(clamp(p, 0, 1), 3)
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

function calcRateFromTimeline(timeline, latestIndex, minutesBack) {
  const latest = timeline[latestIndex]
  const target = latest.date - minutesBack * 60_000

  for (let i = latestIndex - 1; i >= 0; i -= 1) {
    if (timeline[i].date <= target) {
      const dtMin = (latest.date - timeline[i].date) / 60_000
      if (dtMin <= 0) return null
      return (Number(latest.sgv) / MGDL_PER_MMOL - Number(timeline[i].sgv) / MGDL_PER_MMOL) / dtMin
    }
  }

  return null
}

function evaluateRiskRuleV1(input) {
  let score = 0
  const reasons = []
  const currentMmol = input.currentMmol ?? 99
  const peakMmol = input.peakMmol ?? 0
  const minutesSincePeak = input.minutesSincePeak ?? 999
  const dropFromPeakMmol = input.dropFromPeakMmol ?? 0
  const dropFromPeakPercent = input.dropFromPeakPercent ?? 0
  const rate5m = Number.isFinite(input.rate5m) ? input.rate5m : null
  const rate10m = Number.isFinite(input.rate10m) ? input.rate10m : null
  const rate15m = Number.isFinite(input.rate15m) ? input.rate15m : null
  const dataQuality = input.dataQuality || null
  const qualityLevel = dataQuality?.level || 'good'
  const qualityDegraded = qualityLevel === 'degraded'
  const qualityWatch = qualityLevel === 'watch'
  const blendedRate = blendRate(rate5m, rate10m, rate15m)
  const minutesTo40 = blendedRate < -0.01 ? (currentMmol - 4.0) / Math.abs(blendedRate) : null
  const minutesTo45 = blendedRate < -0.01 ? (currentMmol - 4.5) / Math.abs(blendedRate) : null
  const isRealDropContext = dropFromPeakMmol >= 1.5 && minutesSincePeak <= 90 && blendedRate < -0.015
  const isFastReactiveContext = dropFromPeakMmol >= 2 && minutesSincePeak <= 45 && (rate10m ?? 0) <= -0.04

  if (peakMmol >= 10 && minutesSincePeak <= 30) {
    score += 3
    reasons.push('Recente piek boven 10.0 mmol/L')
  } else if (peakMmol >= 8.5 && minutesSincePeak <= 45 && isFastReactiveContext) {
    score += 2
    reasons.push('Matige piek met snelle post-piek daling')
  }
  if (dropFromPeakMmol >= 3) {
    score += 3
    reasons.push('Grote daling vanaf piek')
  } else if (dropFromPeakMmol >= 2) {
    score += 2
    reasons.push('Snelle daling vanaf piek')
  }
  if (dropFromPeakPercent >= 30) {
    score += 3
    reasons.push('Relatieve piekdaling >= 30%')
  } else if (dropFromPeakPercent >= 25) {
    score += 2
    reasons.push('Relatieve piekdaling >= 25%')
  }
  if ((rate5m ?? 0) <= -0.08 || (rate10m ?? 0) <= -0.08) {
    score += 3
    reasons.push('Zeer snelle negatieve rate')
  }
  if ((rate15m ?? 0) <= -0.04) {
    score += 2
    reasons.push('Aanhoudende daling over 15 min')
  }
  if (minutesTo45 !== null && minutesTo45 >= 0 && minutesTo45 <= 20) {
    score += 2
    reasons.push('Voorspeld onder 4.5 binnen 20 min')
  }
  if (minutesTo40 !== null && minutesTo40 >= 0 && minutesTo40 <= 20) {
    score += 3
    reasons.push('Voorspeld onder 4.0 binnen 20 min')
  }
  if (currentMmol < 4.0) {
    score += 100
    reasons.push('Actuele waarde onder 4.0 mmol/L')
  } else if (currentMmol < 4.5) {
    score += 4
    reasons.push('Actuele waarde onder 4.5 mmol/L')
  }

  let risk = score >= 7 ? 'urgent' : score >= 5 ? 'high' : score >= 3 ? 'watch' : 'low'
  if (risk === 'urgent' && currentMmol >= 4.8 && !(minutesTo40 !== null && minutesTo40 >= 0 && minutesTo40 <= 15) && !isFastReactiveContext) {
    risk = 'high'
    reasons.push('Urgent gedempt: waarde nog boven 4.8 zonder snelle 4.0-projectie')
  }
  if (risk === 'high' && currentMmol >= 6.5 && !isRealDropContext) {
    risk = 'watch'
    reasons.push('High gedempt: nog hoog zonder duidelijke post-piek dropcontext')
  }
  if ((qualityDegraded || qualityWatch) && currentMmol >= 4.5) {
    const rateOnlyOrContextOnly = !(minutesTo40 !== null && minutesTo40 >= 0 && minutesTo40 <= 15)
    if (qualityDegraded && risk === 'urgent' && rateOnlyOrContextOnly) {
      risk = 'high'
      reasons.push('Urgent gedempt: datakwaliteit onvoldoende voor harde escalatie')
    } else if (qualityDegraded && risk === 'high' && rateOnlyOrContextOnly) {
      risk = 'watch'
      reasons.push('High gedempt: datakwaliteit onvoldoende voor harde escalatie')
    } else if (qualityWatch && risk === 'urgent' && rateOnlyOrContextOnly) {
      risk = 'high'
      reasons.push('Urgent gedempt: datakwaliteit is watch')
    }
  }
  return {
    score,
    risk,
    reasons,
    details: {
      blendedRate: round(blendedRate, 4),
      minutesTo40: minutesTo40 === null ? null : round(minutesTo40, 1),
      minutesTo45: minutesTo45 === null ? null : round(minutesTo45, 1),
      isRealDropContext,
      isFastReactiveContext,
      dataQualityLevel: qualityLevel,
    },
  }
}

function startServer() {
  const port = Number(process.env.LIBREVIEW_SYNC_PORT ?? 8787)
  const httpServer = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Content-Type', 'application/json')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (url.pathname === '/health') {
      const current = readConfig(false)
      res.end(JSON.stringify({
        ok: true,
        configured: Boolean(current.email && current.password && current.apiSecret),
        intervalSeconds: current.intervalSeconds,
        graceWindowMinutes: current.graceWindowMinutes,
        retryAttempts: current.retryAttempts,
        retryBaseDelayMs: current.retryBaseDelayMs,
        retryMaxDelayMs: current.retryMaxDelayMs,
        httpTimeoutMs: current.httpTimeoutMs,
        retryJitterMs: current.retryJitterMs,
      }))
      return
    }

    if (url.pathname === '/sync' && (req.method === 'POST' || req.method === 'GET')) {
      try {
        const result = await syncOnce()
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ success: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/prediction/latest' && req.method === 'GET') {
      try {
        const latest = await getLatestPredictionSnapshot()
        res.end(JSON.stringify({ ok: true, snapshot: latest }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/overlay/entries' && req.method === 'GET') {
      try {
        const count = parsePositiveInt(url.searchParams.get('count'), 1600, 3000)
        const entries = await getOverlayEntries(count)
        res.end(JSON.stringify({ ok: true, entries }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/feedback' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const result = await writeUserFeedback(body)
        res.end(JSON.stringify({ ok: true, id: result.id }))
      } catch (err) {
        res.writeHead(400)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/run' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const result = await runAiReviewOnce({ model: body && body.model })
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(err && err.statusCode ? err.statusCode : 500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/latest' && req.method === 'GET') {
      try {
        const limit = parsePositiveInt(url.searchParams.get('limit'), 10, 50)
        const result = await getLatestAiReview(limit)
        res.end(JSON.stringify({ ok: true, ...result }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/runs' && req.method === 'GET') {
      try {
        const limit = parsePositiveInt(url.searchParams.get('limit'), 50, 200)
        const runs = await getAiRuns(limit)
        res.end(JSON.stringify({ ok: true, runs }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/run' && req.method === 'GET') {
      try {
        const id = url.searchParams.get('id')
        if (!id) {
          res.writeHead(400)
          res.end(JSON.stringify({ ok: false, message: 'runId (id) ontbreekt.' }))
          return
        }
        const result = await getAiRun(id)
        res.end(JSON.stringify({ ok: true, runId: id, ...result }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/stats' && req.method === 'GET') {
      try {
        const days = parsePositiveInt(url.searchParams.get('days'), 14, 90)
        const stats = await getAiStats(days)
        res.end(JSON.stringify({ ok: true, ...stats }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/episodes' && req.method === 'GET') {
      try {
        const limit = parsePositiveInt(url.searchParams.get('limit'), 20, 200)
        const days = parsePositiveInt(url.searchParams.get('days'), 14, 90)
        const result = await getAiEpisodes(limit, days)
        res.end(JSON.stringify({ ok: true, ...result }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/explore-episodes' && req.method === 'GET') {
      try {
        const days = parsePositiveInt(url.searchParams.get('days'), 14, 90)
        const limit = parsePositiveInt(url.searchParams.get('limit'), 20, 100)
        const result = await getExploreEpisodes(days, limit)
        res.end(JSON.stringify({ ok: true, ...result }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/glucose-events' && req.method === 'GET') {
      try {
        const result = await getGlucoseEventsFeed(url.searchParams.get('date'))
        res.end(JSON.stringify({ ok: true, ...result }))
      } catch (err) {
        res.writeHead(err && err.statusCode ? err.statusCode : 500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/episode-detail' && req.method === 'GET') {
      try {
        const detail = await getAiEpisodeDetail({
          type: url.searchParams.get('type'),
          peakAt: url.searchParams.get('peakAt'),
        })
        res.end(JSON.stringify({ ok: true, ...detail }))
      } catch (err) {
        res.writeHead(err && err.statusCode ? err.statusCode : 500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/source-health' && req.method === 'GET') {
      try {
        const health = await getSourceHealth()
        res.end(JSON.stringify({ ok: true, ...health }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/history' && req.method === 'GET') {
      try {
        const days = parsePositiveInt(url.searchParams.get('days'), 14, 90)
        const result = await getAiHistory(days)
        res.end(JSON.stringify({ ok: true, ...result }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/patterns' && req.method === 'GET') {
      try {
        const result = await getAiPatterns()
        res.end(JSON.stringify({ ok: true, ...result }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/evaluation' && req.method === 'GET') {
      try {
        const days = parsePositiveInt(url.searchParams.get('days'), 14, 90)
        const result = await getEvaluation(days)
        res.end(JSON.stringify({ ok: true, ...result }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/events' && req.method === 'GET') {
      try {
        const limit = parsePositiveInt(url.searchParams.get('limit'), 50, 200)
        const events = await getCgmEvents(limit)
        res.end(JSON.stringify({ ok: true, events }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/events' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const result = await writeCgmEvent(body)
        res.end(JSON.stringify({ ok: true, ...result }))
      } catch (err) {
        res.writeHead(err && err.statusCode ? err.statusCode : 400)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/reminders' && req.method === 'GET') {
      try {
        const result = await getHelperReminders()
        res.end(JSON.stringify({ ok: true, ...result }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/reminders' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const result = await setReminderState(body)
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(err && err.statusCode ? err.statusCode : 400)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/day' && req.method === 'GET') {
      try {
        const day = await getAiDayReview(url.searchParams.get('date'))
        res.end(JSON.stringify({ ok: true, ...day }))
      } catch (err) {
        res.writeHead(err && err.statusCode ? err.statusCode : 500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/day-compare' && req.method === 'GET') {
      try {
        const result = await getAiDayCompare(url.searchParams.get('date'))
        res.end(JSON.stringify({ ok: true, ...result }))
      } catch (err) {
        res.writeHead(err && err.statusCode ? err.statusCode : 500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/report' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const result = await runAiReportOnce({ type: body && body.type, date: body && body.date, days: body && body.days })
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(err && err.statusCode ? err.statusCode : 500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/reports' && req.method === 'GET') {
      try {
        const limit = parsePositiveInt(url.searchParams.get('limit'), 20, 100)
        const reports = await getAiReports(limit)
        res.end(JSON.stringify({ ok: true, reports }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/chat' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        const result = await runAiChatOnce({ messages: body && body.messages, scope: body && body.scope })
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(err && err.statusCode ? err.statusCode : 500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    if (url.pathname === '/ai-review/models' && req.method === 'GET') {
      try {
        const models = await listAiModels()
        res.end(JSON.stringify({ ok: true, models }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ ok: false, message: formatError(err) }))
      }
      return
    }

    res.writeHead(404)
    res.end(JSON.stringify({ success: false, message: 'Niet gevonden.' }))
  })

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`[libreview-sync] HTTP sync server luistert op ${port}`)
  })

  startAiReviewLoop()
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    const clientError = (message) => {
      const err = new Error(message)
      err.statusCode = 400
      return err
    }
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1_000_000) {
        reject(clientError('Body te groot'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(clientError(`Ongeldige JSON: ${formatError(err)}`))
      }
    })
    req.on('error', reject)
  })
}

async function writeUserFeedback(body) {
  const type = String((body && body.type) || '').trim()
  if (!FEEDBACK_TYPES.has(type)) {
    throw new Error(`Onbekend feedbacktype: ${type || '(leeg)'}`)
  }

  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const db = client.db()

    let entry = null
    if (body && body.entryIdentifier) {
      entry = await db.collection('entries')
        .find({ identifier: body.entryIdentifier }, { projection: { _id: 1, identifier: 1, date: 1, sgv: 1 } })
        .limit(1)
        .next()
    }
    if (!entry) {
      entry = await db.collection('entries')
        .find({ type: 'sgv' }, { projection: { _id: 1, identifier: 1, date: 1, sgv: 1 } })
        .sort({ date: -1 })
        .limit(1)
        .next()
    }

    const snapshot = entry
      ? await db.collection('prediction_snapshots')
          .find({ entryIdentifier: entry.identifier }, { projection: { _id: 1, risk: 1, riskScore: 1 } })
          .limit(1)
          .next()
      : null

    const doc = {
      createdAt: new Date().toISOString(),
      type,
      value: body && body.value != null ? body.value : null,
      note: body && body.note ? String(body.note).slice(0, 500) : null,
      relatedEntryId: entry ? entry._id : null,
      relatedEntryIdentifier: entry ? entry.identifier ?? null : null,
      relatedEntryMmol: entry && Number.isFinite(entry.sgv) ? round(Number(entry.sgv) / MGDL_PER_MMOL, 3) : null,
      relatedSnapshotId: snapshot ? snapshot._id : null,
      riskAtFeedback: snapshot ? snapshot.risk : null,
      riskScoreAtFeedback: snapshot ? snapshot.riskScore : null,
    }

    const result = await db.collection('user_feedback').insertOne(doc)
    return { id: String(result.insertedId) }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

async function getOverlayEntries(count) {
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    return await client.db().collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true } }, {
        projection: {
          _id: 0,
          date: 1,
          dateString: 1,
          direction: 1,
          identifier: 1,
          mills: 1,
          sgv: 1,
          sysTime: 1,
        },
      })
      .sort({ date: -1 })
      .limit(count)
      .toArray()
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

async function getLatestPredictionSnapshot() {
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    return await client.db().collection('prediction_snapshots')
      .find({}, { projection: { createdAt: 1, entryIdentifier: 1, predictedMmol: 1, probabilities: 1, modelVersion: 1, currentMmol: 1, rawCurrentMmol: 1, spikeFiltered: 1, risk: 1, riskScore: 1, reasons: 1, riskDetails: 1, carbAdvice: 1, legacyRisk: 1, legacyScore: 1, features: 1, predicted: 1, pattern: 1, v2Components: 1, v2Uncertainty: 1, shadowModelVersion: 1, shadowRisk: 1, shadowScore: 1, shadowConfidence: 1, shadowReasons: 1, shadowTuned: 1 } })
      .sort({ createdAt: -1 })
      .limit(1)
      .next()
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

// --- AI-review (optionele AI-laag) -----------------------------------------
// State (AI_REVIEW_MIN_INTERVAL_MS / aiReviewRunning / aiReviewLastAt /
// aiModelsCache) staat bovenaan het bestand i.v.m. de TDZ + top-level await.

// Draait één review met eigen Mongo-connectie. throws bij actieve run / te snel.
async function runAiReviewOnce({ model } = {}) {
  if (aiReviewRunning) {
    const err = new Error('Er draait al een AI-review.')
    err.statusCode = 409
    throw err
  }
  const since = Date.now() - aiReviewLastAt
  if (aiReviewLastAt && since < AI_REVIEW_MIN_INTERVAL_MS) {
    const err = new Error(`Te snel achter elkaar; wacht ${Math.ceil((AI_REVIEW_MIN_INTERVAL_MS - since) / 1000)}s.`)
    err.statusCode = 429
    throw err
  }
  const aiRouter = resolveAiRouterConfig(model)
  if (!aiRouterConfigured(aiRouter)) {
    return {
      ok: true,
      skipped: true,
      reason: 'Geen AI-provider geconfigureerd; zet AI_ROUTER_PROVIDERS met AI_<PROVIDER>_* of legacy AI_CHAT_*.',
    }
  }
  aiReviewRunning = true
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const result = await runAiReview({ db: client.db(), aiRouter })
    aiReviewLastAt = Date.now()
    return result
  } finally {
    aiReviewRunning = false
    if (client) await client.close().catch(() => undefined)
  }
}

async function getLatestAiReview(limit) {
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const db = client.db()
    // Toon alleen de meest recente review-run (op runId), zodat het paneel geen
    // duplicaten over runs heen stapelt. Fallback op latest-N voor oude docs
    // zonder runId.
    const newest = await db.collection('ai_observations').find({}).sort({ createdAt: -1 }).limit(1).next()
    const runId = newest && newest.runId ? newest.runId : null
    const filter = runId ? { runId } : {}
    const [observations, questions] = await Promise.all([
      db.collection('ai_observations').find(filter).sort({ createdAt: -1 }).limit(limit).toArray(),
      db.collection('ai_questions').find(filter).sort({ createdAt: -1 }).limit(limit).toArray(),
    ])
    return { observations, questions, runId }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

// Lijst van review-runs (voor de run-selector). Puur Mongo-aggregatie, geen LLM.
async function getAiRuns(limit) {
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const runs = await client.db().collection('ai_observations').aggregate([
      { $match: { runId: { $ne: null } } },
      { $group: { _id: '$runId', createdAt: { $max: '$createdAt' }, model: { $last: '$model' }, observations: { $sum: 1 } } },
      { $sort: { createdAt: -1 } },
      { $limit: limit },
    ]).toArray()
    return runs.map((r) => ({ runId: r._id, createdAt: r.createdAt, model: r.model, observations: r.observations }))
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

// Observaties + vragen van één specifieke run. Puur Mongo-reads, geen LLM.
async function getAiRun(runId) {
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const db = client.db()
    const [observations, questions] = await Promise.all([
      db.collection('ai_observations').find({ runId }).sort({ createdAt: -1 }).limit(50).toArray(),
      db.collection('ai_questions').find({ runId }).sort({ createdAt: -1 }).limit(50).toArray(),
    ])
    return { observations, questions }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

// A — Statistiek/AGP-light. Deterministisch uit `entries`, geen LLM. mmol = sgv/18.0182.
async function getAiStats(days) {
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const to = Date.now()
    const from = to - days * 86_400_000
    const rows = await client.db().collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true }, date: { $gte: from } }, { projection: { _id: 0, sgv: 1, date: 1 } })
      .toArray()
    rows.sort((a, b) => a.date - b.date)
    const tz = process.env.LIBREVIEW_TZ || 'Europe/Amsterdam'
    const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false })
    const weekdayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' })
    const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }
    const hourAgg = Array.from({ length: 24 }, () => ({ sum: 0, n: 0, low: 0, high: 0, inRange: 0, vals: [] }))
    const wdAgg = Array.from({ length: 7 }, () => ({ sum: 0, n: 0, low: 0, high: 0, inRange: 0 }))
    const heatmapAgg = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ n: 0, low: 0, high: 0, inRange: 0 })))
    const vals = []
    let inRange = 0, below = 0, veryLow = 0, above = 0, veryHigh = 0
    let min = Infinity, max = -Infinity
    for (const r of rows) {
      const mmol = Number(r.sgv) / MGDL_PER_MMOL
      vals.push(mmol)
      if (mmol < min) min = mmol
      if (mmol > max) max = mmol
      const isIn = mmol >= 3.9 && mmol <= 10.0
      const isLow = mmol < 3.9
      if (isIn) inRange++
      if (isLow) below++
      if (mmol < 3.0) veryLow++
      if (mmol > 10.0) above++
      if (mmol > 13.9) veryHigh++
      const h = Number(hourFmt.format(new Date(r.date))) % 24
      const isHigh = mmol > 10.0
      const a = hourAgg[h]; a.sum += mmol; a.n++; a.vals.push(mmol); if (isLow) a.low++; if (isHigh) a.high++; if (isIn) a.inRange++
      const wd = WD[weekdayFmt.format(new Date(r.date))]
      if (wd != null) {
        const w = wdAgg[wd]; w.sum += mmol; w.n++; if (isLow) w.low++; if (isHigh) w.high++; if (isIn) w.inRange++
        const cell = heatmapAgg[wd][h]; cell.n++; if (isLow) cell.low++; if (isHigh) cell.high++; if (isIn) cell.inRange++
      }
    }
    // Drempel-lows via de gedeelde builder: splitst correct bij datagaten >30 min en
    // sluit een lopende low aan het venster-einde af (de oude inline-lus deed beide niet).
    const thresholdLows = buildThresholdLows(rows)
    const lowEpisodes = thresholdLows.length
    const longestLowMin = thresholdLows.reduce((m, l) => Math.max(m, l.durationMinutes || 0), 0)
    const n = vals.length
    const mean = n ? vals.reduce((s, v) => s + v, 0) / n : 0
    const sd = n ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n) : 0
    const pct = (x) => (n ? round((x / n) * 100, 1) : 0)
    const expected = expectedSamples(rows, days * 1440)
    // Percentiel uit een (ongesorteerde) waarden-array; voor de AGP-banden per uur.
    const pctl = (arr, p) => {
      if (!arr.length) return null
      const s = arr.slice().sort((a, b) => a - b)
      return round(s[Math.min(s.length - 1, Math.floor(p * s.length))], 1)
    }
    const perHour = hourAgg.map((a, h) => ({
      hour: h,
      mean: a.n ? round(a.sum / a.n, 1) : null,
      lowPct: a.n ? round((a.low / a.n) * 100, 1) : 0,
      highPct: a.n ? round((a.high / a.n) * 100, 1) : 0,
      tir: a.n ? round((a.inRange / a.n) * 100, 1) : 0,
      // AGP-percentielen per uur (p10/p25/p50/p75/p90).
      p10: pctl(a.vals, 0.10),
      p25: pctl(a.vals, 0.25),
      p50: pctl(a.vals, 0.50),
      p75: pctl(a.vals, 0.75),
      p90: pctl(a.vals, 0.90),
      n: a.n,
    }))
    // Mediaan + IQR (AGP gebruikt percentielen).
    const sorted = vals.slice().sort((a, b) => a - b)
    const q = (p) => (n ? round(sorted[Math.min(n - 1, Math.floor(p * n))], 1) : null)
    // GMI (Glucose Management Indicator) uit gemiddelde mg/dL.
    const gmi = n ? round(3.31 + 0.02392 * (mean * MGDL_PER_MMOL), 1) : null
    const WD_LABELS = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo']
    const perWeekday = wdAgg.map((w, i) => ({
      day: WD_LABELS[i],
      mean: w.n ? round(w.sum / w.n, 1) : null,
      lowPct: w.n ? round((w.low / w.n) * 100, 1) : 0,
      highPct: w.n ? round((w.high / w.n) * 100, 1) : 0,
      tir: w.n ? round((w.inRange / w.n) * 100, 1) : 0,
      n: w.n,
    }))
    const heatmap = heatmapAgg.map((row, wd) => row.map((c, hour) => ({
      day: WD_LABELS[wd],
      hour,
      n: c.n,
      lowPct: c.n ? round((c.low / c.n) * 100, 1) : 0,
      highPct: c.n ? round((c.high / c.n) * 100, 1) : 0,
      tir: c.n ? round((c.inRange / c.n) * 100, 1) : 0,
    })))
    // Trend: huidige `days`-window vs het direct voorafgaande gelijke window
    // (prev = [from - days, from)). Aparte lichte query zodat de hoofdaggregatie
    // ongemoeid blijft; alleen sgv nodig voor TIR/gemiddelde/CV/laag.
    const prevFrom = from - days * 86_400_000
    const prevRows = await client.db().collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true }, date: { $gte: prevFrom, $lt: from } }, { projection: { _id: 0, sgv: 1 } })
      .toArray()
    let pN = 0, pIn = 0, pBelow = 0, pSum = 0
    const pVals = []
    for (const r of prevRows) {
      const m = Number(r.sgv) / MGDL_PER_MMOL
      pN++; pSum += m; pVals.push(m)
      if (m >= 3.9 && m <= 10.0) pIn++
      if (m < 3.9) pBelow++
    }
    const prevTir = pN ? round((pIn / pN) * 100, 1) : null
    const prevMean = pN ? round(pSum / pN, 1) : null
    const prevSd = pN ? Math.sqrt(pVals.reduce((s, v) => s + (v - pSum / pN) * (v - pSum / pN), 0) / pN) : null
    const prevCv = pN && pSum ? round((prevSd / (pSum / pN)) * 100, 0) : null
    const prevLowPct = pN ? round((pBelow / pN) * 100, 1) : null
    const curTir = n ? round((inRange / n) * 100, 1) : null
    const curMean = n ? round(mean, 1) : null
    const curCv = mean ? round((sd / mean) * 100, 0) : null
    const curLowPct = n ? round((below / n) * 100, 1) : null
    const delta = (a, b) => (a != null && b != null ? round(a - b, 1) : null)
    const trend = {
      // recentTir/prevTir behouden voor backward-compat met bestaande overlay-tekst.
      recentTir: curTir, prevTir,
      tirDelta: delta(curTir, prevTir),
      meanDelta: delta(curMean, prevMean),
      cvDelta: delta(curCv, prevCv),
      recentLowPct: curLowPct, prevLowPct,
      lowPctDelta: delta(curLowPct, prevLowPct),
      prevDays: days,
    }
    const reactiveSince = new Date(from).toISOString()
    const reactiveEpisodes = await client.db().collection('reactive_hypo_episodes')
      .find({ peakAt: { $gte: reactiveSince } }, {
        projection: {
          _id: 0,
          peakAt: 1,
          nadirAt: 1,
          recoveredAt: 1,
          outcome: 1,
          severity: 1,
          shape: 1,
          peakMmol: 1,
          nadirMmol: 1,
          dropFromPeakMmol: 1,
          minutesPeakToNadir: 1,
          recoveryMinutes: 1,
          timeBelow3_9Minutes: 1,
          areaBelow3_9: 1,
          qualityScore: 1,
          qualityFlags: 1,
          reboundHigh: 1,
          postprandialCandidate: 1,
          timeOfDayBucket: 1,
        },
      })
      .toArray()
    const highToLowContext = buildHighToLowContext(buildHighEpisodes(rows), reactiveEpisodes)
    const reactive = summarizeReactiveEpisodes(reactiveEpisodes)
    // Wanneer draaide de episode-builder voor het laatst? Elke build zet updatedAt
    // op alle episodes, dus de hoogste updatedAt = laatste build. Hiermee meten we
    // staleness van de BUILD (loopt achter op de data), niet "geen recente daling".
    const lastBuilt = await client.db().collection('reactive_hypo_episodes')
      .find({}, { projection: { _id: 0, updatedAt: 1 } })
      .sort({ updatedAt: -1 }).limit(1).toArray()
    const episodesBuiltAt = lastBuilt.length ? lastBuilt[0].updatedAt : null
    return {
      window: { days, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      count: n,
      latestEntryAt: rows.length ? new Date(rows[rows.length - 1].date).toISOString() : null,
      episodesBuiltAt,
      coveragePct: round(Math.min(100, expected ? (n / expected) * 100 : 0), 0),
      mean: n ? round(mean, 1) : null, sd: n ? round(sd, 1) : null, cv: mean ? round((sd / mean) * 100, 0) : null,
      gmi, median: q(0.5), p25: q(0.25), p75: q(0.75),
      tir: pct(inRange), tbr: pct(below), veryLow: pct(veryLow), tar: pct(above), veryHigh: pct(veryHigh),
      min: n ? round(min, 1) : null, max: n ? round(max, 1) : null,
      lows: { count: lowEpisodes, longestMin: round(longestLowMin, 0) },
      perHour, perWeekday, heatmap, trend, reactive, highToLowContext,
    }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

function inc(map, key) {
  const k = key || 'onbekend'
  map[k] = (map[k] || 0) + 1
}

function median(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!xs.length) return null
  // Standaard-mediaan: bij even aantal het gemiddelde van de twee middelste waarden
  // (niet de bovenste van de twee), conform de gangbare statistische definitie.
  const mid = Math.floor(xs.length / 2)
  return round(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2, 1)
}

function summarizeReactiveEpisodes(episodes) {
  const byOutcome = {}
  const bySeverity = {}
  const byShape = {}
  const byTimeOfDay = {}
  let burden39 = 0
  let timeBelow39 = 0
  let poorQuality = 0
  let singlePoint = 0
  let compression = 0
  let postprandial = 0
  let rebound = 0
  const drops = []
  const nadirs = []
  const peakToNadir = []
  const recoveries = []
  let latestPeakAt = null
  for (const e of episodes) {
    inc(byOutcome, e.outcome)
    inc(bySeverity, e.severity)
    inc(byShape, e.shape)
    inc(byTimeOfDay, e.timeOfDayBucket)
    const flags = Array.isArray(e.qualityFlags) ? e.qualityFlags : []
    if (Number(e.qualityScore) < 70) poorQuality += 1
    if (flags.includes('single_point_low')) singlePoint += 1
    if (flags.includes('possible_compression_low')) compression += 1
    if (e.postprandialCandidate) postprandial += 1
    if (e.reboundHigh) rebound += 1
    burden39 += Number(e.areaBelow3_9) || 0
    timeBelow39 += Number(e.timeBelow3_9Minutes) || 0
    drops.push(Number(e.dropFromPeakMmol))
    nadirs.push(Number(e.nadirMmol))
    peakToNadir.push(Number(e.minutesPeakToNadir))
    // Alleen episodes die écht herstelden tellen mee. recoveryMinutes is null als
    // er binnen de horizon geen herstel was; Number(null) === 0 zou anders door
    // median()'s Number.isFinite-filter glippen en "0 min herstel" meetellen.
    if (e.recoveryMinutes != null) recoveries.push(Number(e.recoveryMinutes))
    if (!latestPeakAt || Date.parse(e.peakAt) > Date.parse(latestPeakAt)) latestPeakAt = e.peakAt || latestPeakAt
  }
  const total = episodes.length
  return {
    total,
    hypo: byOutcome.hypo || 0,
    nearHypo: byOutcome.near_hypo || 0,
    safeDrop: byOutcome.safe_drop || 0,
    byOutcome,
    bySeverity,
    byShape,
    byTimeOfDay,
    medianDropMmol: median(drops),
    medianNadirMmol: median(nadirs),
    medianPeakToNadirMin: median(peakToNadir),
    medianRecoveryMin: median(recoveries),
    totalTimeBelow3_9Min: round(timeBelow39, 0),
    totalAreaBelow3_9: round(burden39, 1),
    pctPoorQuality: total ? round((poorQuality / total) * 100, 0) : 0,
    artefactFlags: { singlePoint, possibleCompression: compression },
    pctPostprandialCandidate: total ? round((postprandial / total) * 100, 0) : 0,
    reboundHigh: rebound,
    latestPeakAt,
  }
}

function buildHighToLowContext(highEpisodes, lowEpisodes) {
  const lows = lowEpisodes
    .filter((l) => Number.isFinite(Date.parse(l.peakAt)))
    .sort((a, b) => Date.parse(a.peakAt) - Date.parse(b.peakAt))
  const pairs = []
  // Eén low mag maar door één high geclaimd worden (anders dubbeltelling als twee
  // highs binnen 4u vóór dezelfde low liggen). Greedy: vroegste ongebruikte low per high.
  const usedLows = new Set()
  for (const high of highEpisodes) {
    const highEnd = Date.parse(high.endAt)
    if (!Number.isFinite(highEnd)) continue
    const lowIdx = lows.findIndex((l, i) => {
      if (usedLows.has(i)) return false
      const peak = Date.parse(l.peakAt)
      return peak >= highEnd && peak <= highEnd + 4 * 3_600_000
    })
    if (lowIdx < 0) continue
    usedLows.add(lowIdx)
    const low = lows[lowIdx]
    const minutes = round((Date.parse(low.peakAt) - highEnd) / 60000, 0)
    const lowNadir = Number(low.nadirMmol)
    const drop = Number(low.dropFromPeakMmol)
    const burden = Number(low.areaBelow3_9) || 0
    const relevantReasons = []
    if (lowNadir < 3.9) relevantReasons.push('hypo')
    else if (lowNadir < 4.5) relevantReasons.push('near-hypo')
    if (drop >= 3) relevantReasons.push('grote daling')
    if (minutes <= 120) relevantReasons.push('binnen 2 uur')
    if (burden >= 4) relevantReasons.push('burden')
    if (low.reboundHigh) relevantReasons.push('rebound')
    pairs.push({
      highPeakAt: high.peakAt,
      highEndAt: high.endAt,
      highPeakMmol: high.peakMmol,
      highDurationMinutes: high.durationMinutes,
      lowPeakAt: low.peakAt,
      lowNadirAt: low.nadirAt,
      lowNadirMmol: low.nadirMmol,
      lowOutcome: low.outcome || null,
      lowSeverity: low.severity || null,
      lowShape: low.shape || null,
      lowDropFromPeakMmol: low.dropFromPeakMmol,
      lowAreaBelow3_9: low.areaBelow3_9,
      minutesHighEndToLowPeak: minutes,
      relevantReasons,
      relevanceScore:
        (lowNadir < 3.9 ? 3 : (lowNadir < 4.5 ? 1 : 0)) +
        (drop >= 3 ? 1 : 0) +
        (minutes <= 120 ? 1 : 0) +
        (burden >= 4 ? 1 : 0) +
        (low.reboundHigh ? 1 : 0),
    })
  }
  const relevant = pairs.filter((p) => p.relevanceScore >= 2)
  return {
    total: pairs.length,
    relevant: relevant.length,
    recent: pairs.slice().sort((a, b) => Date.parse(b.lowPeakAt) - Date.parse(a.lowPeakAt)).slice(0, 10),
    top: pairs.slice().sort((a, b) => b.relevanceScore - a.relevanceScore || Date.parse(b.lowPeakAt) - Date.parse(a.lowPeakAt)).slice(0, 5),
  }
}

function dayKeyInTz(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function shiftDateKey(dateKey, days) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number)
  if (!year || !month || !day) return null
  const d = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0))
  return d.toISOString().slice(0, 10)
}

function localDayRange(dateKey, timeZone) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number)
  if (!year || !month || !day) return null
  const approx = Date.UTC(year, month - 1, day, 12, 0, 0)
  let start = approx - 36 * 3_600_000
  while (dayKeyInTz(new Date(start), timeZone) < dateKey) start += 3_600_000
  while (dayKeyInTz(new Date(start - 60_000), timeZone) >= dateKey) start -= 60_000
  while (dayKeyInTz(new Date(start), timeZone) !== dateKey) start += 60_000
  let end = start + 18 * 3_600_000
  while (dayKeyInTz(new Date(end), timeZone) === dateKey) end += 60_000
  return { from: start, to: end }
}

function summarizeEntries(rows, expectedSampleCount) {
  const vals = rows.map((r) => Number(r.sgv) / MGDL_PER_MMOL).filter(Number.isFinite)
  const n = vals.length
  let inRange = 0, below = 0, veryLow = 0, above = 0, veryHigh = 0
  let min = Infinity, max = -Infinity
  for (const mmol of vals) {
    if (mmol >= 3.9 && mmol <= 10.0) inRange++
    if (mmol < 3.9) below++
    if (mmol < 3.0) veryLow++
    if (mmol > 10.0) above++
    if (mmol > 13.9) veryHigh++
    if (mmol < min) min = mmol
    if (mmol > max) max = mmol
  }
  const mean = n ? vals.reduce((s, v) => s + v, 0) / n : 0
  const sd = n ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n) : 0
  const pct = (x) => (n ? round((x / n) * 100, 1) : 0)
  return {
    count: n,
    coveragePct: round(Math.min(100, expectedSampleCount ? (n / expectedSampleCount) * 100 : 0), 0),
    mean: n ? round(mean, 1) : null,
    sd: n ? round(sd, 1) : null,
    cv: mean ? round((sd / mean) * 100, 0) : null,
    tir: pct(inRange),
    tbr: pct(below),
    veryLow: pct(veryLow),
    tar: pct(above),
    veryHigh: pct(veryHigh),
    min: n ? round(min, 1) : null,
    max: n ? round(max, 1) : null,
  }
}

function buildHighEpisodes(rows) {
  const episodes = []
  let cur = null
  for (const r of rows) {
    const mmol = Number(r.sgv) / MGDL_PER_MMOL
    const isHigh = mmol > 10.0
    if (isHigh && !cur) {
      cur = { startAt: r.date, endAt: r.date, peakAt: r.date, peakMmol: mmol, count: 1 }
    } else if (isHigh && cur) {
      cur.endAt = r.date
      cur.count += 1
      if (mmol > cur.peakMmol) { cur.peakMmol = mmol; cur.peakAt = r.date }
    } else if (!isHigh && cur) {
      const durationMin = Math.max(1, Math.round((cur.endAt - cur.startAt) / 60000))
      if (durationMin >= 15 || cur.count >= 3) {
        episodes.push({
          startAt: new Date(cur.startAt).toISOString(),
          endAt: new Date(cur.endAt).toISOString(),
          peakAt: new Date(cur.peakAt).toISOString(),
          peakMmol: round(cur.peakMmol, 1),
          durationMinutes: durationMin,
        })
      }
      cur = null
    }
  }
  if (cur) {
    const durationMin = Math.max(1, Math.round((cur.endAt - cur.startAt) / 60000))
    if (durationMin >= 15 || cur.count >= 3) {
      episodes.push({
        startAt: new Date(cur.startAt).toISOString(),
        endAt: new Date(cur.endAt).toISOString(),
        peakAt: new Date(cur.peakAt).toISOString(),
        peakMmol: round(cur.peakMmol, 1),
        durationMinutes: durationMin,
      })
    }
  }
  return episodes
}

async function getAiDayReview(dateKey) {
  const tz = process.env.LIBREVIEW_TZ || 'Europe/Amsterdam'
  const range = localDayRange(dateKey || dayKeyInTz(new Date(), tz), tz)
  if (!range) {
    const err = new Error('Ongeldige datum; gebruik YYYY-MM-DD.')
    err.statusCode = 400
    throw err
  }
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const db = client.db()
    const rows = await db.collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true }, date: { $gte: range.from, $lt: range.to } }, { projection: { _id: 0, sgv: 1, date: 1 } })
      .sort({ date: 1 })
      .toArray()
    const lows = await db.collection('reactive_hypo_episodes')
      .find({ peakAt: { $gte: new Date(range.from).toISOString(), $lt: new Date(range.to).toISOString() } }, {
        projection: {
          _id: 0, peakAt: 1, nadirAt: 1, recoveredAt: 1, peakMmol: 1, nadirMmol: 1,
          dropFromPeakMmol: 1, minutesPeakToNadir: 1, recoveryMinutes: 1, outcome: 1,
          severity: 1, shape: 1, qualityScore: 1, qualityFlags: 1, areaBelow3_9: 1,
          timeBelow3_9Minutes: 1, reboundHigh: 1, reboundPeakMmol: 1,
        },
      })
      .sort({ peakAt: 1 })
      .limit(50)
      .toArray()
    await ensureAuxIndexes(db)
    const contextEvents = await db.collection('cgm_events')
      .find({
        eventAt: {
          $gte: new Date(range.from).toISOString(),
          $lt: new Date(range.to).toISOString(),
        },
      }, { projection: { relatedEntryId: 0 } })
      .sort({ eventAt: -1 })
      .limit(80)
      .toArray()
    const highEpisodes = buildHighEpisodes(rows)
    const highToLow = []
    const usedLows = new Set()
    for (const high of highEpisodes) {
      const highEnd = Date.parse(high.endAt)
      const lowIdx = lows.findIndex((l, i) => {
        if (usedLows.has(i)) return false
        const peak = Date.parse(l.peakAt)
        return Number.isFinite(peak) && peak >= highEnd && peak <= highEnd + 4 * 3_600_000
      })
      if (lowIdx >= 0) {
        usedLows.add(lowIdx)
        const low = lows[lowIdx]
        highToLow.push({
          highPeakAt: high.peakAt,
          highEndAt: high.endAt,
          highPeakMmol: high.peakMmol,
          highDurationMinutes: high.durationMinutes,
          lowPeakAt: low.peakAt,
          lowNadirAt: low.nadirAt,
          lowNadirMmol: low.nadirMmol,
          minutesHighEndToLowPeak: round((Date.parse(low.peakAt) - highEnd) / 60000, 0),
        })
      }
    }
    const expected = expectedSamples(rows, (range.to - range.from) / 60000)
    const stats = summarizeEntries(rows, expected)
    const thresholdLows = buildThresholdLows(rows)
    const burden = lows.reduce((s, e) => s + (Number(e.areaBelow3_9) || 0), 0)
    const worstLow = lows.slice().sort((a, b) => (Number(a.nadirMmol) || 99) - (Number(b.nadirMmol) || 99))[0] || null
    const worstHigh = highEpisodes.slice().sort((a, b) => (Number(b.peakMmol) || 0) - (Number(a.peakMmol) || 0))[0] || null
    const sourceHealth = {
      lastEntryAt: rows.length ? new Date(rows[rows.length - 1].date).toISOString() : null,
      longestGapMinutes: longestGapMinutes(rows),
      level: stats.coveragePct >= 80 ? 'goed' : (stats.coveragePct >= 50 ? 'matig' : 'slecht'),
    }
    const summary = [
      `TIR ${stats.tir}%`,
      `laag ${stats.tbr}%`,
      `${thresholdLows.length} lows <3.9`,
      `${lows.length} daal-episodes`,
      `${highEpisodes.length} high-episodes`,
      `dekking ${stats.coveragePct}%`,
    ].join(' · ')
    const suggestions = buildDaySuggestions({ stats, thresholdLows, lows, highEpisodes, highToLow, contextEvents, sourceHealth })
    return {
      date: dateKey || dayKeyInTz(new Date(), tz),
      window: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString(), timeZone: tz },
      summary,
      stats,
      thresholdLows,
      lowEpisodes: lows,
      highEpisodes,
      highToLow,
      contextEvents,
      suggestions,
      notable: { worstLow, worstHigh, hypoBurden3_9: round(burden, 1) },
      sourceHealth,
    }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

function buildDaySuggestions({ stats, thresholdLows, lows, highEpisodes, highToLow, contextEvents, sourceHealth }) {
  const suggestions = []
  const hasMealContext = (contextEvents || []).some((e) => ['meal', 'snack'].includes(e.type))
  const hasFingerstick = (contextEvents || []).some((e) => e.type === 'fingerstick' || e.fingerstickMmol != null)
  const hasSymptom = (contextEvents || []).some((e) => e.type === 'symptom' || (Array.isArray(e.symptoms) && e.symptoms.length))
  const lowCount = thresholdLows ? thresholdLows.length : 0
  if (sourceHealth && sourceHealth.level !== 'goed') {
    suggestions.push({ type: 'data_quality', label: 'Datakwaliteit checken', question: 'Welke datagaten of missende metingen maken deze dag minder betrouwbaar?' })
  }
  if (lowCount && !hasFingerstick) {
    suggestions.push({ type: 'fingerstick', label: 'Low bevestigen', question: 'Welke lows van deze dag zouden met vingerprik nuttig zijn om te bevestigen?' })
  }
  if ((lows || []).length && !hasMealContext) {
    suggestions.push({ type: 'meal_context', label: 'Maaltijdcontext ontbreekt', question: 'Welke dips lijken mogelijk na eten te komen en welke maaltijdcontext ontbreekt?' })
  }
  if ((highToLow || []).length) {
    suggestions.push({ type: 'high_to_low', label: 'High→low bekijken', question: 'Welke high→low koppelingen op deze dag zijn het meest relevant?' })
  }
  if ((highEpisodes || []).length >= 2) {
    suggestions.push({ type: 'highs', label: 'High episodes vergelijken', question: 'Waardoor vielen de high-episodes van deze dag op ten opzichte van normale dagen?' })
  }
  if (lowCount && !hasSymptom) {
    suggestions.push({ type: 'symptoms', label: 'Symptomen loggen', question: 'Welke lage momenten missen nog symptoomcontext?' })
  }
  if (stats && stats.coveragePct >= 80 && !suggestions.length) {
    suggestions.push({ type: 'summary', label: 'Dag samenvatten', question: 'Vat deze dag samen: wat was opvallend en wat was juist normaal?' })
  }
  return suggestions.slice(0, 5)
}

function compactDayCompare(day) {
  const stats = day && day.stats ? day.stats : {}
  return {
    date: day ? day.date : null,
    tir: stats.tir ?? null,
    tbr: stats.tbr ?? null,
    tar: stats.tar ?? null,
    mean: stats.mean ?? null,
    cv: stats.cv ?? null,
    min: stats.min ?? null,
    max: stats.max ?? null,
    coveragePct: stats.coveragePct ?? null,
    lows: day && day.thresholdLows ? day.thresholdLows.length : null,
    reactiveEpisodes: day && day.lowEpisodes ? day.lowEpisodes.length : null,
    highs: day && day.highEpisodes ? day.highEpisodes.length : null,
    burden3_9: day && day.notable ? day.notable.hypoBurden3_9 : null,
  }
}

function compareDelta(current, other) {
  const delta = {}
  for (const key of ['tir', 'tbr', 'tar', 'mean', 'cv', 'lows', 'reactiveEpisodes', 'highs', 'burden3_9']) {
    const a = current[key]
    const b = other && other[key]
    delta[key] = a != null && b != null ? round(Number(a) - Number(b), 1) : null
  }
  return delta
}

async function getAiDayCompare(dateKey) {
  const tz = process.env.LIBREVIEW_TZ || 'Europe/Amsterdam'
  const date = dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? dateKey : dayKeyInTz(new Date(), tz)
  const prevDate = shiftDateKey(date, -1)
  const weekdayDate = shiftDateKey(date, -7)
  const [currentDay, prevDay, weekdayDay, baseline] = await Promise.all([
    getAiDayReview(date),
    prevDate ? getAiDayReview(prevDate).catch(() => null) : null,
    weekdayDate ? getAiDayReview(weekdayDate).catch(() => null) : null,
    getAiStats(14),
  ])
  const current = compactDayCompare(currentDay)
  const previous = prevDay ? compactDayCompare(prevDay) : null
  const sameWeekday = weekdayDay ? compactDayCompare(weekdayDay) : null
  const base = {
    date: '14d baseline',
    tir: baseline.tir,
    tbr: baseline.tbr,
    tar: baseline.tar,
    mean: baseline.mean,
    cv: baseline.cv,
    lows: baseline.lows ? round(baseline.lows.count / 14, 1) : null,
    reactiveEpisodes: baseline.reactive ? round(baseline.reactive.total / 14, 1) : null,
    highs: baseline.highToLowContext ? round(baseline.highToLowContext.total / 14, 1) : null,
    burden3_9: baseline.reactive ? round(baseline.reactive.totalAreaBelow3_9 / 14, 1) : null,
    coveragePct: baseline.coveragePct,
  }
  return {
    date,
    current,
    comparisons: {
      previous: previous ? { date: prevDate, values: previous, delta: compareDelta(current, previous) } : null,
      sameWeekday: sameWeekday ? { date: weekdayDate, values: sameWeekday, delta: compareDelta(current, sameWeekday) } : null,
      baseline14d: { values: base, delta: compareDelta(current, base) },
    },
  }
}

function longestGapMinutes(rows) {
  let longest = 0
  for (let i = 1; i < rows.length; i += 1) {
    longest = Math.max(longest, Math.round((rows[i].date - rows[i - 1].date) / 60000))
  }
  return longest
}

// Drempel-gebaseerde lows: elke aaneengesloten run onder 3.9 mmol telt als één low,
// los van of er een reactieve piek aan voorafging. Dit matcht hoe de Libre-app en de
// gekleurde puntjes op de Nightscout-lijn lows tellen (een low is een low). Staat los
// van de reactieve piek→daling episode-builder, die ML/backtest voedt en ongemoeid blijft.
function buildThresholdLows(rows, options = {}) {
  const thresholdMmol = options.thresholdMmol ?? 3.9
  const gapMs = (options.gapMinutes ?? 30) * 60000
  const sampleMinutes = options.sampleMinutes ?? medianIntervalMinutes(rows) ?? 1
  const runs = []
  let cur = null
  const flush = () => {
    if (!cur) return
    const measuredDuration = (cur.lastDate - cur.startDate) / 60000
    const durationMinutes = cur.count === 1
      ? Math.max(sampleMinutes, measuredDuration)
      : measuredDuration
    runs.push({
      startAt: new Date(cur.startDate).toISOString(),
      nadirAt: new Date(cur.nadirDate).toISOString(),
      endAt: new Date(cur.lastDate).toISOString(),
      nadirMmol: round(cur.nadirMmol, 3),
      durationMinutes: round(durationMinutes, 1),
      pointCount: cur.count,
      areaBelow3_9: round(cur.area, 3),
    })
    cur = null
  }
  for (const r of rows) {
    const v = Number(r.sgv) / MGDL_PER_MMOL
    const t = r.date
    if (v < thresholdMmol) {
      // Een datagat groter dan gapMs splitst de run: het is dan een aparte low.
      if (cur && t - cur.lastDate > gapMs) flush()
      if (!cur) {
        cur = { startDate: t, lastDate: t, nadirDate: t, nadirMmol: v, prevMmol: v, count: 0, area: 0 }
      } else {
        const dtMin = (t - cur.lastDate) / 60000
        if (dtMin > 0) cur.area += (((thresholdMmol - cur.prevMmol) + (thresholdMmol - v)) / 2) * dtMin
      }
      if (v < cur.nadirMmol) { cur.nadirMmol = v; cur.nadirDate = t }
      cur.lastDate = t
      cur.prevMmol = v
      cur.count += 1
    } else {
      flush()
    }
  }
  flush()
  return runs
}

function medianIntervalMinutes(rows) {
  const gaps = []
  for (let i = 1; i < rows.length; i += 1) {
    const g = (rows[i].date - rows[i - 1].date) / 60000
    if (g > 0 && g < 30) gaps.push(g)
  }
  if (!gaps.length) return null
  gaps.sort((a, b) => a - b)
  return round(gaps[Math.floor(gaps.length / 2)], 1)
}

// Gedeelde dekkings-noemer: verwacht aantal metingen in een venster van `windowMinutes`,
// data-gedreven uit de werkelijke mediane meetinterval (valt terug op de nominale cadans).
// Eén bron van waarheid zodat statistiek/history/dag/feed én source-health dezelfde
// dekking% rapporteren, ook als de cadans ooit afwijkt van 1/min.
function expectedSamples(rows, windowMinutes) {
  const step = medianIntervalMinutes(rows) || NOMINAL_INTERVAL_MIN
  return Math.max(1, Math.round(windowMinutes / step))
}

// Source-health als first-class inzicht (SmartXdrip §20.2). Deterministisch, geen LLM.
// status good/watch/bad + reasons[] sturen hoe stellig rapporten/chat mogen zijn.
async function getSourceHealth() {
  if (sourceHealthCache.data && Date.now() - sourceHealthCache.at < 15_000) {
    return sourceHealthCache.data
  }
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const db = client.db()
    const now = Date.now()
    const from14 = now - 14 * 24 * 3_600_000
    const from24 = now - 24 * 3_600_000
    const rows = await db.collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true }, date: { $gte: from14 } }, { projection: { _id: 0, date: 1 } })
      .sort({ date: 1 })
      .toArray()
    const last = rows.length ? rows[rows.length - 1].date : null
    const ageMinutes = last != null ? round((now - last) / 60000, 0) : null
    const rows24 = rows.filter((r) => r.date >= from24)
    const medianInterval = medianIntervalMinutes(rows) || NOMINAL_INTERVAL_MIN
    const expected14 = expectedSamples(rows, 14 * 24 * 60)
    const expected24 = expectedSamples(rows24, 24 * 60)
    const coverage14d = round(Math.min(100, (rows.length / expected14) * 100), 0)
    const coverageToday = round(Math.min(100, (rows24.length / expected24) * 100), 0)
    const longestGap24h = longestGapMinutes(rows24)
    const longestGap14d = longestGapMinutes(rows)
    const reasons = []
    if (ageMinutes == null || ageMinutes > 30) reasons.push('stale')
    else if (ageMinutes > 15) reasons.push('stale_soon')
    if (longestGap24h > 60) reasons.push('large_gap')
    if (coverage14d < 70) reasons.push('low_coverage')
    let status = 'good'
    if (ageMinutes == null || ageMinutes > 30 || coverage14d < 50) status = 'bad'
    else if (ageMinutes > 15 || coverage14d < 70 || longestGap24h > 60) status = 'watch'
    const data = {
      lastEntryAt: last != null ? new Date(last).toISOString() : null,
      ageMinutes,
      expectedIntervalMin: medianInterval,
      coverageToday,
      coverage14d,
      longestGap24hMin: longestGap24h,
      longestGap14dMin: longestGap14d,
      status,
      reasons,
    }
    sourceHealthCache = { at: Date.now(), data }
    return data
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

// History (SmartXdrip §19.2): dag-voor-dag overzicht, nieuw->oud. Deterministisch,
// puur Mongo-reads — geen LLM. Maakt moeilijke dagen vindbaar.
async function getAiHistory(days) {
  const tz = process.env.LIBREVIEW_TZ || 'Europe/Amsterdam'
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const db = client.db()
    const to = Date.now()
    const from = to - days * 86_400_000
    const rows = await db.collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true }, date: { $gte: from } }, { projection: { _id: 0, sgv: 1, date: 1 } })
      .sort({ date: 1 }).toArray()
    const episodes = await db.collection('reactive_hypo_episodes')
      .find({ peakAt: { $gte: new Date(from).toISOString() } }, {
        projection: {
          _id: 0,
          peakAt: 1,
          nadirAt: 1,
          peakMmol: 1,
          nadirMmol: 1,
          outcome: 1,
          severity: 1,
          shape: 1,
          dropFromPeakMmol: 1,
          areaBelow3_9: 1,
        },
      })
      .toArray()
    const byDay = new Map()
    for (const r of rows) {
      const key = dayKeyInTz(new Date(r.date), tz)
      if (!byDay.has(key)) byDay.set(key, [])
      byDay.get(key).push(r)
    }
    const episodesByDay = new Map()
    for (const l of episodes) {
      const key = dayKeyInTz(new Date(Date.parse(l.peakAt)), tz)
      if (!episodesByDay.has(key)) episodesByDay.set(key, [])
      episodesByDay.get(key).push(l)
    }
    const history = []
    for (const [date, dayRows] of byDay) {
      const stats = summarizeEntries(dayRows, expectedSamples(dayRows, 1440))
      const dayEpisodes = episodesByDay.get(date) || []
      const dayLows = dayEpisodes.filter((e) => Number(e.nadirMmol) < 3.9)
      const dayNear = dayEpisodes.filter((e) => Number(e.nadirMmol) >= 3.9 && Number(e.nadirMmol) < 4.5)
      const dayDips = dayEpisodes.filter((e) => Number(e.nadirMmol) >= 4.5)
      const highs = buildHighEpisodes(dayRows)
      const burden = dayLows.reduce((s, e) => s + (Number(e.areaBelow3_9) || 0), 0)
      const worstLow = dayLows.slice().sort((a, b) => (Number(a.nadirMmol) || 99) - (Number(b.nadirMmol) || 99))[0] || null
      const worstEpisode = dayEpisodes.slice().sort((a, b) => (Number(a.nadirMmol) || 99) - (Number(b.nadirMmol) || 99))[0] || null
      history.push({
        date,
        tir: stats.tir, tbr: stats.tbr, tar: stats.tar, mean: stats.mean, cv: stats.cv,
        min: stats.min, max: stats.max, coverage: stats.coveragePct,
        episodeCount: dayEpisodes.length,
        lowCount: dayLows.length,
        nearHypoCount: dayNear.length,
        dipCount: dayDips.length,
        highCount: highs.length,
        hypoBurden3_9: round(burden, 1),
        worstLowMmol: worstLow ? worstLow.nadirMmol : null,
        worstEpisodeMmol: worstEpisode ? worstEpisode.nadirMmol : null,
        recentEpisodes: dayEpisodes
          .slice()
          .sort((a, b) => Date.parse(b.peakAt) - Date.parse(a.peakAt))
          .slice(0, 3),
        worstHighMmol: highs.length ? Math.max(...highs.map((h) => h.peakMmol)) : null,
        sourceLevel: stats.coveragePct >= 80 ? 'goed' : (stats.coveragePct >= 50 ? 'matig' : 'slecht'),
      })
    }
    history.sort((a, b) => (a.date < b.date ? 1 : -1))
    return { window: { days, from: new Date(from).toISOString(), to: new Date(to).toISOString() }, history }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

// Notes/event-logging (SmartXdrip §20.4 / §14): grootste hefboom voor reactieve hypo —
// koppelt maaltijden/symptomen aan dips. Beschrijvend, nooit voorschrift.
// (CGM_EVENT_TYPES staat bovenaan i.v.m. de top-level-await TDZ.)
async function writeCgmEvent(body) {
  const rawType = String((body && body.type) || '').trim().toLowerCase()
  const type = CGM_EVENT_TYPES.has(rawType) ? rawType : 'note'
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const db = client.db()
    await ensureAuxIndexes(db)
    const eventAt = body && body.eventAt && Number.isFinite(Date.parse(body.eventAt))
      ? new Date(body.eventAt).toISOString()
      : new Date().toISOString()
    const eMs = Date.parse(eventAt)
    const near = await db.collection('entries')
      .find({ type: 'sgv', date: { $gte: eMs - 15 * 60000, $lte: eMs + 15 * 60000 } }, { projection: { _id: 1, identifier: 1, date: 1, sgv: 1 } })
      .toArray()
    const nearest = near.sort((a, b) => Math.abs(a.date - eMs) - Math.abs(b.date - eMs))[0] || null
    const doc = {
      createdAt: new Date().toISOString(),
      eventAt,
      type,
      note: body && body.note ? String(body.note).slice(0, 500) : null,
      carbLevel: body && body.carbLevel ? String(body.carbLevel).slice(0, 40) : null,
      proteinFat: body && body.proteinFat ? String(body.proteinFat).slice(0, 40) : null,
      exerciseIntensity: body && body.exerciseIntensity ? String(body.exerciseIntensity).slice(0, 40) : null,
      symptoms: Array.isArray(body && body.symptoms) ? body.symptoms.slice(0, 10).map((s) => String(s).slice(0, 40)) : [],
      fingerstickMmol: body && Number.isFinite(Number(body.fingerstickMmol)) ? round(Number(body.fingerstickMmol), 1) : null,
      relatedEntryId: nearest ? nearest._id : null,
      relatedEntryIdentifier: nearest ? nearest.identifier ?? null : null,
      relatedEntryMmol: nearest && Number.isFinite(nearest.sgv) ? round(Number(nearest.sgv) / MGDL_PER_MMOL, 2) : null,
    }
    const r = await db.collection('cgm_events').insertOne(doc)
    return { id: String(r.insertedId), type }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

async function getCgmEvents(limit) {
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    await ensureAuxIndexes(client.db())
    return await client.db().collection('cgm_events')
      .find({}, { projection: { relatedEntryId: 0 } })
      .sort({ eventAt: -1 }).limit(limit).toArray()
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

async function getCgmEventsInRange(fromMs, toMs, limit = 50) {
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    await ensureAuxIndexes(client.db())
    return await client.db().collection('cgm_events')
      .find({
        eventAt: {
          $gte: new Date(fromMs).toISOString(),
          $lt: new Date(toMs).toISOString(),
        },
      }, { projection: { relatedEntryId: 0 } })
      .sort({ eventAt: -1 }).limit(limit).toArray()
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

async function buildAiScopedContext(scope) {
  const type = String((scope && scope.type) || '').trim()
  if (type === 'period' || type === 'weekly') {
    const days = Math.max(1, Math.min(90, Number(scope.days || (type === 'weekly' ? 7 : 14))))
    const [stats, episodeResult, history, sourceHealth, recentEvents] = await Promise.all([
      getAiStats(days),
      getAiEpisodes(30, days),
      getAiHistory(days),
      getSourceHealth(),
      getCgmEvents(80),
    ])
    return {
      scope: { type, days, from: stats.window?.from || null, to: stats.window?.to || null },
      stats,
      episodes: episodeResult.episodes || [],
      history: history.history || [],
      sourceHealth,
      recentEvents,
    }
  }
  if (type !== 'day') return null
  const date = String((scope && scope.date) || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const err = new Error('Dagcontext mist een geldige datum (YYYY-MM-DD).')
    err.statusCode = 400
    throw err
  }
  const tz = process.env.LIBREVIEW_TZ || 'Europe/Amsterdam'
  const range = localDayRange(date, tz)
  if (!range) {
    const err = new Error('Ongeldige dagcontext.')
    err.statusCode = 400
    throw err
  }
  const [day, glucoseFeed, sourceHealth, userEvents] = await Promise.all([
    getAiDayReview(date),
    getGlucoseEventsFeed(date),
    getSourceHealth(),
    getCgmEventsInRange(range.from, range.to, 80),
  ])
  return {
    scope: { type: 'day', date, timeZone: tz, from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() },
    day,
    glucoseEvents: {
      summary: glucoseFeed.summary,
      highEpisodeCount: glucoseFeed.highEpisodeCount,
      events: (glucoseFeed.events || []).slice(0, 80),
    },
    userEvents,
    sourceHealth,
  }
}

// Server-side tijdweergave: forceer de lokale tijdzone. Zonder timeZone-optie pakt
// toLocaleString de tijdzone van het server-proces (= UTC in de Docker-container),
// waardoor server-gerenderde tijden 2u afwijken van de client-panelen (CEST). Zie
// dayKeyInTz/localDayRange die dezelfde LIBREVIEW_TZ gebruiken.
function fmtLocalNL(value) {
  if (value == null) return '–'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '–'
  return d.toLocaleString('nl-NL', { timeZone: process.env.LIBREVIEW_TZ || 'Europe/Amsterdam' })
}

// Pattern cards (SmartXdrip §19.5): deterministische Inzichten-kaarten, geen LLM.
async function getAiPatterns() {
  const [stats, health] = await Promise.all([getAiStats(14), getSourceHealth()])
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const db = client.db()
    const since14 = new Date(Date.now() - 14 * 86_400_000).toISOString()
    const eps = await db.collection('reactive_hypo_episodes')
      .find({ peakAt: { $gte: since14 } }, { projection: { _id: 0, qualityFlags: 1 } }).toArray()
    const recentEpisodes = await db.collection('reactive_hypo_episodes')
      .find({ peakAt: { $gte: since14 } }, {
        projection: {
          _id: 0,
          peakAt: 1,
          nadirAt: 1,
          peakMmol: 1,
          nadirMmol: 1,
          outcome: 1,
          severity: 1,
          dropFromPeakMmol: 1,
          areaBelow3_9: 1,
        },
      })
      .sort({ peakAt: -1 })
      .limit(5)
      .toArray()
    const rows = await db.collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true }, date: { $gte: Date.now() - 14 * 86_400_000 } }, { projection: { _id: 0, sgv: 1, date: 1 } })
      .sort({ date: 1 }).toArray()
    const lowEps = await db.collection('reactive_hypo_episodes')
      .find({ peakAt: { $gte: since14 } }, { projection: { _id: 0, peakAt: 1, nadirMmol: 1 } }).toArray()
    const highs = buildHighEpisodes(rows)
    const lowEpsSorted = lowEps.slice().sort((a, b) => Date.parse(a.peakAt) - Date.parse(b.peakAt))
    const usedLowEps = new Set()
    let highToLow = 0
    for (const h of highs) {
      const hEnd = Date.parse(h.endAt)
      const idx = lowEpsSorted.findIndex((l, i) => { if (usedLowEps.has(i)) return false; const p = Date.parse(l.peakAt); return p >= hEnd && p <= hEnd + 4 * 3_600_000 })
      if (idx >= 0) { usedLowEps.add(idx); highToLow++ }
    }
    const artefacts = eps.filter((e) => Array.isArray(e.qualityFlags) && (e.qualityFlags.includes('single_point_low') || e.qualityFlags.includes('possible_compression_low'))).length
    const worstHour = (stats.perHour || []).filter((p) => p.n >= 10).sort((a, b) => b.lowPct - a.lowPct)[0] || null
    const worstDay = (stats.perWeekday || []).filter((p) => p.n >= 30).sort((a, b) => b.lowPct - a.lowPct)[0] || null
    const cards = []
    const trendDays = stats.trend.prevDays ?? 14
    cards.push({ key: 'week', title: `Laatste ${trendDays}d vs vorige ${trendDays}d`, body: `TIR ${stats.trend.recentTir ?? '–'}% (was ${stats.trend.prevTir ?? '–'}%, Δ ${stats.trend.tirDelta ?? '–'}) · laag ${stats.trend.recentLowPct ?? '–'}% (was ${stats.trend.prevLowPct ?? '–'}%)` })
    if (stats.reactive) {
      const r = stats.reactive
      cards.push({
        key: 'reactive_mix',
        title: 'Hypo’s, near-hypo’s en dips',
        body: `${r.hypo} hypo · ${r.nearHypo} near-hypo · ${r.safeDrop} dips/safe drops · mediane nadir ${r.medianNadirMmol ?? '–'} mmol`,
      })
      cards.push({
        key: 'hypo_burden',
        title: 'Hypo-belasting',
        body: `<3.9 totaal ${r.totalTimeBelow3_9Min ?? '–'} min · burden ${r.totalAreaBelow3_9 ?? '–'} mmol·min · artefactflags ${r.artefactFlags?.singlePoint ?? 0}/${r.artefactFlags?.possibleCompression ?? 0}`,
      })
      if (stats.latestEntryAt || r.latestPeakAt) {
        // Build loopt achter = de builder heeft de nieuwste metingen nog niet
        // verwerkt (latestEntry veel nieuwer dan laatste build). NIET: er was
        // geen recente daling — dat is de gezonde toestand.
        const buildLagMin = stats.latestEntryAt && stats.episodesBuiltAt
          ? round((Date.parse(stats.latestEntryAt) - Date.parse(stats.episodesBuiltAt)) / 60000, 0)
          : null
        const stale = buildLagMin != null && buildLagMin > 60
        cards.push({
          key: 'freshness',
          title: 'Recentheid episodes',
          body: `Nieuwste CGM ${fmtLocalNL(stats.latestEntryAt)} · nieuwste episode ${fmtLocalNL(r.latestPeakAt)}${stats.episodesBuiltAt ? ` · episodes bijgewerkt ${fmtLocalNL(stats.episodesBuiltAt)}` : ''}${stale ? ' · build loopt achter: draai episodes:build' : ''}`,
        })
      }
    }
    if (recentEpisodes.length) {
      const parts = recentEpisodes.slice(0, 3).map((e) => {
        const kind = Number(e.nadirMmol) < 3.9 ? 'low' : 'dip'
        return `${fmtLocalNL(e.nadirAt || e.peakAt)} ${kind} ${e.nadirMmol} mmol (${e.outcome || '–'})`
      })
      cards.push({ key: 'recent_episodes', title: 'Recente lows/dips', body: parts.join(' · ') })
    }
    if (worstHour) cards.push({ key: 'window', title: 'Kwetsbaar venster', body: `Meeste laag rond ${worstHour.hour}:00 (${worstHour.lowPct}% laag)${worstDay ? ` · zwaarste dag ${worstDay.day} (${worstDay.lowPct}%)` : ''}` })
    if (stats.highToLowContext) {
      const top = stats.highToLowContext.top && stats.highToLowContext.top[0]
      cards.push({
        key: 'high_low',
        title: 'High→low patroon',
        body: `${stats.highToLowContext.relevant} relevant van ${stats.highToLowContext.total} koppeling(en) · ${top ? `sterkste: high ${top.highPeakMmol} → low ${top.lowNadirMmol} mmol (${(top.relevantReasons || []).join(', ')})` : `${highToLow} gekoppeld`}`,
      })
    } else {
      cards.push({ key: 'high_low', title: 'High→low patroon', body: `${highToLow} gekoppelde high→low gebeurtenis(sen) in 14 dagen` })
    }
    cards.push({ key: 'quality', title: 'Datakwaliteit', body: `14d-dekking ${health.coverage14d}% · langste gat 24u ${health.longestGap24hMin}m · status ${health.status}` })
    cards.push({ key: 'artefacts', title: 'Artefact-check', body: `${artefacts} episode(s) met single-point/compression-low flag` })
    return { cards, sourceHealth: health }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

// Helper-reminders (SmartXdrip §20.1): expliciet NIET-medische helpers. Deterministisch
// gegenereerd uit de huidige toestand; ack/snooze-state in `helper_reminders`. Geen alarm,
// geen behandeladvies, nooit een vervanging voor de Nightscout/hypo-alarmen.
async function getHelperReminders() {
  const health = await getSourceHealth()
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const db = client.db()
    await ensureAuxIndexes(db)
    const now = Date.now()
    // Retentie: transient ack/snooze-state ouder dan 30d opruimen (de conditie keert
    // anders terug en genereert verse state). cgm_events (gebruikersnotities) NIET wissen.
    await db.collection('helper_reminders').deleteMany({ createdAt: { $lt: new Date(now - 30 * 86_400_000).toISOString() } }).catch(() => undefined)
    const states = await db.collection('helper_reminders').find({}).toArray()
    const stateByKey = new Map(states.map((s) => [s.key, s]))
    const candidates = []
    if (health.status === 'bad' || health.reasons.includes('stale')) {
      candidates.push({ key: 'source_stale', type: 'source', severity: 'watch', title: 'CGM-data verouderd', message: `Laatste meting ${health.ageMinutes ?? '?'} min geleden. Controleer sensor/sync.` })
    }
    if (health.reasons.includes('large_gap')) {
      candidates.push({ key: 'large_gap', type: 'source', severity: 'info', title: 'Lang datagat', message: `Langste gat (24u): ${health.longestGap24hMin} min.` })
    }
    if (health.reasons.includes('low_coverage')) {
      candidates.push({ key: 'low_coverage', type: 'source', severity: 'info', title: 'Lage datadekking', message: `14d-dekking ${health.coverage14d}%. Conclusies zijn minder stevig.` })
    }
    const since48 = new Date(now - 48 * 3_600_000).toISOString()
    const severe = await db.collection('reactive_hypo_episodes')
      .find({ peakAt: { $gte: since48 }, severity: { $in: ['relevant', 'severe'] } }, { projection: { _id: 0, peakAt: 1, nadirMmol: 1, severity: 1 } })
      .sort({ peakAt: -1 }).toArray()
    if (severe.length) {
      const anyFeedback = await db.collection('user_feedback').countDocuments({ createdAt: { $gte: since48 } })
      const anyEvent = await db.collection('cgm_events').countDocuments({ createdAt: { $gte: since48 } })
      if (!anyFeedback && !anyEvent) {
        const s = severe[0]
        candidates.push({ key: 'episode_no_context', type: 'review', severity: 'info', title: 'Ernstige dip zonder context', message: `Low ${s.nadirMmol} mmol (${s.severity}) zonder notitie. Voeg context toe als je wilt.` })
      }
    }
    const reminders = candidates.filter((c) => {
      const st = stateByKey.get(c.key)
      if (!st) return true
      // Ack onderdrukt tijdelijk (12u), niet permanent: deze condities zijn terugkerend
      // (bron stale, datagat). Anders zou één keer "gezien" de reminder voorgoed dempen.
      if (st.acknowledgedAt && (now - Date.parse(st.acknowledgedAt)) < 12 * 3_600_000) return false
      if (st.snoozedUntil && Date.parse(st.snoozedUntil) > now) return false
      return true
    })
    return { reminders }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

async function setReminderState(body) {
  const key = String((body && body.key) || '').trim()
  const action = String((body && body.action) || '').trim()
  if (!key) { const e = new Error('key ontbreekt.'); e.statusCode = 400; throw e }
  const patch = action === 'ack'
    ? { acknowledgedAt: new Date().toISOString() }
    : action === 'snooze'
      ? { snoozedUntil: new Date(Date.now() + 30 * 60000).toISOString() }
      : null
  if (!patch) { const e = new Error('onbekende actie (ack|snooze).'); e.statusCode = 400; throw e }
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    await ensureAuxIndexes(client.db())
    await client.db().collection('helper_reminders').updateOne(
      { key },
      { $set: { ...patch, key }, $setOnInsert: { createdAt: new Date().toISOString() } },
      { upsert: true },
    )
    return { ok: true }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

// Evaluatie (§18): deterministische metrics — meet of de hypo-laag echt nuttiger wordt.
async function getEvaluation(days) {
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const db = client.db()
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    const eps = await db.collection('reactive_hypo_episodes')
      .find({ peakAt: { $gte: since } }, { projection: { _id: 0, severity: 1, areaBelow3_9: 1, areaBelow3_0: 1, recoveryMinutes: 1, qualityScore: 1, qualityFlags: 1, timeOfDayBucket: 1, postprandialCandidate: 1 } })
      .toArray()
    const fb = await db.collection('user_feedback').find({ createdAt: { $gte: since } }, { projection: { _id: 0, type: 1 } }).toArray()
    const bySeverity = {}
    const byTimeOfDay = {}
    eps.forEach((e) => {
      const s = e.severity || 'onbekend'; bySeverity[s] = (bySeverity[s] || 0) + 1
      const b = e.timeOfDayBucket || 'onbekend'; byTimeOfDay[b] = (byTimeOfDay[b] || 0) + 1
    })
    // Zie summarizeReactiveEpisodes: nooit-herstelde episodes (recoveryMinutes null)
    // niet als 0 meetellen — anders lijkt het herstel kunstmatig snel.
    const recoveries = eps.filter((e) => e.recoveryMinutes != null).map((e) => Number(e.recoveryMinutes)).filter(Number.isFinite).sort((a, b) => a - b)
    const total = eps.length
    const poorQuality = eps.filter((e) => Number(e.qualityScore) < 70).length
    const fingerstick = eps.filter((e) => Array.isArray(e.qualityFlags) && e.qualityFlags.includes('fingerstick_confirmed')).length
    const postprandial = eps.filter((e) => e.postprandialCandidate).length
    const fbCounts = {}
    fb.forEach((f) => { fbCounts[f.type] = (fbCounts[f.type] || 0) + 1 })
    return {
      window: { days, from: since, to: new Date().toISOString() },
      episodes: total,
      bySeverity,
      areaBelow3_9: round(eps.reduce((s, e) => s + (Number(e.areaBelow3_9) || 0), 0), 1),
      areaBelow3_0: round(eps.reduce((s, e) => s + (Number(e.areaBelow3_0) || 0), 0), 1),
      medianRecoveryMin: median(recoveries),
      pctPoorQuality: total ? round((poorQuality / total) * 100, 0) : 0,
      pctFingerstickConfirmed: total ? round((fingerstick / total) * 100, 0) : 0,
      pctPostprandial: total ? round((postprandial / total) * 100, 0) : 0,
      byTimeOfDay,
      feedback: fbCounts,
    }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

// D/C — Genereert één narratief rapport (1 LLM-call) achter dezelfde lock als de
// review, zodat de free-tier nooit door spam wordt geraakt.
async function runAiReportOnce({ type, date, days } = {}) {
  if (aiReviewRunning) {
    const err = new Error('Er draait al een AI-taak.')
    err.statusCode = 409
    throw err
  }
  const since = Date.now() - aiReviewLastAt
  if (aiReviewLastAt && since < AI_REVIEW_MIN_INTERVAL_MS) {
    const err = new Error(`Te snel achter elkaar; wacht ${Math.ceil((AI_REVIEW_MIN_INTERVAL_MS - since) / 1000)}s.`)
    err.statusCode = 429
    throw err
  }
  const aiRouter = resolveAiRouterConfig()
  if (!aiRouterConfigured(aiRouter)) {
    return { ok: true, skipped: true, reason: 'Geen AI-provider geconfigureerd.' }
  }
  aiReviewRunning = true
  let client = null
  try {
    const reportType = String(type || 'daily')
    const scopedContext = date
      ? await buildAiScopedContext({ type: 'day', date })
      : (reportType === 'weekly' || reportType === 'period')
        ? await buildAiScopedContext({ type: reportType, days: days || (reportType === 'weekly' ? 7 : 14) })
        : null
    const statDays = scopedContext && scopedContext.scope && scopedContext.scope.days ? scopedContext.scope.days : 14
    const [stats, episodeResult] = await Promise.all([getAiStats(statDays), getAiEpisodes(20, statDays)])
    const episodes = episodeResult.episodes || []
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const db = client.db()
    const feedback = await db.collection('user_feedback')
      .find({}, { projection: { createdAt: 1, type: 1, note: 1, relatedEntryIdentifier: 1, relatedEntryMmol: 1, riskAtFeedback: 1 } })
      .sort({ createdAt: -1 }).limit(20).toArray()
    const result = await runAiReport({ db, aiRouter, stats, episodes, feedback, type: reportType, context: scopedContext })
    aiReviewLastAt = Date.now()
    return result
  } finally {
    aiReviewRunning = false
    if (client) await client.close().catch(() => undefined)
  }
}

// Chat: 1 LLM-call per bericht. Wel de concurrency-lock (1 tegelijk), maar GÉÉN
// min-interval (anders is chatten onbruikbaar traag).
async function runAiChatOnce({ messages, scope } = {}) {
  if (aiReviewRunning) {
    const err = new Error('Er draait al een AI-taak; even wachten.')
    err.statusCode = 409
    throw err
  }
  const aiRouter = resolveAiRouterConfig()
  if (!aiRouterConfigured(aiRouter)) {
    return { ok: true, skipped: true, reason: 'Geen AI-provider geconfigureerd.' }
  }
  aiReviewRunning = true
  let client = null
  try {
    const scopedContext = await buildAiScopedContext(scope)
    const [stats, episodeResult] = await Promise.all([getAiStats(14), getAiEpisodes(10, 14)])
    const episodes = episodeResult.episodes || []
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const db = client.db()
    const [observations, feedback] = await Promise.all([
      db.collection('ai_observations').find({}).sort({ createdAt: -1 }).limit(8).toArray(),
      db.collection('user_feedback')
        .find({}, { projection: { createdAt: 1, type: 1, note: 1, relatedEntryIdentifier: 1, relatedEntryMmol: 1, riskAtFeedback: 1 } })
        .sort({ createdAt: -1 }).limit(20).toArray(),
    ])
    return await runAiChat({ aiRouter, messages, stats, episodes, observations, feedback, context: scopedContext })
  } finally {
    aiReviewRunning = false
    if (client) await client.close().catch(() => undefined)
  }
}

async function getAiReports(limit) {
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    return await client.db().collection('ai_reports')
      .find({}, { projection: { 'stats.perHour': 0, contextSnapshot: 0 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

// B — Reactieve-hypo episodes. Deterministisch uit `reactive_hypo_episodes`, geen LLM.
async function getAiEpisodes(limit, days = null) {
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const from = days ? new Date(Date.now() - days * 86_400_000).toISOString() : null
    const filter = from ? { peakAt: { $gte: from } } : {}
    const collection = client.db().collection('reactive_hypo_episodes')
    const [episodes, total] = await Promise.all([
      collection.find(filter, {
        projection: {
          _id: 0,
          peakAt: 1,
          nadirAt: 1,
          recoveredAt: 1,
          peakMmol: 1,
          nadirMmol: 1,
          dropFromPeakMmol: 1,
          peakToNadirDeltaMmol: 1,
          dropFromPeakPercent: 1,
          minutesPeakToNadir: 1,
          recoveryMinutes: 1,
          maxFallRate30m: 1,
          fallRateMmolPerMin: 1,
          outcome: 1,
          severity: 1,
          shape: 1,
          whippleClass: 1,
          qualityFlags: 1,
          qualityScore: 1,
          timeBelow3_9Minutes: 1,
          timeBelow3_0Minutes: 1,
          areaBelow3_9: 1,
          areaBelow3_0: 1,
          reboundHigh: 1,
          reboundPeakMmol: 1,
          reboundMinutesAfterRecovery: 1,
          nightEpisode: 1,
          timeOfDayBucket: 1,
          postprandialCandidate: 1,
          startMmol: 1,
          endMmol: 1,
          minutesPeakToUnder40: 1,
          minutesPeakToUnder45: 1,
        },
      })
      .sort({ peakAt: -1 })
      .limit(limit)
      .toArray(),
      collection.countDocuments(filter),
    ])
    return {
      window: days ? { days, from, to: new Date().toISOString() } : null,
      total,
      returned: episodes.length,
      truncated: total > episodes.length,
      episodes,
    }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

// Explore-overzicht: recente high- én low-episodes naast elkaar, elk met een peakAt
// zodat de overlay het bestaande episode-detail-endpoint kan openen. Geen LLM.
async function getExploreEpisodes(days = 14, limit = 20) {
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const db = client.db()
    const from = Date.now() - days * 86_400_000
    const rows = await db.collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true }, date: { $gte: from } }, { projection: { _id: 0, sgv: 1, date: 1 } })
      .sort({ date: 1 }).toArray()
    const highs = buildHighEpisodes(rows)
      .sort((a, b) => Date.parse(b.peakAt) - Date.parse(a.peakAt))
      .slice(0, limit)
    const lows = await db.collection('reactive_hypo_episodes')
      .find({ peakAt: { $gte: new Date(from).toISOString() } }, {
        projection: { _id: 0, peakAt: 1, nadirAt: 1, nadirMmol: 1, peakMmol: 1, dropFromPeakMmol: 1, minutesPeakToNadir: 1, recoveryMinutes: 1, severity: 1, outcome: 1, timeOfDayBucket: 1 },
      })
      .sort({ peakAt: -1 }).limit(limit).toArray()
    return { window: { days, from: new Date(from).toISOString(), to: new Date().toISOString() }, highs, lows }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

// History-feed voor één dag: dag-tegels (TIR/AVG/PEAK/CV) + de intraday event-stroom
// (eerste meting, lokale pieken, high-episodes, herstel, stabiele vensters). De
// high-episode-events dragen peakAt zodat de overlay naar de Explore-detail kan linken.
async function getGlucoseEventsFeed(dateParam) {
  const tz = process.env.LIBREVIEW_TZ || 'Europe/Amsterdam'
  const dateKey = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : dayKeyInTz(new Date(), tz)
  const range = localDayRange(dateKey, tz)
  if (!range) { const err = new Error('Ongeldige datum (YYYY-MM-DD).'); err.statusCode = 400; throw err }
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const rows = await client.db().collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true }, date: { $gte: range.from, $lt: range.to } }, { projection: { _id: 0, sgv: 1, date: 1, dateString: 1 } })
      .sort({ date: 1 }).toArray()
    const expectedCount = expectedSamples(rows, (range.to - range.from) / 60_000)
    const summary = summarizeEntries(rows, expectedCount)
    const events = buildGlucoseEvents(rows).slice().reverse()
    const highEpisodeCount = events.filter((e) => e.type === 'high_episode').length
    return { date: dateKey, window: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() }, summary, events, highEpisodeCount }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

// Trapezoïdale integratie boven/onder een grens over reading-punten ({t:ms, mmol}).
// Gaten > 30 min worden overgeslagen (geen interpolatie over ontbrekende data).
function integrateBeyond(pts, threshold, direction) {
  let minutes = 0
  let area = 0
  for (let i = 1; i < pts.length; i += 1) {
    const dtMin = (pts[i].t - pts[i - 1].t) / 60000
    if (!(dtMin > 0) || dtMin > 30) continue
    const a = direction === 'above' ? pts[i - 1].mmol - threshold : threshold - pts[i - 1].mmol
    const b = direction === 'above' ? pts[i].mmol - threshold : threshold - pts[i].mmol
    const aPos = Math.max(0, a)
    const bPos = Math.max(0, b)
    area += ((aPos + bPos) / 2) * dtMin
    if (aPos > 0 && bPos > 0) minutes += dtMin
    else if (aPos > 0 || bPos > 0) minutes += dtMin / 2
  }
  return { minutes: round(minutes, 0), area: round(area, 1) }
}

function hourInTz(ms, tz) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(ms))) % 24
}
function todBucket(ms, tz) { const h = hourInTz(ms, tz); return h < 6 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening' }
function clockMinutes(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms))
  let hh = 0, mm = 0
  for (const p of parts) { if (p.type === 'hour') hh = Number(p.value); if (p.type === 'minute') mm = Number(p.value) }
  return (hh % 24) * 60 + mm
}
function hmFromMin(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') }

// Pattern-analyse: hoeveel episodes van hetzelfde type in hetzelfde tijdvenster (bucket),
// over een venster, met tijdsbereik + verdeling. Deterministisch.
function buildPattern(items, thisMs, tz, windowLabel) {
  const dist = { night: 0, morning: 0, afternoon: 0, evening: 0 }
  for (const t of items) { const b = todBucket(t, tz); if (dist[b] != null) dist[b]++ }
  const thisBucket = todBucket(thisMs, tz)
  const inBucket = items.filter((t) => todBucket(t, tz) === thisBucket)
  const mins = inBucket.map((t) => clockMinutes(t, tz))
  const total = items.length || 1
  const distribution = Object.keys(dist).map((k) => ({ bucket: k, label: TOD_LABEL[k], count: dist[k], pct: round((dist[k] / total) * 100, 0) }))
  // Per-dag dot-reeks: laatste 7 kalenderdagen (incl. de episode-dag), hit = een
  // episode van dit type in hetzelfde dagdeel op die dag (zoals de screenshot-dots).
  const bucketDays = new Set(inBucket.map((t) => dayKeyInTz(new Date(t), tz)))
  const days = []
  for (let i = 0; i < 7; i += 1) {
    const ms = thisMs - i * 86_400_000
    const key = dayKeyInTz(new Date(ms), tz)
    days.push({ date: key, hit: bucketDays.has(key) })
  }
  return {
    window: windowLabel,
    bucket: thisBucket,
    bucketLabel: TOD_LABEL[thisBucket],
    count: inBucket.length,
    total: items.length,
    fromHM: mins.length ? hmFromMin(Math.min.apply(null, mins)) : null,
    toHM: mins.length ? hmFromMin(Math.max.apply(null, mins)) : null,
    distribution,
    days,
  }
}

async function ensureAuxIndexes(db) {
  if (auxIndexesEnsured) return
  try {
    await db.collection('cgm_events').createIndex({ eventAt: -1 })
    await db.collection('helper_reminders').createIndex({ key: 1 })
    await db.collection('helper_reminders').createIndex({ createdAt: 1 })

    // prediction_snapshots is de hot-path collectie: getLatestPredictionSnapshot()
    // doet find({}).sort({createdAt:-1}).limit(1) bij elke overlay-refresh, en de
    // sync-upsert filtert per cyclus op entryIdentifier. Zonder deze indexen zijn
    // dat collection scans + in-memory sorts die met de tijd verslechteren.
    const snaps = db.collection('prediction_snapshots')
    await snaps.createIndex({ createdAt: -1 })
    await snaps.createIndex({ outcomeEvaluated: 1 })

    // entryIdentifier-index: partial+unique zodat de constraint alleen geldt voor
    // live-snapshots (string), niet voor legacy/PDF-snapshots met entryIdentifier:null
    // (anders duplicate-key op de nulls). Bestaan er nú al dubbele live-identifiers,
    // dan zou de unique create falen -> we slaan de index dan over en alarmeren,
    // zodat hij na dedup + herstart schoon kan worden aangemaakt (zie else-tak).
    const dupes = await snaps.aggregate([
      { $match: { entryIdentifier: { $type: 'string' } } },
      { $group: { _id: '$entryIdentifier', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $limit: 1 },
    ]).toArray()
    if (dupes.length === 0) {
      await snaps.createIndex(
        { entryIdentifier: 1 },
        { unique: true, partialFilterExpression: { entryIdentifier: { $type: 'string' } } }
      )
    } else {
      // Bewust GEEN non-unique fallback-index: die zou later botsen met de unique
      // create (IndexOptionsConflict, stil opgeslokt) waardoor de unique index na
      // dedup nooit alsnog gebouwd wordt. Alleen alarmeren; de unique partial index
      // wordt na dedup + herstart van de sync vanzelf schoon aangemaakt (de guard
      // hieronder draait de ensure maar één keer per proces).
      console.warn('[libreview-sync] prediction_snapshots: dubbele entryIdentifier(s) gevonden — unique index uitgesteld tot na dedup + herstart')
    }

    // user_feedback wordt met { createdAt: { $gte: ... } }-ranges bevraagd.
    await db.collection('user_feedback').createIndex({ createdAt: -1 })

    auxIndexesEnsured = true
  } catch { /* index-creatie mag deploy nooit breken */ }
}

// B-detail — één low- of high-episode met metrics, context, severity, pattern-analyse en
// similar-episodes. Géén LLM, alleen Mongo-reads (free-tier safe). Geen curve: Nightscout
// toont de glucosegrafiek al.
async function getAiEpisodeDetail({ type, peakAt } = {}) {
  const kind = type === 'high' ? 'high' : 'low'
  const peakMs = Date.parse(peakAt || '')
  if (!Number.isFinite(peakMs)) {
    const err = new Error('Ongeldige of ontbrekende peakAt (ISO-datum).')
    err.statusCode = 400
    throw err
  }
  const tz = process.env.LIBREVIEW_TZ || 'Europe/Amsterdam'
  const now = Date.now()
  let client = null
  try {
    client = new MongoClient(config.mongoUri)
    await client.connect()
    const db = client.db()

    let episode = null
    if (kind === 'low') {
      episode = await db.collection('reactive_hypo_episodes')
        .findOne({ peakAt: new Date(peakMs).toISOString() }, { projection: { _id: 0 } })
      // Tolerante match: brondata kan iets afwijken; zoek dichtstbijzijnde piek binnen 5 min.
      if (!episode) {
        const near = await db.collection('reactive_hypo_episodes')
          .find({ peakAt: { $gte: new Date(peakMs - 5 * 60000).toISOString(), $lte: new Date(peakMs + 5 * 60000).toISOString() } }, { projection: { _id: 0 } })
          .toArray()
        episode = near.sort((a, b) => Math.abs(Date.parse(a.peakAt) - peakMs) - Math.abs(Date.parse(b.peakAt) - peakMs))[0] || null
      }
      if (!episode) {
        const err = new Error('Low-episode niet gevonden voor deze peakAt.')
        err.statusCode = 404
        throw err
      }
    }

    // Vensterbepaling: low = piek-2u .. (recovery|nadir)+2u; high = piek-2u .. +4u.
    const anchorEnd = kind === 'low'
      ? Date.parse(episode.recoveredAt || episode.nadirAt || peakAt) || peakMs
      : peakMs
    const windowFrom = peakMs - 2 * 3_600_000
    const windowTo = kind === 'low' ? anchorEnd + 2 * 3_600_000 : peakMs + 4 * 3_600_000

    const rows = await db.collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true }, date: { $gte: windowFrom, $lt: windowTo } }, { projection: { _id: 0, sgv: 1, date: 1 } })
      .sort({ date: 1 })
      .toArray()
    const pts = rows.map((r) => ({ t: r.date, mmol: Number(r.sgv) / MGDL_PER_MMOL }))

    const feedbackRaw = await db.collection('user_feedback')
      .find({}, { projection: { _id: 0, createdAt: 1, type: 1, note: 1, relatedEntryIdentifier: 1, relatedEntryMmol: 1 } })
      .sort({ createdAt: -1 }).limit(100).toArray()
    const inWindow = (iso) => {
      const t = Date.parse(iso)
      return Number.isFinite(t) && t >= windowFrom && t < windowTo
    }
    const feedback = feedbackRaw.filter((f) => inWindow(f.createdAt))

    // Context "wat gebeurde eromheen" (SmartXdrip): events/notities in het venster.
    const eventsRaw = await db.collection('cgm_events')
      .find({}, { projection: { _id: 0, eventAt: 1, type: 1, note: 1, fingerstickMmol: 1, relatedEntryMmol: 1 } })
      .sort({ eventAt: -1 }).limit(200).toArray()
    const events = eventsRaw
      .filter((e) => inWindow(e.eventAt))
      .map((e) => ({ ...e, minutesFromPeak: round((Date.parse(e.eventAt) - peakMs) / 60000, 0) }))

    if (kind === 'low') {
      const nearbyHighs = buildHighEpisodes(rows).filter((h) => Date.parse(h.peakAt) < peakMs)
      // Triggerende maaltijd: dichtstbijzijnde meal/snack tot 4u vóór de piek (reactieve-hypo kern).
      const mealTypes = new Set(['meal', 'snack'])
      const priorMeal = eventsRaw
        .filter((e) => mealTypes.has(e.type))
        .map((e) => ({ type: e.type, eventAt: e.eventAt, note: e.note, t: Date.parse(e.eventAt) }))
        .filter((e) => Number.isFinite(e.t) && e.t <= peakMs && e.t >= peakMs - 4 * 3_600_000)
        .sort((a, b) => b.t - a.t)[0] || null
      const trigger = priorMeal
        ? { type: priorMeal.type, eventAt: priorMeal.eventAt, note: priorMeal.note, minutesBefore: round((peakMs - priorMeal.t) / 60000, 0) }
        : null
      // Vergelijking met je normaal: medianen over recente episodes.
      const cohortEps = await db.collection('reactive_hypo_episodes')
        .find({}, { projection: { _id: 0, nadirMmol: 1, dropFromPeakMmol: 1, recoveryMinutes: 1 } })
        .sort({ peakAt: -1 }).limit(60).toArray()
      const median = (arr) => { const a = arr.map(Number).filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null }
      const cohort = {
        count: cohortEps.length,
        medianNadirMmol: round(median(cohortEps.map((e) => e.nadirMmol)) ?? 0, 1) || null,
        medianDropMmol: round(median(cohortEps.map((e) => e.dropFromPeakMmol)) ?? 0, 1) || null,
        medianRecoveryMin: median(cohortEps.map((e) => e.recoveryMinutes)),
      }
      // Pattern-analyse + similar over 30d echte lows (nadir <3.9).
      const since30 = new Date(now - 30 * 86_400_000).toISOString()
      const lows30 = await db.collection('reactive_hypo_episodes')
        .find({ peakAt: { $gte: since30 }, nadirMmol: { $lt: 3.9 } }, { projection: { _id: 0, peakAt: 1, nadirMmol: 1, minutesPeakToNadir: 1, fallRateMmolPerMin: 1, severity: 1 } })
        .toArray()
      const pattern = buildPattern(lows30.map((l) => Date.parse(l.peakAt)).filter(Number.isFinite), peakMs, tz, '30d')
      const thisNadir = Number(episode.nadirMmol)
      const similar = lows30
        .filter((l) => l.peakAt !== episode.peakAt)
        .sort((a, b) => Math.abs(Number(a.nadirMmol) - thisNadir) - Math.abs(Number(b.nadirMmol) - thisNadir))
        .slice(0, 5)
        .map((l) => ({ peakAt: l.peakAt, nadirMmol: l.nadirMmol, minutesPeakToNadir: l.minutesPeakToNadir, fallRateMmolPerMin: l.fallRateMmolPerMin, severity: l.severity }))
      const reasons = []
      if (Number(episode.nadirMmol) < 3.0) reasons.push('Diepe low: laagste punt onder 3.0 mmol/L.')
      if (Number(episode.timeBelow3_9Minutes) > 20) reasons.push('Lang onder 3.9: meer dan 20 minuten.')
      const lastHigh = nearbyHighs[nearbyHighs.length - 1]
      if (lastHigh && Number(lastHigh.peakMmol) > 10 && Number(episode.dropFromPeakMmol) >= 3) {
        reasons.push('Hoge piek vooraf gevolgd door snelle daling.')
      }
      const flags = Array.isArray(episode.qualityFlags) ? episode.qualityFlags : []
      if (flags.includes('single_point_low') || flags.includes('possible_compression_low')) {
        reasons.push('Mogelijk sensorartefact: single-point-low of compression-low gemarkeerd.')
      }
      if (Number(episode.recoveryMinutes) > 30) reasons.push('Herstel traag: meer dan 30 minuten.')
      if (episode.reboundHigh) reasons.push('Rebound-high na herstel.')
      if (trigger) reasons.push(`Mogelijk na ${trigger.type === 'snack' ? 'snack' : 'maaltijd'}: ~${trigger.minutesBefore} min eerder gelogd.`)
      if (cohort.medianNadirMmol != null && Number(episode.nadirMmol) < cohort.medianNadirMmol - 0.3) reasons.push(`Dieper dan je normaal (mediaan nadir ${cohort.medianNadirMmol} mmol).`)
      if (!reasons.length) reasons.push('Geen bijzondere risicokenmerken; korte, ondiepe dip.')
      return {
        type: 'low',
        episode,
        window: { from: new Date(windowFrom).toISOString(), to: new Date(windowTo).toISOString() },
        nearbyHighs,
        events,
        trigger,
        cohort,
        pattern,
        similar,
        feedback,
        notableReasons: reasons,
      }
    }

    // High-detail: metrics live uit de omliggende readings (highs zijn niet gepersisteerd).
    let peakMmol = -Infinity
    let realPeakAt = peakMs
    let startAt = null
    let endAt = null
    for (const p of pts) {
      if (p.mmol > 10.0) {
        if (startAt == null) startAt = p.t
        endAt = p.t
        if (p.mmol > peakMmol) { peakMmol = p.mmol; realPeakAt = p.t }
      }
    }
    const above10 = integrateBeyond(pts, 10.0, 'above')
    const above139 = integrateBeyond(pts, 13.9, 'above')
    let recoveryAt = null
    for (const p of pts) {
      if (p.t > realPeakAt && p.mmol < 10.0) { recoveryAt = p.t; break }
    }
    const followLow = await db.collection('reactive_hypo_episodes')
      .find({ peakAt: { $gte: new Date(realPeakAt).toISOString(), $lte: new Date((endAt || realPeakAt) + 4 * 3_600_000).toISOString() } }, {
        projection: { _id: 0, peakAt: 1, nadirAt: 1, nadirMmol: 1, severity: 1 },
      })
      .sort({ peakAt: 1 }).limit(1).next()
    const metrics = {
      startAt: startAt ? new Date(startAt).toISOString() : null,
      endAt: endAt ? new Date(endAt).toISOString() : null,
      peakAt: new Date(realPeakAt).toISOString(),
      peakMmol: Number.isFinite(peakMmol) ? round(peakMmol, 1) : null,
      durationAbove10Minutes: above10.minutes,
      durationAbove13_9Minutes: above139.minutes,
      areaAbove10: above10.area,
      areaAbove13_9: above139.area,
      recoveryMinutes: recoveryAt ? round((recoveryAt - realPeakAt) / 60000, 0) : null,
      followedByLow: followLow
        ? { peakAt: followLow.peakAt, nadirMmol: followLow.nadirMmol, severity: followLow.severity, minutesToLowPeak: round((Date.parse(followLow.peakAt) - (endAt || realPeakAt)) / 60000, 0) }
        : null,
    }
    // Pattern-analyse + similar over 14d high-episodes (live uit entries).
    const rows14 = await db.collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true }, date: { $gte: now - 14 * 86_400_000 } }, { projection: { _id: 0, sgv: 1, date: 1 } })
      .sort({ date: 1 }).toArray()
    const highs14 = buildHighEpisodes(rows14)
    const pattern = buildPattern(highs14.map((hh) => Date.parse(hh.peakAt)).filter(Number.isFinite), realPeakAt, tz, '14d')
    const thisPeak = Number(metrics.peakMmol)
    const similar = highs14
      .filter((hh) => Math.abs(Date.parse(hh.peakAt) - realPeakAt) > 60_000)
      .sort((a, b) => Math.abs(Number(a.peakMmol) - thisPeak) - Math.abs(Number(b.peakMmol) - thisPeak))
      .slice(0, 5)
      .map((hh) => ({ peakAt: hh.peakAt, peakMmol: hh.peakMmol, durationMinutes: hh.durationMinutes }))
    const reasons = []
    if (Number(metrics.peakMmol) > 13.9) reasons.push('Hoge piek: boven 13.9 mmol/L.')
    if (Number(metrics.durationAbove10Minutes) > 120) reasons.push('Lang boven 10: meer dan 2 uur.')
    if (followLow) reasons.push('Gevolgd door een low binnen 4 uur (mogelijk reactief).')
    if (!reasons.length) reasons.push('Kortdurende, milde piek.')
    return {
      type: 'high',
      metrics,
      window: { from: new Date(windowFrom).toISOString(), to: new Date(windowTo).toISOString() },
      events,
      pattern,
      similar,
      feedback,
      notableReasons: reasons,
    }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

// Proxyt de Ollama-cloud modellenlijst (voor de dropdown). Kort gecachet.
async function listAiModels() {
  if (aiModelsCache.models && Date.now() - aiModelsCache.at < 5 * 60_000) {
    return aiModelsCache.models
  }
  const aiRouter = resolveAiRouterConfig()
  const ollama = aiRouter.providers.find((p) => /ollama/i.test(p.name)) ?? aiRouter.providers[0]
  if (!ollama) return []
  const base = ollama.baseUrl.replace(/\/+$/, '')
  const res = await fetch(`${base}/api/tags`, {
    headers: { Authorization: `Bearer ${ollama.apiKey}` },
  })
  if (!res.ok) throw new Error(`Modellen ophalen mislukt: HTTP ${res.status}`)
  const json = await res.json()
  const models = Array.isArray(json?.models)
    ? json.models.map((m) => String(m?.name || '')).filter(Boolean).sort()
    : []
  aiModelsCache = { at: Date.now(), models }
  return models
}

// Periodieke achtergrond-loop (default uit; zet AI_REVIEW_INTERVAL_MINUTES>0).
function startAiReviewLoop() {
  const minutes = Math.max(0, Number(process.env.AI_REVIEW_INTERVAL_MINUTES ?? 0))
  if (!minutes) return
  if (!aiRouterConfigured(resolveAiRouterConfig())) {
    console.log('[libreview-sync] AI_REVIEW_INTERVAL_MINUTES gezet maar geen AI-provider; loop niet gestart.')
    return
  }
  console.log(`[libreview-sync] AI-review loop elke ${minutes} min.`)
  setInterval(() => {
    runAiReviewOnce()
      .then((r) => console.log(`[libreview-sync] AI-review loop: ${JSON.stringify({ skipped: r.skipped, obs: r.observations?.length, q: r.questions?.length })}`))
      .catch((err) => console.error(`[libreview-sync] AI-review loop: ${formatError(err)}`))
  }, minutes * 60_000)
}

function toNightscoutEntry(pt) {
  const dateString = parseLibreTimestamp(pt.Timestamp ?? pt.FactoryTimestamp)
  const date = new Date(dateString).getTime()

  // ValueInMgPerDl is altijd mg/dL — ook bij ernstige hypo (<40 mg/dL). NIET ×18 doen,
  // anders wordt bv. 2.0 mmol/L (36 mg/dL) opgeslagen als 649 mg/dL (extreme hyper).
  // De ×18-heuristiek geldt alleen voor het ambigue `Value`-only geval (mmol vs mg/dL).
  const sgv = pt.ValueInMgPerDl != null
    ? Math.round(Number(pt.ValueInMgPerDl))
    : (Number(pt.Value) > 40
        ? Math.round(Number(pt.Value))                 // Value al in mg/dL
        : Math.round(Number(pt.Value) * 18.0182))      // Value in mmol/L

  const entry = {
    type: 'sgv',
    date,
    dateString,
    sgv,
    // Alleen een richting zetten als de bron er echt een geeft. History-/measurement-punten
    // hebben vaak geen TrendArrow; geen valse 'Flat' verzinnen.
    direction: pt.TrendArrow != null ? mapNightscoutDirection(pt.TrendArrow) : 'NOT COMPUTABLE',
    device: 'glucose-cgm-libreview',
    identifier: `glucose-cgm-libreview:${dateString}`,
  }
  return entry
}

async function libreLogin(email, password) {
  const doLluLogin = async (baseUrl) => {
    const res = await fetchWithRetry(`${baseUrl}/llu/auth/login`, {
      method: 'POST',
      headers: LLU_BASE_HEADERS,
      body: JSON.stringify({ email, password }),
    }, 'llu_login')
    const text = await res.text()
    const json = parseJson(text, `Login parse fout: ${text.slice(0, 200)}`)
    if (!res.ok) throw new Error(`Login mislukt (${res.status}): ${JSON.stringify(json).slice(0, 300)}`)
    if (!json.data?.user?.id || !json.data?.authTicket?.token) {
      throw new Error(`Login mislukt: ${libreErrorMessage(json)}`)
    }
    return json
  }

  let json = await doLluLogin(LIBRE_API)
  let baseUrl = LIBRE_API

  if (json.data?.redirect) {
    const region = json.data.region
    baseUrl = `https://api-${region}.libreview.io`
    json = await doLluLogin(baseUrl)
  }

  const userId = json.data.user.id
  const lluToken = json.data.authTicket.token
  const accountId = sha256hex(userId)

  return { lluToken, baseUrl, accountId }
}

async function collectReadings(lluToken, accountId, baseUrl) {
  const debug = []
  const readings = []

  // De /llu/connections/<patientId>/graph endpoint levert de huidige meting plus de
  // recente historie (~12u) — genoeg voor dedup en backfill van late minuten. De oude
  // LSL-history/measurements en de self-graph gaven voor dit account altijd 400/403/404,
  // dus die zijn verwijderd (puur verspilde calls + rate-limit-druk).
  const connRes = await lluGet(lluToken, accountId, baseUrl, '/llu/connections')
  debug.push(`llu_conn=${connRes.status}`)

  if (connRes.ok) {
    const connections = connRes.json?.data ?? []
    for (const conn of connections) {
      const graphRes = await lluGet(lluToken, accountId, baseUrl, `/llu/connections/${conn.patientId}/graph`)
      debug.push(`llu_graph=${graphRes.status}`)
      if (!graphRes.ok) continue
      const pts = extractReadings(graphRes.json)
      debug.push(`llu_graph_points=${pts.length}`)
      readings.push(...pts)
    }
  }

  if (readings.length > 0) {
    debug.push(`found=${readings.length}`)
    return { readings, debugInfo: debug.join(', ') }
  }

  throw new Error(
    `Geen sensordata. Debug: ${debug.join(', ')}. ` +
    'Open de FreeStyle LibreLink app en accepteer eventuele gebruiksvoorwaarden.'
  )
}

async function lluGet(token, accountId, baseUrl, path) {
  const res = await fetchWithRetry(`${baseUrl}${path}`, {
    headers: { ...LLU_BASE_HEADERS, Authorization: `Bearer ${token}`, 'account-id': accountId },
  }, `llu:${path}`)
  return responseJson(res)
}

function extractReadings(json) {
  if (!json || typeof json !== 'object') return []
  const data = json.data

  if (Array.isArray(data)) return data

  if (data && typeof data === 'object') {
    if (Array.isArray(data.graphData)) {
      const pts = [...data.graphData]
      const current = data.connection?.glucoseMeasurement
      if (current?.Timestamp || current?.FactoryTimestamp) pts.push(current)
      return pts
    }

    if (Array.isArray(data.periods)) return data.periods.flatMap((period) => period.data ?? [])
    if (Array.isArray(data.results)) return data.results
    if (Array.isArray(data.data)) return data.data
  }

  return Array.isArray(json) ? json : []
}

async function getKnownNightscoutIdentifiers() {
  const res = await fetch(`${config.nightscoutUrl}/api/v1/entries/sgv.json?count=3000`)
  if (!res.ok) return new Set()
  const entries = await res.json()
  return new Set(
    (entries ?? [])
      .map((entry) => entry.identifier)
      .filter((identifier) => typeof identifier === 'string')
  )
}

async function getRecentNightscoutEntries() {
  const res = await fetch(`${config.nightscoutUrl}/api/v1/entries/sgv.json?count=240`)
  if (!res.ok) return []
  return await res.json()
}

function addRateFields(entries, previousEntries = []) {
  const timeline = [...previousEntries, ...entries]
    .filter((entry) => Number.isFinite(Number(entry.sgv)) && Number.isFinite(Number(entry.date)))
    .sort((a, b) => a.date - b.date)
  const workTimeline = cleanGlucoseTimeline(timeline)

  for (const entry of entries) {
    const workEntry = workTimeline.find((candidate) =>
      (entry.identifier && candidate.identifier === entry.identifier) || Number(candidate.date) === Number(entry.date)
    ) ?? entry
    const rates = calculateRates(workEntry, workTimeline)
    entry.glucoseRate = rates
    entry.glucoseRateMmolPerMin = rates
    if (workEntry.spikeFiltered) entry.spikeFiltered = true
  }
}

function calculateRates(entry, timeline) {
  const rates = {}
  for (const minutes of RATE_WINDOWS_MINUTES) {
    const baseline = findBaseline(timeline, entry.date, minutes)
    const key = `${minutes}m`
    if (!baseline) {
      rates[key] = null
      continue
    }

    const actualMinutes = (entry.date - baseline.date) / 60_000
    if (actualMinutes <= 0) {
      rates[key] = null
      continue
    }

    const deltaMgdl = Number(entry.sgv) - Number(baseline.sgv)
    rates[key] = {
      rate: round((deltaMgdl / MGDL_PER_MMOL) / actualMinutes, 4),
      delta: round(deltaMgdl / MGDL_PER_MMOL, 3),
      actualMinutes: round(actualMinutes, 2),
      baselineDate: baseline.dateString ?? new Date(baseline.date).toISOString(),
    }
  }
  return rates
}

function findBaseline(timeline, latestTime, minutesBack) {
  const target = latestTime - minutesBack * 60_000
  let best = null
  let bestDiff = Infinity

  for (const entry of timeline) {
    const time = Number(entry.date)
    if (!Number.isFinite(time) || time >= latestTime) continue

    const diff = Math.abs(time - target)
    if (diff < bestDiff) {
      best = entry
      bestDiff = diff
    }
  }

  return bestDiff <= RATE_MAX_BASELINE_DIFF_MS ? best : null
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

async function uploadEntries(entries) {
  const res = await fetchWithRetry(`${config.nightscoutUrl}/api/v1/entries`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-secret': sha1hex(config.apiSecret),
    },
    body: JSON.stringify(entries),
  }, 'nightscout_upload')

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Nightscout upload mislukt (${res.status}): ${body.slice(0, 500)}`)
  }
}

function parseLibreTimestamp(ts) {
  if (!ts) throw new Error('Lege timestamp')

  const asNum = Number(ts)
  if (!Number.isNaN(asNum) && asNum > 1_000_000_000) {
    return new Date(asNum * (asNum < 1e12 ? 1000 : 1)).toISOString()
  }

  if (/[Zz]$/.test(ts) || /[+-]\d{2}:\d{2}$/.test(ts)) {
    const d = new Date(ts.replace(' ', 'T'))
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }

  let localMs = null
  const isoNorm = ts.replace(' ', 'T')
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(isoNorm)) {
    const d = new Date(isoNorm)
    if (!Number.isNaN(d.getTime())) localMs = d.getTime()
  }

  if (localMs === null) {
    const m = ts.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s*(AM|PM))?/i)
    if (m) {
      let hour = Number.parseInt(m[4], 10)
      const ampm = (m[7] ?? '').toUpperCase()
      if (ampm === 'AM' && hour === 12) hour = 0
      else if (ampm === 'PM' && hour !== 12) hour += 12
      const d = new Date(`${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}T${String(hour).padStart(2, '0')}:${m[5]}:${m[6]}`)
      if (!Number.isNaN(d.getTime())) localMs = d.getTime()
    }
  }

  if (localMs === null) {
    const m = ts.match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/)
    if (m) {
      const d = new Date(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}:${m[6]}`)
      if (!Number.isNaN(d.getTime())) localMs = d.getTime()
    }
  }

  if (localMs === null) throw new Error(`Onbekend timestamp formaat: ${ts}`)
  // localMs = lokale wandkloktijd, geïnterpreteerd als UTC-getallen (container draait in UTC).
  // Expliciete vaste offset? Die gebruiken. Anders DST-bewust omzetten voor de tijdzone,
  // zodat zomer- én wintertijd vanzelf kloppen.
  if (config.tzFixedOffsetMinutes != null) {
    return new Date(localMs - config.tzFixedOffsetMinutes * 60_000).toISOString()
  }
  return new Date(wallClockToUtc(localMs, config.tzName)).toISOString()
}

// Zet een lokale wandkloktijd (als UTC-getallen) DST-bewust om naar echte UTC-ms voor `timeZone`.
function wallClockToUtc(wallAsUtcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  // Wandkloktijd die `timeZone` toont voor een echt UTC-moment, terug als UTC-getallen.
  const zoneWallMs = (utcMs) => {
    const p = dtf.formatToParts(new Date(utcMs)).reduce((a, x) => { a[x.type] = x.value; return a }, {})
    const hour = p.hour === '24' ? 0 : Number(p.hour)
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second))
  }
  // offset = hoeveel de zone vóór UTC loopt; twee passes voor de DST-randen.
  let offset = zoneWallMs(wallAsUtcMs) - wallAsUtcMs
  offset = zoneWallMs(wallAsUtcMs - offset) - (wallAsUtcMs - offset)
  return wallAsUtcMs - offset
}

function mapNightscoutDirection(trend) {
  const map = {
    1: 'DoubleDown',
    2: 'SingleDown',
    3: 'FortyFiveDown',
    4: 'Flat',
    5: 'FortyFiveUp',
    6: 'SingleUp',
    7: 'DoubleUp',
  }
  return map[trend] ?? 'Flat'
}

async function responseJson(res) {
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, ok: res.ok, json }
}

async function fetchWithRetry(url, options, label) {
  let lastError = null

  for (let attempt = 1; attempt <= config.retryAttempts; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.httpTimeoutMs)
    try {
      const res = await fetch(url, { ...options, signal: controller.signal })
      if (res.ok || !shouldRetryStatus(res.status) || attempt === config.retryAttempts) {
        if (!res.ok && attempt > 1) {
          console.warn(`[libreview-sync] ${label} stopte na poging ${attempt} met HTTP ${res.status}`)
        }
        clearTimeout(timeout)
        return res
      }

      console.warn(`[libreview-sync] ${label} gaf HTTP ${res.status}, poging ${attempt}/${config.retryAttempts}`)
    } catch (err) {
      lastError = err
      if (attempt === config.retryAttempts) break
      console.warn(`[libreview-sync] ${label} netwerkfout, poging ${attempt}/${config.retryAttempts}: ${formatError(err)}`)
    } finally {
      clearTimeout(timeout)
    }

    const exponential = config.retryBaseDelayMs * (2 ** (attempt - 1))
    const jitter = Math.floor(Math.random() * (config.retryJitterMs + 1))
    const delay = Math.min(config.retryMaxDelayMs, exponential + jitter)
    await sleep(delay)
  }

  throw lastError ?? new Error(`${label} mislukte na ${config.retryAttempts} pogingen.`)
}

function shouldRetryStatus(status) {
  return status === 408 || status === 429 || status >= 500
}

function parseJson(text, errorMessage) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(errorMessage)
  }
}

function libreErrorMessage(json) {
  const message =
    json?.error?.message ??
    json?.message ??
    json?.error ??
    json?.statusMessage

  if (typeof message === 'string' && message.trim()) return message
  return `onverwachte LibreView response (${JSON.stringify(json).slice(0, 300)})`
}

function sha256hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha1hex(value) {
  return createHash('sha1').update(value).digest('hex')
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value || value.includes('example.com') || value.startsWith('your-')) {
    throw new Error(`${name} ontbreekt of staat nog op de voorbeeldwaarde.`)
  }
  return value
}

function readConfig(requireSecrets) {
  const next = {
    email: requireSecrets ? requiredEnv('LIBREVIEW_EMAIL') : optionalEnv('LIBREVIEW_EMAIL'),
    password: requireSecrets ? requiredEnv('LIBREVIEW_PASSWORD') : optionalEnv('LIBREVIEW_PASSWORD'),
    tzFixedOffsetMinutes: (process.env.LIBREVIEW_TZ_OFFSET != null && process.env.LIBREVIEW_TZ_OFFSET !== '')
      ? Number(process.env.LIBREVIEW_TZ_OFFSET)
      : null,
    tzName: process.env.LIBREVIEW_TZ ?? 'Europe/Amsterdam',
    nightscoutUrl: trimTrailingSlash(process.env.NIGHTSCOUT_URL ?? 'http://localhost:1337'),
    mongoUri: process.env.MONGODB_URI ?? 'mongodb://nightscout-mongo:27017/nightscout',
    apiSecret: requireSecrets ? requiredEnv('API_SECRET') : optionalEnv('API_SECRET'),
    intervalSeconds: Number(process.env.LIBREVIEW_INTERVAL_SECONDS ?? DEFAULT_INTERVAL_SECONDS),
    graceWindowMinutes: Number(process.env.LIBREVIEW_GRACE_WINDOW_MINUTES ?? DEFAULT_GRACE_WINDOW_MINUTES),
    retryAttempts: Number(process.env.LIBREVIEW_RETRY_ATTEMPTS ?? DEFAULT_RETRY_ATTEMPTS),
    retryBaseDelayMs: Number(process.env.LIBREVIEW_RETRY_BASE_DELAY_MS ?? DEFAULT_RETRY_BASE_DELAY_MS),
    retryMaxDelayMs: Number(process.env.LIBREVIEW_RETRY_MAX_DELAY_MS ?? DEFAULT_RETRY_MAX_DELAY_MS),
    httpTimeoutMs: Number(process.env.LIBREVIEW_HTTP_TIMEOUT_MS ?? DEFAULT_HTTP_TIMEOUT_MS),
    retryJitterMs: Number(process.env.LIBREVIEW_RETRY_JITTER_MS ?? DEFAULT_RETRY_JITTER_MS),
    influxUrl: optionalEnv('INFLUX_URL'),
    influxDb: process.env.INFLUXDB_DB ?? 'xdrip',
    influxUser: optionalEnv('INFLUXDB_USER') ?? optionalEnv('INFLUXDB_ADMIN_USER'),
    influxPassword: optionalEnv('INFLUXDB_USER_PASSWORD') ?? optionalEnv('INFLUXDB_ADMIN_PASSWORD'),
  }

  if (next.tzFixedOffsetMinutes != null && !Number.isFinite(next.tzFixedOffsetMinutes)) {
    throw new Error('LIBREVIEW_TZ_OFFSET moet een getal in minuten zijn (of leeg laten voor DST-automatiek).')
  }

  if (!Number.isFinite(next.intervalSeconds) || next.intervalSeconds < 30) {
    throw new Error('LIBREVIEW_INTERVAL_SECONDS moet minimaal 30 zijn.')
  }

  if (!Number.isFinite(next.graceWindowMinutes) || next.graceWindowMinutes < HISTORY_PERIOD_MINUTES) {
    throw new Error(`LIBREVIEW_GRACE_WINDOW_MINUTES moet minimaal ${HISTORY_PERIOD_MINUTES} zijn.`)
  }

  if (!Number.isInteger(next.retryAttempts) || next.retryAttempts < 1 || next.retryAttempts > 10) {
    throw new Error('LIBREVIEW_RETRY_ATTEMPTS moet een geheel getal tussen 1 en 10 zijn.')
  }

  if (!Number.isFinite(next.retryBaseDelayMs) || next.retryBaseDelayMs < 100) {
    throw new Error('LIBREVIEW_RETRY_BASE_DELAY_MS moet minimaal 100 zijn.')
  }

  if (!Number.isFinite(next.retryMaxDelayMs) || next.retryMaxDelayMs < next.retryBaseDelayMs) {
    throw new Error('LIBREVIEW_RETRY_MAX_DELAY_MS moet minimaal LIBREVIEW_RETRY_BASE_DELAY_MS zijn.')
  }

  if (!Number.isFinite(next.httpTimeoutMs) || next.httpTimeoutMs < 1000) {
    throw new Error('LIBREVIEW_HTTP_TIMEOUT_MS moet minimaal 1000 zijn.')
  }

  if (!Number.isFinite(next.retryJitterMs) || next.retryJitterMs < 0) {
    throw new Error('LIBREVIEW_RETRY_JITTER_MS moet 0 of hoger zijn.')
  }

  return next
}

function optionalEnv(name) {
  const value = process.env[name] ?? ''
  if (value.includes('example.com') || value.startsWith('your-')) return ''
  return value
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
