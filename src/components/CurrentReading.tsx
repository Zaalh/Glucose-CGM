import type { GlucoseReading } from '../types'
import { getGlucoseStatus } from '../types'
import styles from './CurrentReading.module.css'

interface Props {
  reading: GlucoseReading | null
  loading: boolean
}

export default function CurrentReading({ reading, loading }: Props) {
  if (loading) {
    return <div className={styles.skeleton} />
  }

  if (!reading) {
    return (
      <div className={styles.card}>
        <span className={styles.noData}>Geen data</span>
      </div>
    )
  }

  const status = getGlucoseStatus(reading.value_mmol)
  const timeAgo = formatTimeAgo(reading.timestamp)

  return (
    <div className={`${styles.card} ${styles[status]}`}>
      <span className={styles.value}>{reading.value_mmol.toFixed(1)}</span>
      <span className={styles.unit}>mmol/L</span>
      <span className={styles.time}>{timeAgo}</span>
    </div>
  )
}

function formatTimeAgo(timestamp: string) {
  const diff = Date.now() - new Date(timestamp).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Zojuist'
  if (mins === 1) return '1 min geleden'
  if (mins < 60) return `${mins} min geleden`
  const hrs = Math.floor(mins / 60)
  return `${hrs}u geleden`
}
