import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { AlertRule } from '../types'
import AlertRuleRow from '../components/AlertRuleRow'
import {
  loadThresholds,
  saveThresholds,
  DEFAULT_THRESHOLDS,
  requestNotificationPermission,
  unlockAudio,
  playAlarm,
  type AlarmThresholds,
} from '../lib/alarms'
import styles from './Settings.module.css'

export default function Settings() {
  const [rules, setRules] = useState<AlertRule[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [newName, setNewName] = useState('')
  const [newLow, setNewLow] = useState('')
  const [newHigh, setNewHigh] = useState('')

  const [thresholds, setThresholds] = useState<AlarmThresholds>(loadThresholds)
  const [notifGranted, setNotifGranted] = useState(
    typeof Notification !== 'undefined' && Notification.permission === 'granted'
  )
  const [audioUnlocked, setAudioUnlocked] = useState(false)

  useEffect(() => {
    fetchRules()
  }, [])

  async function fetchRules() {
    setLoading(true)
    const { data } = await supabase
      .from('alert_rules')
      .select('*')
      .order('created_at', { ascending: true })
    setRules((data as AlertRule[]) ?? [])
    setLoading(false)
  }

  async function addRule() {
    if (!newName.trim()) return
    setSaving(true)
    const { data } = await supabase
      .from('alert_rules')
      .insert({
        name: newName.trim(),
        threshold_low: newLow ? parseFloat(newLow) : null,
        threshold_high: newHigh ? parseFloat(newHigh) : null,
        enabled: true,
      })
      .select()
      .single()
    if (data) setRules(prev => [...prev, data as AlertRule])
    setNewName('')
    setNewLow('')
    setNewHigh('')
    setSaving(false)
  }

  async function toggleRule(id: string, enabled: boolean) {
    await supabase.from('alert_rules').update({ enabled }).eq('id', id)
    setRules(prev => prev.map(r => r.id === id ? { ...r, enabled } : r))
  }

  async function deleteRule(id: string) {
    await supabase.from('alert_rules').delete().eq('id', id)
    setRules(prev => prev.filter(r => r.id !== id))
  }

  function updateThreshold(key: keyof AlarmThresholds, value: number | boolean) {
    const next = { ...thresholds, [key]: value }
    setThresholds(next)
    saveThresholds(next)
  }

  async function handleEnableAlarms(checked: boolean) {
    if (checked) {
      unlockAudio()
      setAudioUnlocked(true)
      const granted = await requestNotificationPermission()
      setNotifGranted(granted)
    }
    updateThreshold('enabled', checked)
  }

  function handleTestAlarm(urgent: boolean) {
    unlockAudio()
    setAudioUnlocked(true)
    playAlarm(urgent)
  }

  function resetThresholds() {
    const next = { ...DEFAULT_THRESHOLDS, enabled: thresholds.enabled }
    setThresholds(next)
    saveThresholds(next)
  }

  return (
    <div className={styles.page}>

      {/* Alarm instellingen */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Alarm instellingen</h2>
        <p className={styles.sectionDesc}>
          Stel drempelwaarden in voor glucose alarmen. Bij overschrijding klinkt er een geluid en verschijnt er een melding.
        </p>

        <div className={styles.alarmToggleRow}>
          <label className={styles.toggleLabel}>
            <span>Alarmen inschakelen</span>
            <div className={styles.toggleWrap}>
              <input
                type="checkbox"
                className={styles.toggleInput}
                checked={thresholds.enabled}
                onChange={e => handleEnableAlarms(e.target.checked)}
              />
              <span className={styles.toggleSlider} />
            </div>
          </label>
          {thresholds.enabled && (
            <div className={styles.alarmStatus}>
              <span className={notifGranted ? styles.statusOk : styles.statusWarn}>
                {notifGranted ? 'Meldingen aan' : 'Meldingen geblokkeerd'}
              </span>
              <span className={audioUnlocked ? styles.statusOk : styles.statusWarn}>
                {audioUnlocked ? 'Geluid ontgrendeld' : 'Klik test om geluid te activeren'}
              </span>
            </div>
          )}
        </div>

        <div className={styles.thresholdGrid}>
          <ThresholdRow
            label="Urgent laag"
            color="#ff4444"
            value={thresholds.urgentLow}
            onChange={v => updateThreshold('urgentLow', v)}
            min={2.0}
            max={4.0}
          />
          <ThresholdRow
            label="Laag"
            color="#f85149"
            value={thresholds.low}
            onChange={v => updateThreshold('low', v)}
            min={2.5}
            max={5.0}
          />
          <ThresholdRow
            label="Hoog"
            color="#d29922"
            value={thresholds.high}
            onChange={v => updateThreshold('high', v)}
            min={7.0}
            max={15.0}
          />
          <ThresholdRow
            label="Urgent hoog"
            color="#ff9f0a"
            value={thresholds.urgentHigh}
            onChange={v => updateThreshold('urgentHigh', v)}
            min={10.0}
            max={22.0}
          />
          <div className={styles.thresholdRow}>
            <span className={styles.thresholdLabel} style={{ color: '#8b949e' }}>Sensor verloren na</span>
            <div className={styles.thresholdInputWrap}>
              <input
                type="number"
                className={styles.thresholdInput}
                value={thresholds.staleMinutes}
                min={10}
                max={60}
                step={1}
                onChange={e => updateThreshold('staleMinutes', Number(e.target.value))}
              />
              <span className={styles.thresholdUnit}>min</span>
            </div>
          </div>
        </div>

        <div className={styles.alarmActions}>
          <button className={styles.testBtn} onClick={() => handleTestAlarm(false)}>
            Test alarm (laag)
          </button>
          <button className={`${styles.testBtn} ${styles.testUrgent}`} onClick={() => handleTestAlarm(true)}>
            Test alarm (urgent)
          </button>
          <button className={styles.resetBtn} onClick={resetThresholds}>
            Standaard herstellen
          </button>
        </div>
      </div>

      {/* Alarmregels */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Alarmregels</h2>
        <p className={styles.sectionDesc}>
          Stel drempelwaarden in voor lage en hoge glucosewaarden (mmol/L).
        </p>

        <div className={styles.addForm}>
          <input
            className={styles.input}
            placeholder="Naam (bijv. Nachtprofiel)"
            value={newName}
            onChange={e => setNewName(e.target.value)}
          />
          <input
            className={styles.inputSmall}
            type="number"
            step="0.1"
            placeholder="Laag (mmol/L)"
            value={newLow}
            onChange={e => setNewLow(e.target.value)}
          />
          <input
            className={styles.inputSmall}
            type="number"
            step="0.1"
            placeholder="Hoog (mmol/L)"
            value={newHigh}
            onChange={e => setNewHigh(e.target.value)}
          />
          <button
            className={styles.addBtn}
            onClick={addRule}
            disabled={saving || !newName.trim()}
          >
            {saving ? 'Opslaan...' : 'Toevoegen'}
          </button>
        </div>

        {loading ? (
          <div className={styles.empty}>Laden...</div>
        ) : rules.length === 0 ? (
          <div className={styles.empty}>Nog geen alarmregels aangemaakt.</div>
        ) : (
          <div className={styles.ruleList}>
            {rules.map(rule => (
              <AlertRuleRow
                key={rule.id}
                rule={rule}
                onToggle={toggleRule}
                onDelete={deleteRule}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ThresholdRow({ label, color, value, onChange, min, max }: {
  label: string
  color: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
}) {
  return (
    <div className={styles.thresholdRow}>
      <span className={styles.thresholdLabel} style={{ color }}>{label}</span>
      <div className={styles.thresholdInputWrap}>
        <input
          type="number"
          className={styles.thresholdInput}
          value={value}
          min={min}
          max={max}
          step={0.1}
          onChange={e => onChange(parseFloat(e.target.value))}
        />
        <span className={styles.thresholdUnit}>mmol/L</span>
      </div>
    </div>
  )
}
