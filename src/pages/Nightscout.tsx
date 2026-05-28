import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import type { GlucoseReading } from '../types'
import { getGlucoseStatus, trendArrow } from '../types'
import NightscoutChart from '../components/NightscoutChart'
import {
  loadThresholds,
  checkAlarms,
  checkStale,
  playAlarm,
  sendNotification,
  snooze,
  ALARM_LABELS,
  ALARM_COLORS,
  type ActiveAlarm,
} from '../lib/alarms'
import { predictGlucose, computeAndSavePersonalRates, getPredictionConfidence } from '../lib/prediction'
import styles from './Nightscout.module.css'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string

const RANGE_OPTIONS = [1, 2, 3, 6, 12, 24, 48] as const
type Range = typeof RANGE_OPTIONS[number]

type Unit = 'mmol' | 'mgdl'

function mmolToMgdl(v: number) { return Math.round(v * 18.0182) }
function fmtVal(v: number, unit: Unit) {
  return unit === 'mgdl' ? `${mmolToMgdl(v)}` : v.toFixed(1)
}

// Estimated HbA1c from average glucose (mmol/L): IFCC formula
function estimateHba1c(avgMmol: number) {
  return ((avgMmol + 2.59) / 1.59).toFixed(1)
}

function stdDev(readings: GlucoseReading[]) {
  if (readings.length < 2) return null
  const mean = readings.reduce((s, r) => s + r.value_mmol, 0) / readings.length
  const variance = readings.reduce((s, r) => s + (r.value_mmol - mean) ** 2, 0) / readings.length
  return Math.sqrt(variance)
}

