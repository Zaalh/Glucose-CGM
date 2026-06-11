import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { MongoClient } from 'mongodb'
import { buildHypoFeatures, cleanGlucoseTimeline } from './lib/hypo-features.mjs'
import { evaluateReactiveHypoRiskV2 } from './lib/reactive-hypo-detector.mjs'
import { findSimilarEpisodes, patternFromFeatures } from './lib/episode-similarity.mjs'
import { aiRouterConfigured, resolveAiRouterConfig, runAiReview } from './lib/ai-review-core.mjs'

const LIBRE_API = 'https://api-eu.libreview.io'
const DEFAULT_INTERVAL_SECONDS = 60
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
    await sleep(readConfig(false).intervalSeconds * 1000)
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

    // Alleen vergelijken bij een echte recente post-piek daling. pattern_events
    // bevat enkel drops/hypo's, dus bij stabiele/stijgende metingen zou similarity
    // ten onrechte matchen en de forecast omlaag trekken.
    const isDropContext = dropFromPeakMmol >= 2 && minutesSincePeak <= 60
    const similar = isDropContext
      ? findSimilarEpisodes(
          { peakMmol, dropFromPeakMmol, minutesSincePeak },
          episodeVectors,
          { currentMs: entry.date, recencyDays: v2State ? v2State.params?.patternRecencyDays : null },
        )
      : null

    const shadowFeaturesFull = buildHypoFeatures(workTimeline, idx, { nowMs: entry.date, cleanTimeline: false })
    const features = shadowFeaturesFull

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
    if (similar && similar.count >= 3 && similar.hypoRatio >= 0.5) {
      risk.reasons = risk.reasons.concat(
        `Lijkt op ${similar.count} eerdere episodes; ${similar.hypoCount} gingen onder 4.5`,
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
      patternDrop: similar ? similar.correction : null,
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

    // V2-pattern uit dezelfde featureset die V2 zelf ziet, via de gedeelde helper —
    // zo is het pattern in live én backtest exact gelijk (echte train/serve-pariteit;
    // anders verschilt minutesSincePeak door de tie-break in de piekselectie).
    const pattern = patternFromFeatures(shadowFeaturesFull, episodeVectors, {
      recencyDays: v2State ? v2State.params?.patternRecencyDays : null,
    })

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
      .find({}, { projection: { featureVector: 1, outcome: 1, eventType: 1, peakDate: 1, startDate: 1, endDate: 1 } })
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
    const [observations, questions] = await Promise.all([
      db.collection('ai_observations').find({}).sort({ createdAt: -1 }).limit(limit).toArray(),
      db.collection('ai_questions').find({}).sort({ createdAt: -1 }).limit(limit).toArray(),
    ])
    return { observations, questions }
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
