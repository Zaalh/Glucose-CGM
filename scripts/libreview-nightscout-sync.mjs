import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const LIBRE_API = 'https://api-eu.libreview.io'
const DEFAULT_INTERVAL_SECONDS = 60

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
  const entries = readings
    .filter((pt) => (pt.Timestamp ?? pt.FactoryTimestamp) && (pt.Value ?? pt.ValueInMgPerDl))
    .map(toNightscoutEntry)
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.identifier === entry.identifier) === index)
    .filter((entry) => !knownIdentifiers.has(entry.identifier))
    .sort((a, b) => a.date - b.date)

  if (entries.length === 0) {
    console.log(`[libreview-sync] Geen nieuwe metingen. ${debugInfo}`)
    return { success: true, processed: readings.length, uploaded: 0, message: 'Geen nieuwe metingen.', debug: debugInfo }
  }

  await uploadEntries(entries)
  console.log(`[libreview-sync] ${entries.length} metingen naar Nightscout geschreven. ${debugInfo}`)
  return {
    success: true,
    processed: readings.length,
    uploaded: entries.length,
    message: `${entries.length} metingen naar Nightscout geschreven.`,
    debug: debugInfo,
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

    if (req.url === '/health') {
      const current = readConfig(false)
      res.end(JSON.stringify({
        ok: true,
        configured: Boolean(current.email && current.password && current.apiSecret),
        intervalSeconds: current.intervalSeconds,
      }))
      return
    }

    if (req.url === '/sync' && (req.method === 'POST' || req.method === 'GET')) {
      try {
        const result = await syncOnce()
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ success: false, message: formatError(err) }))
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
    const res = await fetch(`${baseUrl}/llu/auth/login`, {
      method: 'POST',
      headers: LLU_BASE_HEADERS,
      body: JSON.stringify({ email, password }),
    })
    const text = await res.text()
    const json = parseJson(text, `Login parse fout: ${text.slice(0, 200)}`)
    if (!res.ok) throw new Error(`Login mislukt (${res.status}): ${JSON.stringify(json).slice(0, 300)}`)
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

  const lslRes = await fetch(`${baseUrl}/lsl/api/nisperson/getauthenticateduser`, {
    method: 'POST',
    headers: { ...LSL_BASE_HEADERS, Authorization: `Bearer ${lluToken}` },
    body: JSON.stringify({ email, password }),
  })
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

  const connRes = await lluGet(lluToken, accountId, baseUrl, '/llu/connections')
  debug.push(`llu_conn=${connRes.status}`)

  if (connRes.ok) {
    const connections = connRes.json?.data ?? []
    const readings = []
    for (const conn of connections) {
      const graphRes = await lluGet(lluToken, accountId, baseUrl, `/llu/connections/${conn.patientId}/graph`)
      debug.push(`llu_graph=${graphRes.status}`)
      if (!graphRes.ok) continue
      readings.push(...extractReadings(graphRes.json))
    }
    if (readings.length > 0) return { readings, debugInfo: debug.join(', ') }
  }

  const histRes = await lslGet(lslToken, baseUrl, '/glucoseHistory?numPeriods=5&period=7')
  debug.push(`lsl_hist=${histRes.status}`)
  if (histRes.ok) {
    const readings = extractReadings(histRes.json)
    if (readings.length > 0) {
      debug.push(`found=${readings.length}`)
      return { readings, debugInfo: debug.join(', ') }
    }
  }

  const measRes = await lslGet(lslToken, baseUrl, `/lsl/api/measurements/GetPatientGlucoseMeasurements?patientId=${userId}`)
  debug.push(`lsl_meas=${measRes.status}`)
  if (measRes.ok) {
    const readings = extractReadings(measRes.json)
    if (readings.length > 0) {
      debug.push(`found=${readings.length}`)
      return { readings, debugInfo: debug.join(', ') }
    }
  }

  const selfGraphRes = await lluGet(lluToken, accountId, baseUrl, `/llu/users/${userId}/graph`)
  debug.push(`llu_self=${selfGraphRes.status}`)
  if (selfGraphRes.ok) {
    const readings = extractReadings(selfGraphRes.json)
    if (readings.length > 0) return { readings, debugInfo: debug.join(', ') }
  }

  throw new Error(
    `Geen sensordata. Debug: ${debug.join(', ')}. ` +
    'Open de FreeStyle LibreLink app en accepteer eventuele gebruiksvoorwaarden.'
  )
}

async function lluGet(token, accountId, baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { ...LLU_BASE_HEADERS, Authorization: `Bearer ${token}`, 'account-id': accountId },
  })
  return responseJson(res)
}

async function lslGet(token, baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { ...LSL_BASE_HEADERS, Authorization: `Bearer ${token}` },
  })
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

async function uploadEntries(entries) {
  const res = await fetch(`${config.nightscoutUrl}/api/v1/entries`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-secret': sha1hex(config.apiSecret),
    },
    body: JSON.stringify(entries),
  })

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

function parseJson(text, errorMessage) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(errorMessage)
  }
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
    apiSecret: requireSecrets ? requiredEnv('API_SECRET') : optionalEnv('API_SECRET'),
    intervalSeconds: Number(process.env.LIBREVIEW_INTERVAL_SECONDS ?? DEFAULT_INTERVAL_SECONDS),
  }

  if (!Number.isFinite(next.tzOffsetMinutes)) {
    throw new Error('LIBREVIEW_TZ_OFFSET moet een getal in minuten zijn.')
  }

  if (!Number.isFinite(next.intervalSeconds) || next.intervalSeconds < 30) {
    throw new Error('LIBREVIEW_INTERVAL_SECONDS moet minimaal 30 zijn.')
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
