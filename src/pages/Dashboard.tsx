import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { GlucoseReading } from '../types'
import { getGlucoseStatus, trendArrow } from '../types'
import GlucoseChart from '../components/GlucoseChart'
import CurrentReading from '../components/CurrentReading'
import styles from './Dashboard.module.css'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export default function Dashboard() {
  const [readings, setReadings] = useState<GlucoseReading[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<3 | 6 | 12 | 24>(6)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  useEffect(() => {
    fetchReadings()
  }, [range])

  async function syncLibreView() {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/libreview-sync`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
      })
      const json = await res.json()
      setSyncMsg(json.message ?? (json.success ? 'Gesynchroniseerd.' : 'Synchronisatie mislukt.'))
      if (json.success) await fetchReadings()
    } catch {
      setSyncMsg('Verbindingsfout bij synchronisatie.')
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncMsg(null), 12000)
    }
  }

  async function fetchReadings() {
    setLoading(true)
    const { data: latestRow } = await supabase
      .from('glucose_readings')
      .select('timestamp')
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle()

    let readings: GlucoseReading[] = []
    if (latestRow?.timestamp) {
      const anchor = new Date(latestRow.timestamp).getTime()
      const since = new Date(anchor - range * 60 * 60 * 1000).toISOString()
      const { data } = await supabase
        .from('glucose_readings')
        .select('id, timestamp, value_mmol, trend, source, created_at')
        .gte('timestamp', since)
        .order('timestamp', { ascending: true })
      readings = (data as GlucoseReading[]) ?? []
    }
    setReadings(readings)
    setLoading(false)
  }

  const latest = readings.at(-1) ?? null
  const status = latest ? getGlucoseStatus(latest.value_mmol) : null

  return (
    <div className={styles.page}>
      <div className={styles.top}>
        <CurrentReading reading={latest} loading={loading} />
        {latest && (
          <div className={styles.meta}>
            <span className={styles.metaItem}>
              <span className={styles.metaLabel}>Trend</span>
              <span className={styles.metaValue}>{trendArrow(latest.trend)}</span>
            </span>
            <span className={styles.metaItem}>
              <span className={styles.metaLabel}>Bron</span>
              <span className={styles.metaValue}>{latest.source}</span>
            </span>
            <span className={styles.metaItem}>
              <span className={styles.metaLabel}>Status</span>
              <span className={`${styles.statusBadge} ${styles[status ?? 'normal']}`}>
                {statusLabel(status)}
              </span>
            </span>
          </div>
        )}
      </div>

      <div className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <span className={styles.chartTitle}>Glucosehistorie</span>
          <div className={styles.chartActions}>
            {syncMsg && <span className={styles.syncMsg}>{syncMsg}</span>}
            <button
              className={styles.syncBtn}
              onClick={syncLibreView}
              disabled={syncing}
              title="Synchroniseer met FreeStyle Libre 3"
            >
              <span className={syncing ? styles.spinning : ''}>⟳</span>
              {syncing ? 'Syncing...' : 'Sync Libre'}
            </button>
            <div className={styles.rangeButtons}>
            {([3, 6, 12, 24] as const).map(r => (
              <button
                key={r}
                className={`${styles.rangeBtn} ${range === r ? styles.active : ''}`}
                onClick={() => setRange(r)}
              >
                {r}u
              </button>
            ))}
            </div>
          </div>
        </div>
        {loading ? (
          <div className={styles.chartLoading}>Laden...</div>
        ) : readings.length === 0 ? (
          <div className={styles.empty}>Geen metingen gevonden voor dit tijdvenster.</div>
        ) : (
          <GlucoseChart readings={readings} />
        )}
      </div>

      <div className={styles.statsRow}>
        <StatCard label="Gemiddelde" value={avg(readings)} unit="mmol/L" />
        <StatCard label="Min" value={min(readings)} unit="mmol/L" />
        <StatCard label="Max" value={max(readings)} unit="mmol/L" />
        <StatCard label="Metingen" value={readings.length.toString()} />
      </div>
    </div>
  )
}

function StatCard({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className={styles.statCard}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>
        {value}
        {unit && <span className={styles.statUnit}> {unit}</span>}
      </span>
    </div>
  )
}

function avg(readings: GlucoseReading[]) {
  if (!readings.length) return '–'
  return (readings.reduce((s, r) => s + r.value_mmol, 0) / readings.length).toFixed(1)
}
function min(readings: GlucoseReading[]) {
  if (!readings.length) return '–'
  return Math.min(...readings.map(r => r.value_mmol)).toFixed(1)
}
function max(readings: GlucoseReading[]) {
  if (!readings.length) return '–'
  return Math.max(...readings.map(r => r.value_mmol)).toFixed(1)
}

function statusLabel(status: ReturnType<typeof getGlucoseStatus> | null) {
  switch (status) {
    case 'very_low': return 'Zeer laag'
    case 'low': return 'Laag'
    case 'normal': return 'Normaal'
    case 'high': return 'Hoog'
    case 'very_high': return 'Zeer hoog'
    default: return '–'
  }
}
