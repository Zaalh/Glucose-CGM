import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import type { GlucoseReading } from '../types'
import { getGlucoseStatus, trendArrow } from '../types'
import NightscoutChart from '../components/NightscoutChart'
import styles from './Nightscout.module.css'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string

const RANGE_OPTIONS = [1, 2, 3, 6, 12, 24] as const
type Range = typeof RANGE_OPTIONS[number]

export default function Nightscout() {
  const [readings, setReadings] = useState<GlucoseReading[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<Range>(3)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchReadings = useCallback(async () => {
    setLoading(true)
    // Gebruik de nieuwste DB-timestamp als ankerpunt zodat tijdzone-afwijkingen geen rol spelen
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
    setLastUpdated(new Date())
    setLoading(false)
  }, [range])

  useEffect(() => {
    fetchReadings()
    const interval = setInterval(fetchReadings, 60_000)
    return () => clearInterval(interval)
  }, [fetchReadings])

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
      setSyncMsg({ text: json.message ?? (json.success ? 'Gesynchroniseerd.' : 'Mislukt.'), ok: !!json.success })
      if (json.success) await fetchReadings()
    } catch {
      setSyncMsg({ text: 'Verbindingsfout.', ok: false })
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncMsg(null), 12000)
    }
  }

  const latest = readings.at(-1) ?? null
  const status = latest ? getGlucoseStatus(latest.value_mmol) : null
  const minutesAgo = latest
    ? Math.round((Date.now() - new Date(latest.timestamp).getTime()) / 60000)
    : null

  const inRange = readings.filter(r => r.value_mmol >= 3.9 && r.value_mmol <= 10.0).length
  const tir = readings.length > 0 ? Math.round((inRange / readings.length) * 100) : null
  const avgVal = readings.length > 0
    ? (readings.reduce((s, r) => s + r.value_mmol, 0) / readings.length).toFixed(1)
    : null

  return (
    <div className={styles.page}>
      {/* Top bar */}
      <div className={styles.topBar}>
        <div className={styles.rangeButtons}>
          {RANGE_OPTIONS.map(r => (
            <button
              key={r}
              className={`${styles.rangeBtn} ${range === r ? styles.active : ''}`}
              onClick={() => setRange(r)}
            >
              {r}u
            </button>
          ))}
        </div>
        <div className={styles.topRight}>
          {syncMsg && (
            <span className={`${styles.syncMsg} ${syncMsg.ok ? styles.syncOk : styles.syncErr}`}>
              {syncMsg.text}
            </span>
          )}
          <button className={styles.syncBtn} onClick={syncLibreView} disabled={syncing}>
            <span className={syncing ? styles.spinning : ''}>⟳</span>
            {syncing ? 'Syncing...' : 'Sync Libre'}
          </button>
        </div>
      </div>

      {/* Main reading */}
      <div className={`${styles.hero} ${styles[status ?? 'normal']}`}>
        {loading ? (
          <div className={styles.heroLoading}>–</div>
        ) : latest ? (
          <>
            <div className={styles.heroValue}>
              {latest.value_mmol.toFixed(1)}
              <span className={styles.heroUnit}>mmol/L</span>
            </div>
            <div className={styles.heroTrend}>{trendArrow(latest.trend)}</div>
            <div className={styles.heroMeta}>
              {minutesAgo !== null && minutesAgo <= 1 ? 'Nu' : `${minutesAgo} min geleden`}
              {lastUpdated && (
                <span className={styles.heroDot}>·</span>
              )}
              {lastUpdated && (
                <span>bijgewerkt {formatClock(lastUpdated)}</span>
              )}
            </div>
          </>
        ) : (
          <div className={styles.heroEmpty}>Geen data</div>
        )}
      </div>

      {/* Chart */}
      <div className={styles.chartWrap}>
        {loading ? (
          <div className={styles.chartLoading}>Laden...</div>
        ) : readings.length === 0 ? (
          <div className={styles.chartEmpty}>Geen metingen in dit tijdvenster</div>
        ) : (
          <NightscoutChart readings={readings} />
        )}
      </div>

      {/* Stats row */}
      <div className={styles.statsRow}>
        <StatTile label="Gem." value={avgVal ?? '–'} unit="mmol/L" />
        <StatTile
          label="Min"
          value={readings.length ? Math.min(...readings.map(r => r.value_mmol)).toFixed(1) : '–'}
          unit="mmol/L"
          color="low"
        />
        <StatTile
          label="Max"
          value={readings.length ? Math.max(...readings.map(r => r.value_mmol)).toFixed(1) : '–'}
          unit="mmol/L"
          color="high"
        />
        <StatTile label="Tijd in range" value={tir !== null ? `${tir}%` : '–'} />
        <StatTile label="Metingen" value={readings.length > 0 ? String(readings.length) : '–'} />
      </div>
    </div>
  )
}

function StatTile({ label, value, unit, color }: {
  label: string; value: string; unit?: string; color?: 'low' | 'high'
}) {
  return (
    <div className={styles.statTile}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} ${color ? styles[color] : ''}`}>
        {value}
        {unit && <span className={styles.statUnit}> {unit}</span>}
      </span>
    </div>
  )
}

function formatClock(d: Date) {
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}
