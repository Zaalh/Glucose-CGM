const INFLUX_URL = process.env.INFLUX_URL || 'http://127.0.0.1:8086'
const INFLUX_DB = process.env.INFLUXDB_DB || 'xdrip'
const INFLUX_USER = process.env.INFLUXDB_USER || process.env.INFLUXDB_ADMIN_USER || 'root'
const INFLUX_PASSWORD = process.env.INFLUXDB_USER_PASSWORD || process.env.INFLUXDB_ADMIN_PASSWORD || 'root'
const LOOKBACK_MINUTES = Number(process.env.FORECAST_LOOKBACK_MINUTES || 20)
const MAX_RATE_MMOL_PER_MIN = Number(process.env.FORECAST_MAX_RATE_MMOL_PER_MIN || 0.0555)
const HORIZONS_MINUTES = (process.env.FORECAST_HORIZONS_MINUTES || '0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 0)

function round(value, digits = 4) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function basicAuth() {
  return `Basic ${Buffer.from(`${INFLUX_USER}:${INFLUX_PASSWORD}`).toString('base64')}`
}

async function influxQuery(query) {
  const url = new URL('/query', INFLUX_URL)
  url.searchParams.set('db', INFLUX_DB)
  url.searchParams.set('q', query)
  const res = await fetch(url, { headers: { Authorization: basicAuth() } })
  if (!res.ok) throw new Error(`Influx query failed ${res.status}: ${await res.text()}`)
  const body = await res.json()
  if (body.error) throw new Error(body.error)
  const series = body.results?.[0]?.series?.[0]
  return series ? series.values.map((row) => Object.fromEntries(series.columns.map((column, index) => [column, row[index]]))) : []
}

async function influxWrite(lines) {
  if (!lines.length) return
  const url = new URL('/write', INFLUX_URL)
  url.searchParams.set('db', INFLUX_DB)
  url.searchParams.set('precision', 'ms')
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'text/plain',
    },
    body: lines.join('\n'),
  })
  if (!res.ok) throw new Error(`Influx write failed ${res.status}: ${await res.text()}`)
}

function parseTimeMs(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function computeRate(rows) {
  const latest = rows.at(-1)
  if (!latest) return null
  const latestTime = parseTimeMs(latest.time)
  const latestValue = Number(latest.value_mmol)
  if (!Number.isFinite(latestTime) || !Number.isFinite(latestValue)) return null

  let baseline = null
  const targetTime = latestTime - LOOKBACK_MINUTES * 60_000
  for (const row of rows) {
    const time = parseTimeMs(row.time)
    const value = Number(row.value_mmol)
    if (!Number.isFinite(time) || !Number.isFinite(value)) continue
    if (!baseline || Math.abs(time - targetTime) < Math.abs(parseTimeMs(baseline.time) - targetTime)) baseline = row
  }
  if (!baseline) return null

  const baselineTime = parseTimeMs(baseline.time)
  const baselineValue = Number(baseline.value_mmol)
  const actualMinutes = (latestTime - baselineTime) / 60_000
  if (actualMinutes <= 0 || !Number.isFinite(baselineValue)) return null

  const rawRate = (latestValue - baselineValue) / actualMinutes
  const rate = Math.max(-MAX_RATE_MMOL_PER_MIN, Math.min(MAX_RATE_MMOL_PER_MIN, rawRate))
  return {
    latestTime,
    latestValue,
    rawRate,
    rate,
    actualMinutes,
  }
}

async function main() {
  const rows = await influxQuery(`SELECT "value_mmol" FROM "glucose" WHERE time >= now() - 3h ORDER BY time ASC`)
  const rate = computeRate(rows)
  if (!rate) {
    console.log(JSON.stringify({ ok: false, reason: 'not_enough_glucose_rows', rows: rows.length }))
    return
  }

  const lines = HORIZONS_MINUTES.map((minutes) => {
    const value = Math.max(1.5, Math.min(33, rate.latestValue + rate.rate * minutes))
    const timestamp = rate.latestTime + minutes * 60_000
    return [
      'glucose_forecast,series=forecast',
      `value_mmol=${round(value)},rate_mmol_per_min=${round(rate.rate)},raw_rate_mmol_per_min=${round(rate.rawRate)},source_value_mmol=${round(rate.latestValue)},actual_minutes=${round(rate.actualMinutes, 2)},horizon_minutes=${minutes}i`,
      timestamp,
    ].join(' ')
  })

  await influxWrite(lines)
  console.log(JSON.stringify({
    ok: true,
    rows: rows.length,
    latestTime: new Date(rate.latestTime).toISOString(),
    latestValue: round(rate.latestValue),
    rateMmolPerMin: round(rate.rate),
    rawRateMmolPerMin: round(rate.rawRate),
    horizons: HORIZONS_MINUTES,
  }))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
