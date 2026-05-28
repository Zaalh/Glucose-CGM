import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { AlertRule } from '../types'
import AlertRuleRow from '../components/AlertRuleRow'
import styles from './Settings.module.css'

export default function Settings() {
  const [rules, setRules] = useState<AlertRule[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [newName, setNewName] = useState('')
  const [newLow, setNewLow] = useState('')
  const [newHigh, setNewHigh] = useState('')

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

  return (
    <div className={styles.page}>
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