export default function Nightscout() {
  const [readings, setReadings] = useState<GlucoseReading[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<Range>(3)
  const [unit, setUnit] = useState<Unit>('mmol')
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [countdown, setCountdown] = useState(60)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [activeAlarm, setActiveAlarm] = useState<ActiveAlarm | null>(null)
  const [staleAlarm, setStaleAlarm] = useState(false)
  const [predictedIn20, setPredictedIn20] = useState<number | null>(null)
  const [predConfidence, setPredConfidence] = useState<'high' | 'medium' | 'low'>('low')
  const lastAlarmKey = useRef<string | null>(null)

  const fetchReadings = useCallback(async () => {
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
    setLastUpdated(new Date())
    setLoading(false)
    setCountdown(60)

    // Compute personalized rates from full history (background learning)
    computeAndSavePersonalRates(readings)

    // Alarm check with smart prediction
    const latest = readings.at(-1) ?? null
    const thresholds = loadThresholds()

    let pred: number | null = null
    let confidence: 'high' | 'medium' | 'low' = 'low'
    if (latest) {
      const window = readings.slice(-5)
      pred = predictGlucose(window, latest, 20)
      confidence = getPredictionConfidence(window)
    }

    setPredictedIn20(pred)
    setPredConfidence(confidence)

    const alarm = checkAlarms(latest, thresholds, pred)
    const stale = thresholds.enabled ? checkStale(latest, thresholds.staleMinutes) : false

    setActiveAlarm(alarm)
    setStaleAlarm(stale)

    if (alarm) {
      const key = `${alarm.level}-${alarm.value}`
      if (lastAlarmKey.current !== key) {
        lastAlarmKey.current = key
        playAlarm(alarm.level === 'urgent_low' || alarm.level === 'urgent_high')
        const label = ALARM_LABELS[alarm.level]
        sendNotification(label, `${alarm.value.toFixed(1)} mmol/L${alarm.isPredictive ? ' (voorspeld)' : ''}`)
      }
    } else if (stale) {
      const key = 'stale'
      if (lastAlarmKey.current !== key) {
        lastAlarmKey.current = key
        playAlarm(false)
        sendNotification('Sensor verloren', 'Geen recente glucosemeting ontvangen.')
      }
    } else {
      lastAlarmKey.current = null
    }
  }, [range])

  useEffect(() => {
    fetchReadings()
    const dataInterval = setInterval(fetchReadings, 60_000)

    countdownRef.current = setInterval(() => {
      setCountdown(c => (c <= 1 ? 60 : c - 1))
    }, 1000)

    return () => {
      clearInterval(dataInterval)
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
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
  const prev = readings.length >= 2 ? readings[readings.length - 2] : null
  const status = latest ? getGlucoseStatus(latest.value_mmol) : null
  const minutesAgo = latest
    ? Math.round((Date.now() - new Date(latest.timestamp).getTime()) / 60000)
    : null

  const delta = latest && prev
    ? latest.value_mmol - prev.value_mmol
    : null

  const avgMmol = readings.length > 0
    ? readings.reduce((s, r) => s + r.value_mmol, 0) / readings.length
    : null

  const sd = stdDev(readings)
  const cv = avgMmol && sd ? Math.round((sd / avgMmol) * 100) : null

  // TIR breakdown (mmol)
  const veryLow = readings.filter(r => r.value_mmol < 3.0).length
  const low = readings.filter(r => r.value_mmol >= 3.0 && r.value_mmol < 3.9).length
  const inRange = readings.filter(r => r.value_mmol >= 3.9 && r.value_mmol <= 10.0).length
  const high = readings.filter(r => r.value_mmol > 10.0 && r.value_mmol <= 13.9).length
  const veryHigh = readings.filter(r => r.value_mmol > 13.9).length
  const total = readings.length

  const tirPct = (n: number) => total > 0 ? Math.round((n / total) * 100) : 0

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
          <button
            className={`${styles.unitBtn} ${unit === 'mgdl' ? styles.unitActive : ''}`}
            onClick={() => setUnit(u => u === 'mmol' ? 'mgdl' : 'mmol')}
          >
            {unit === 'mmol' ? 'mmol/L' : 'mg/dL'}
          </button>
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

      {/* Alarm banner */}
      {(activeAlarm || staleAlarm) && (
        <div
          className={styles.alarmBanner}
          style={{ borderColor: activeAlarm ? ALARM_COLORS[activeAlarm.level] : ALARM_COLORS.stale }}
        >
          <div className={styles.alarmBannerLeft}>
            <span
              className={styles.alarmBannerDot}
              style={{ background: activeAlarm ? ALARM_COLORS[activeAlarm.level] : ALARM_COLORS.stale }}
            />
            <div>
              <div className={styles.alarmBannerTitle}>
                {activeAlarm
                  ? `${ALARM_LABELS[activeAlarm.level]}${activeAlarm.isPredictive ? ' (voorspeld)' : ''}`
                  : 'Sensor verloren'}
              </div>
              {activeAlarm && (
                <div className={styles.alarmBannerSub}>
                  {fmtVal(activeAlarm.value, unit)} {unit === 'mgdl' ? 'mg/dL' : 'mmol/L'}
                  {activeAlarm.predicted !== undefined && (
                    <> · voorspeld {fmtVal(activeAlarm.predicted, unit)} over 20 min</>
                  )}
                </div>
              )}
              {staleAlarm && !activeAlarm && (
                <div className={styles.alarmBannerSub}>Geen recente meting ontvangen</div>
              )}
            </div>
          </div>
          <div className={styles.alarmBannerRight}>
            <button
              className={styles.snoozeBtn}
              onClick={() => {
                const level = activeAlarm ? activeAlarm.level : 'stale'
                snooze(level, 15)
                setActiveAlarm(null)
                setStaleAlarm(false)
              }}
            >
              Snooze 15 min
            </button>
            <button
              className={styles.snoozeBtn}
              onClick={() => {
                const level = activeAlarm ? activeAlarm.level : 'stale'
                snooze(level, 30)
                setActiveAlarm(null)
                setStaleAlarm(false)
              }}
            >
              30 min
            </button>
            <button
              className={styles.snoozeBtn}
              onClick={() => {
                const level = activeAlarm ? activeAlarm.level : 'stale'
                snooze(level, 60)
                setActiveAlarm(null)
                setStaleAlarm(false)
              }}
            >
              60 min
            </button>
          </div>
        </div>
      )}

      {/* Main reading */}
      <div className={`${styles.hero} ${styles[status ?? 'normal']}`}>
        {loading ? (
          <div className={styles.heroLoading}>–</div>
        ) : latest ? (
          <>
            <div className={styles.heroValue}>
              {fmtVal(latest.value_mmol, unit)}
              <span className={styles.heroUnit}>{unit === 'mgdl' ? 'mg/dL' : 'mmol/L'}</span>
            </div>
            <div className={styles.heroRow}>
              <span className={styles.heroTrend}>{trendArrow(latest.trend)}</span>
              {delta !== null && (
                <span className={styles.heroDelta}>
                  {delta >= 0 ? '+' : ''}{unit === 'mgdl' ? Math.round(delta * 18.0182) : delta.toFixed(1)}
                </span>
              )}
            </div>
            {predictedIn20 !== null && (
              <div className={styles.heroPrediction}>
                <span className={styles.heroPredLabel}>Over 20 min</span>
                <span className={styles.heroPredValue}>
                  {fmtVal(predictedIn20, unit)} {unit === 'mgdl' ? 'mg/dL' : 'mmol/L'}
                </span>
                <span className={`${styles.heroPredConf} ${styles[`conf_${predConfidence}`]}`}>
                  {predConfidence === 'high' ? 'nauwkeurig' : predConfidence === 'medium' ? 'schatting' : 'beperkte data'}
                </span>
              </div>
            )}
            <div className={styles.heroMeta}>
              <span>{minutesAgo !== null && minutesAgo <= 1 ? 'Nu' : `${minutesAgo} min geleden`}</span>
              {lastUpdated && <span className={styles.heroDot}>·</span>}
              {lastUpdated && <span>bijgewerkt {formatClock(lastUpdated)}</span>}
              <span className={styles.heroDot}>·</span>
              <span className={styles.heroCountdown}>ververs in {countdown}s</span>
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
          <NightscoutChart readings={readings} unit={unit} />
        )}
      </div>

      {/* TIR bar */}
      {total > 0 && (
        <div className={styles.tirSection}>
          <div className={styles.tirLabel}>Tijd in bereik</div>
          <div className={styles.tirBar}>
            {veryLow > 0 && <div className={styles.tirVeryLow} style={{ width: `${tirPct(veryLow)}%` }} title={`Zeer laag: ${tirPct(veryLow)}%`} />}
            {low > 0 && <div className={styles.tirLow} style={{ width: `${tirPct(low)}%` }} title={`Laag: ${tirPct(low)}%`} />}
            <div className={styles.tirNormal} style={{ width: `${tirPct(inRange)}%` }} title={`In bereik: ${tirPct(inRange)}%`} />
            {high > 0 && <div className={styles.tirHigh} style={{ width: `${tirPct(high)}%` }} title={`Hoog: ${tirPct(high)}%`} />}
            {veryHigh > 0 && <div className={styles.tirVeryHigh} style={{ width: `${tirPct(veryHigh)}%` }} title={`Zeer hoog: ${tirPct(veryHigh)}%`} />}
          </div>
          <div className={styles.tirLegend}>
            {veryLow > 0 && <span className={styles.tirLegVeryLow}>Zeer laag {tirPct(veryLow)}%</span>}
            {low > 0 && <span className={styles.tirLegLow}>Laag {tirPct(low)}%</span>}
            <span className={styles.tirLegNormal}>In bereik {tirPct(inRange)}%</span>
            {high > 0 && <span className={styles.tirLegHigh}>Hoog {tirPct(high)}%</span>}
            {veryHigh > 0 && <span className={styles.tirLegVeryHigh}>Zeer hoog {tirPct(veryHigh)}%</span>}
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className={styles.statsRow}>
        <StatTile
          label="Gemiddelde"
          value={avgMmol !== null ? fmtVal(avgMmol, unit) : '–'}
          unit={unit === 'mgdl' ? 'mg/dL' : 'mmol/L'}
        />
        <StatTile
          label="Min"
          value={total ? fmtVal(Math.min(...readings.map(r => r.value_mmol)), unit) : '–'}
          unit={unit === 'mgdl' ? 'mg/dL' : 'mmol/L'}
          color="low"
        />
        <StatTile
          label="Max"
          value={total ? fmtVal(Math.max(...readings.map(r => r.value_mmol)), unit) : '–'}
          unit={unit === 'mgdl' ? 'mg/dL' : 'mmol/L'}
          color="high"
        />
        <StatTile
          label="Std. afwijking"
          value={sd !== null ? (unit === 'mgdl' ? Math.round(sd * 18.0182).toString() : sd.toFixed(1)) : '–'}
          unit={unit === 'mgdl' ? 'mg/dL' : 'mmol/L'}
        />
        <StatTile label="CV" value={cv !== null ? `${cv}%` : '–'} hint={cv !== null ? (cv <= 36 ? 'stabiel' : 'variabel') : undefined} />
        <StatTile label="Gesch. HbA1c" value={avgMmol !== null ? `${estimateHba1c(avgMmol)}%` : '–'} />
        <StatTile label="In bereik" value={total ? `${tirPct(inRange)}%` : '–'} />
        <StatTile label="Metingen" value={total > 0 ? String(total) : '–'} />
      </div>
    </div>
  )
}

function StatTile({ label, value, unit, color, hint }: {
  label: string; value: string; unit?: string; color?: 'low' | 'high'; hint?: string
}) {
  return (
    <div className={styles.statTile}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} ${color ? styles[color] : ''}`}>
        {value}
        {unit && <span className={styles.statUnit}> {unit}</span>}
      </span>
      {hint && <span className={styles.statHint}>{hint}</span>}
    </div>
  )
}

function formatClock(d: Date) {
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}
