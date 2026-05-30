import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { MongoClient } from 'mongodb'

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
const SIM_SCALES = { peakMmol: 4, dropFromPeakMmol: 3, minutesSincePeak: 30 }
const SIM_MAX_DIST = 1.5
const SIM_K = 8
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

const LSL_BASE_HEADERS = {
  'Content-Type': 'application/json',
  Domain: 'Libreview',
  GatewayType: 'LinkUp.Android',
  'Accept-Encoding': 'gzip',
  'cache-control': 'no-cache',
  connection: 'Keep-Alive',
}

const args = new Set(process.argv.slice(2))
const loop = args.has('--loop')
const server = args.has('--server')
let config = readConfig(false)

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
  const { lluToken, lslToken, baseUrl, accountId, userId } = await libreLogin(config.email, config.password)
  const { readings, debugInfo } = await collectReadings(lluToken, lslToken, accountId, baseUrl, userId)
  const knownIdentifiers = await getKnownNightscoutIdentifiers()
  const previousEntries = await getRecentNightscoutEntries()
  const entries = readings
    .filter((pt) => (pt.Timestamp ?? pt.FactoryTimestamp) && (pt.Value ?? pt.ValueInMgPerDl))
    .map(toNightscoutEntry)
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.identifier === entry.identifier) === index)
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

