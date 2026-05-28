import type { AlertRule } from '../types'
import styles from './AlertRuleRow.module.css'

interface Props {
  rule: AlertRule
  onToggle: (id: string, enabled: boolean) => void
  onDelete: (id: string) => void
}

export default function AlertRuleRow({ rule, onToggle, onDelete }: Props) {
  return (
    <div className={`${styles.row} ${!rule.enabled ? styles.disabled : ''}`}>
      <div className={styles.info}>
        <span className={styles.name}>{rule.name}</span>
        <div className={styles.thresholds}>
          {rule.threshold_low != null && (
            <span className={styles.tag}>
              <span className={styles.tagDot} style={{ background: 'var(--color-danger-muted)' }} />
              Laag: {rule.threshold_low.toFixed(1)}
            </span>
          )}
          {rule.threshold_high != null && (
            <span className={styles.tag}>
              <span className={styles.tagDot} style={{ background: 'var(--color-warning)' }} />
              Hoog: {rule.threshold_high.toFixed(1)}
            </span>
          )}
        </div>
      </div>
      <div className={styles.actions}>
        <button
          className={`${styles.toggle} ${rule.enabled ? styles.on : styles.off}`}
          onClick={() => onToggle(rule.id, !rule.enabled)}
          title={rule.enabled ? 'Deactiveren' : 'Activeren'}
        >
          {rule.enabled ? 'Actief' : 'Inactief'}
        </button>
        <button
          className={styles.deleteBtn}
          onClick={() => onDelete(rule.id)}
          title="Verwijderen"
        >
          ×
        </button>
      </div>
    </div>
  )
}
