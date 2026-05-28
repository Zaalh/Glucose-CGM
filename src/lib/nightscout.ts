import type { GlucoseReading, TrendDirection } from '../types'

const MGDL_PER_MMOL = 18.0182

function defaultNightscoutUrl() {
  if (typeof window === 'undefined') return 'http://localhost:1337'
  return `${window.location.protocol}//${window.location.hostname}:1337`
}

const nightscoutUrl = (
  import.meta.env.VITE_NIGHTSCOUT_URL as string | undefined
)?.replace(/\/+$/, '') || defaultNightscoutUrl()

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
  const count = rangeHours > 48 ? 20_000 : Math.max(300, Math.ceil(rangeHours * 80))
  const entries = await fetchNightscoutEntries(`${nightscoutUrl}/api/v1/entries/sgv.json?count=${count}`)

  if (rangeHours > 48) {
    const pdfEntries = await fetchDeviceHistory('glucose-cgm-pdf-history')
    entries.push(...pdfEntries)
  }

  const readings = entries
    .map(toGlucoseReading)
    .filter((reading): reading is GlucoseReading => reading !== null)
    .filter((reading, index, all) => {
      const key = `${reading.source}-${reading.timestamp}`
      return all.findIndex(candidate => `${candidate.source}-${candidate.timestamp}` === key) === index
    })
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  const latest = readings.at(-1)
  if (!latest) return []

  const anchorMs = new Date(latest.timestamp).getTime()
  const sinceMs = anchorMs - rangeHours * 60 * 60 * 1000

  return readings
    .filter((reading) => new Date(reading.timestamp).getTime() >= sinceMs)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
}

async function fetchNightscoutEntries(url: string): Promise<NightscoutEntry[]> {
  const res = await fetch(url)

  if (!res.ok) {
    throw new Error(`Nightscout gaf HTTP ${res.status}`)
  }

  return (await res.json()) as NightscoutEntry[]
}

async function fetchDeviceHistory(device: string): Promise<NightscoutEntry[]> {
  const entries: NightscoutEntry[] = []
  let beforeDate: number | null = null

  for (let page = 0; page < 5; page++) {
    const before = beforeDate === null ? '' : `&find%5Bdate%5D%5B%24lt%5D=${beforeDate}`
    const batch = await fetchNightscoutEntries(
      `${nightscoutUrl}/api/v1/entries/sgv.json?find%5Bdevice%5D=${encodeURIComponent(device)}${before}&count=5000`,
    )
    if (batch.length === 0) break

    entries.push(...batch)

    const oldestDate = Math.min(...batch.map(entry => Number(entry.date)).filter(Number.isFinite))
    if (!Number.isFinite(oldestDate)) break
    beforeDate = oldestDate

    if (batch.length < 5000) break
  }

  return entries
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