async function writePredictionSnapshots(entries, previousEntries = []) {
  if (!entries.length) return

  const timeline = [...previousEntries, ...entries]
    .filter((entry) => Number.isFinite(Number(entry.sgv)) && Number.isFinite(Number(entry.date)))
    .sort((a, b) => a.date - b.date)

  const episodes = await loadPatternEpisodes()
  const episodeVectors = await loadEpisodeVectors()
  const snapshots = entries.map((entry) => {
    const idx = timeline.findIndex((candidate) => candidate.identifier === entry.identifier)
    if (idx < 0) return null

    const windowStart = entry.date - 120 * 60_000
    let peak = entry
    for (let i = idx; i >= 0; i -= 1) {
      if (timeline[i].date < windowStart) break
      if (timeline[i].sgv > peak.sgv) peak = timeline[i]
    }

    const currentMmol = Number(entry.sgv) / MGDL_PER_MMOL
    const peakMmol = Number(peak.sgv) / MGDL_PER_MMOL
    const dropFromPeakMmol = peakMmol - currentMmol
    const dropFromPeakPercent = peakMmol > 0 ? (dropFromPeakMmol / peakMmol) * 100 : 0
    const minutesSincePeak = (entry.date - peak.date) / 60_000

    const rate5m = calcRateFromTimeline(timeline, idx, 5)
    const rate10m = calcRateFromTimeline(timeline, idx, 10)
    const rate15m = calcRateFromTimeline(timeline, idx, 15)

    // Alleen vergelijken bij een echte recente post-piek daling. pattern_events
    // bevat enkel drops/hypo's, dus bij stabiele/stijgende metingen zou similarity
    // ten onrechte matchen en de forecast omlaag trekken.
    const isDropContext = dropFromPeakMmol >= 2 && minutesSincePeak <= 60
    const similar = isDropContext
      ? findSimilarEpisodes({ peakMmol, dropFromPeakMmol, minutesSincePeak }, episodeVectors)
      : null

    const risk = evaluateRiskRuleV1({
      currentMmol,
      rate5m,
      rate10m,
      rate15m,
      peakMmol,
      minutesSincePeak,
      dropFromPeakMmol,
      dropFromPeakPercent,
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

    return {
      createdAt: entry.dateString ?? new Date(entry.date).toISOString(),
      entryIdentifier: entry.identifier,
      currentMmol: round(currentMmol, 3),
      risk: risk.risk,
      riskScore: risk.score,
      reasons: risk.reasons,
      predictedMmol: forecast.predictedMmol,
      probabilities: forecast.probabilities,
      modelVersion: 'rules-v1',
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
            predictedMmol: snapshot.predictedMmol,
            probabilities: snapshot.probabilities,
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
      .find({}, { projection: { featureVector: 1, outcome: 1, eventType: 1 } })
      .limit(2000)
      .toArray()
  } catch {
    return []
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

function sq(x) { return x * x }

// Vergelijkt de huidige situatie met opgeslagen episode_vectors. Geeft een
// gewogen drop-correctie en hoeveel vergelijkbare episodes in (near-)hypo eindigden.
function findSimilarEpisodes(input, vectors) {
  if (!vectors || !vectors.length) return null
  const scored = []
  for (const v of vectors) {
    const f = v.featureVector
    if (!f || !Number.isFinite(f.peakMmol) || !Number.isFinite(f.dropFromPeakMmol)) continue
    let sum = sq((f.peakMmol - input.peakMmol) / SIM_SCALES.peakMmol)
    sum += sq((f.dropFromPeakMmol - input.dropFromPeakMmol) / SIM_SCALES.dropFromPeakMmol)
    if (Number.isFinite(f.minutesPeakToEnd) && Number.isFinite(input.minutesSincePeak)) {
      sum += sq((f.minutesPeakToEnd - input.minutesSincePeak) / SIM_SCALES.minutesSincePeak)
    }
    const dist = Math.sqrt(sum)
    if (dist <= SIM_MAX_DIST) scored.push({ dist, drop: f.dropFromPeakMmol, outcome: v.outcome })
  }
  if (scored.length < 3) return null

  scored.sort((a, b) => a.dist - b.dist)
  const top = scored.slice(0, SIM_K)
  let wsum = 0
  let wdrop = 0
  let hypoCount = 0
  for (const s of top) {
    const w = 1 / (1 + s.dist)
    wsum += w
    wdrop += w * (Number.isFinite(s.drop) ? s.drop : 0)
    if (s.outcome === 'hypo' || s.outcome === 'near_hypo') hypoCount += 1
  }
  const weightedDrop = wsum > 0 ? wdrop / wsum : 0
  return {
    count: top.length,
    hypoCount,
    hypoRatio: top.length ? hypoCount / top.length : 0,
    correction: Math.max(0, weightedDrop * 0.18),
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

  if ((input.peakMmol ?? 0) >= 10 && (input.minutesSincePeak ?? 999) <= 30) {
    score += 3
    reasons.push('Recente piek boven 10.0 mmol/L')
  }
  if ((input.dropFromPeakMmol ?? 0) >= 3) {
    score += 3
    reasons.push('Grote daling vanaf piek')
  } else if ((input.dropFromPeakMmol ?? 0) >= 2) {
    score += 2
    reasons.push('Snelle daling vanaf piek')
  }
  if ((input.dropFromPeakPercent ?? 0) >= 30) {
    score += 3
    reasons.push('Relatieve piekdaling >= 30%')
  } else if ((input.dropFromPeakPercent ?? 0) >= 25) {
    score += 2
    reasons.push('Relatieve piekdaling >= 25%')
  }
  if ((input.rate5m ?? 0) <= -0.08 || (input.rate10m ?? 0) <= -0.08) {
    score += 3
    reasons.push('Zeer snelle negatieve rate')
  }
  if ((input.rate15m ?? 0) <= -0.04) {
    score += 2
    reasons.push('Aanhoudende daling over 15 min')
  }
  if ((input.currentMmol ?? 99) < 4.0) {
    score += 100
    reasons.push('Actuele waarde onder 4.0 mmol/L')
  } else if ((input.currentMmol ?? 99) < 4.5) {
    score += 4
    reasons.push('Actuele waarde onder 4.5 mmol/L')
  }

  const risk = score >= 7 ? 'urgent' : score >= 5 ? 'high' : score >= 3 ? 'watch' : 'low'
  return { score, risk, reasons }
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

    res.writeHead(404)
    res.end(JSON.stringify({ success: false, message: 'Niet gevonden.' }))
  })

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`[libreview-sync] HTTP sync server luistert op ${port}`)
  })
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1_000_000) {
        reject(new Error('Body te groot'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(new Error(`Ongeldige JSON: ${formatError(err)}`))
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
      .find({}, { projection: { createdAt: 1, entryIdentifier: 1, predictedMmol: 1, probabilities: 1, modelVersion: 1, currentMmol: 1 } })
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

function toNightscoutEntry(pt) {
  const dateString = parseLibreTimestamp(pt.Timestamp ?? pt.FactoryTimestamp, config.tzOffsetMinutes)
  const date = new Date(dateString).getTime()
  const rawValue = Number(pt.ValueInMgPerDl ?? pt.Value)
  const sgv = rawValue > 40 ? Math.round(rawValue) : Math.round(rawValue * 18.0182)

  return {
    type: 'sgv',
    date,
    dateString,
    sgv,
    direction: mapNightscoutDirection(pt.TrendArrow ?? 4),
    device: 'glucose-cgm-libreview',
    identifier: `glucose-cgm-libreview:${dateString}`,
  }
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

  const lslRes = await fetchWithRetry(`${baseUrl}/lsl/api/nisperson/getauthenticateduser`, {
    method: 'POST',
    headers: { ...LSL_BASE_HEADERS, Authorization: `Bearer ${lluToken}` },
    body: JSON.stringify({ email, password }),
  }, 'lsl_login')
  const lslText = await lslRes.text()
  let lslJson = {}
  try {
    lslJson = JSON.parse(lslText)
  } catch {
    lslJson = {}
  }

  const lslToken = lslJson.data?.authToken ?? lluToken
  return { lluToken, lslToken, baseUrl, accountId, userId }
}

async function collectReadings(lluToken, lslToken, accountId, baseUrl, userId) {
  const debug = []
  const readings = []

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

  const historyPeriods = Math.max(1, Math.ceil(config.graceWindowMinutes / HISTORY_PERIOD_MINUTES))
  const histRes = await lslGet(lslToken, baseUrl, `/glucoseHistory?numPeriods=${historyPeriods}&period=${HISTORY_PERIOD_MINUTES}`)
  debug.push(`lsl_hist=${histRes.status}`)
  if (histRes.ok) {
    const pts = extractReadings(histRes.json)
    debug.push(`lsl_hist_points=${pts.length}`)
    readings.push(...pts)
  }

  const measRes = await lslGet(lslToken, baseUrl, `/lsl/api/measurements/GetPatientGlucoseMeasurements?patientId=${userId}`)
  debug.push(`lsl_meas=${measRes.status}`)
  if (measRes.ok) {
    const pts = extractReadings(measRes.json)
    debug.push(`lsl_meas_points=${pts.length}`)
    readings.push(...pts)
  }

  const selfGraphRes = await lluGet(lluToken, accountId, baseUrl, `/llu/users/${userId}/graph`)
  debug.push(`llu_self=${selfGraphRes.status}`)
  if (selfGraphRes.ok) {
    const pts = extractReadings(selfGraphRes.json)
    debug.push(`llu_self_points=${pts.length}`)
    readings.push(...pts)
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

async function lslGet(token, baseUrl, path) {
  const res = await fetchWithRetry(`${baseUrl}${path}`, {
    headers: { ...LSL_BASE_HEADERS, Authorization: `Bearer ${token}` },
  }, `lsl:${path}`)
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

  for (const entry of entries) {
    const rates = calculateRates(entry, timeline)
    entry.glucoseRate = rates
    entry.glucoseRateMmolPerMin = rates
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

function parseLibreTimestamp(ts, tzOffsetMinutes) {
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
  return new Date(localMs - tzOffsetMinutes * 60_000).toISOString()
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
    tzOffsetMinutes: Number(process.env.LIBREVIEW_TZ_OFFSET ?? 120),
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
  }

  if (!Number.isFinite(next.tzOffsetMinutes)) {
    throw new Error('LIBREVIEW_TZ_OFFSET moet een getal in minuten zijn.')
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
