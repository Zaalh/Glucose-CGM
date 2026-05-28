import type { GlucoseReading, TrendDirection } from '../types'

const DEFAULT_NIGHTSCOUT_URL = 'http://localhost:1337'
const MGDL_PER_MMOL = 18.0182

const nightscoutUrl = (
  import.meta.env.VITE_NIGHTSCOUT_URL as string | undefined
)?.replace(/\/+$/, '') || DEFAULT_NIGHTSCOUT_URL

interface NightscoutEntry {
  _id?: string
  date?: number
  dateString?: string
  sgv?: number
  mbg?: number
  direction?: string
  device?: string
}

export async function fetchNightscoutReadings(rangeHours: number): Promise<GlucoseReading[]> {
  const count = Math.max(300, Math.ceil(rangeHours * 80))
  const url = `${nightscoutUrl}/api/v1/entries/sgv.json?count=${count}`
  const res = await fetch(url)

  if (!res.ok) {
    throw new Error(`Nightscout gaf HTTP ${res.status}`)
  }

  const entries = (await res.json()) as NightscoutEntry[]
  const readings = entries
    .map(toGlucoseReading)
    .filter((reading): reading is GlucoseReading => reading !== null)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  const latest = readings.at(-1)
  if (!latest) return []

  const anchorMs = new Date(latest.timestamp).getTime()
  const sinceMs = anchorMs - rangeHours * 60 * 60 * 1000

  return readings
    .filter((reading) => new Date(reading.timestamp).getTime() >= sinceMs)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
}

function toGlucoseReading(entry: NightscoutEntry): GlucoseReading | null {
  const dateMs = Number(entry.date ?? Date.parse(entry.dateString ?? ''))
  const valueMgdl = Number(entry.sgv ?? entry.mbg)

  if (!Number.isFinite(dateMs) || !Number.isFinite(valueMgdl)) return null

  return {
    id: entry._id ?? `${dateMs}`,
    timestamp: new Date(dateMs).toISOString(),
    value_mmol: Math.round((valueMgdl / MGDL_PER_MMOL) * 10) / 10,
    trend: mapDirection(entry.direction),
    source: entry.device ?? 'nightscout-mongo',
    created_at: new Date(dateMs).toISOString(),
  }
}

function mapDirection(direction?: string): TrendDirection | null {
  switch (direction) {
    case 'DoubleUp': return 'rising_quickly'
    case 'SingleUp': return 'rising'
    case 'FortyFiveUp': return 'rising_slowly'
    case 'Flat': return 'flat'
    case 'FortyFiveDown': return 'falling_slowly'
    case 'SingleDown': return 'falling'
    case 'DoubleDown': return 'falling_quickly'
    default: return null
  }
}
