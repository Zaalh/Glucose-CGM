import type { GlucoseReading, TrendDirection } from '../types'

export type AlarmLevel = 'urgent_low' | 'low' | 'high' | 'urgent_high' | 'stale'

export interface AlarmThresholds {
  urgentLow: number   // mmol/L
  low: number
  high: number
  urgentHigh: number
  enabled: boolean
  staleMinutes: number
}

const STORAGE_KEY = 'cgm_alarm_thresholds'
const SNOOZE_KEY = 'cgm_alarm_snooze'

export const DEFAULT_THRESHOLDS: AlarmThresholds = {
  urgentLow: 3.0,
  low: 3.9,
  high: 10.0,
  urgentHigh: 13.9,
  enabled: false,
  staleMinutes: 15,
}

export function loadThresholds(): AlarmThresholds {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULT_THRESHOLDS, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...DEFAULT_THRESHOLDS }
}

export function saveThresholds(t: AlarmThresholds) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(t))
}

interface SnoozeState {
  [level: string]: { until: number }
}

function loadSnooze(): SnoozeState {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {}
}

function saveSnooze(s: SnoozeState) {
  localStorage.setItem(SNOOZE_KEY, JSON.stringify(s))
}

export function isSnoozed(level: AlarmLevel): boolean {
  const s = loadSnooze()
  return (s[level]?.until ?? 0) > Date.now()
}

export function snooze(level: AlarmLevel, minutes: number) {
  const s = loadSnooze()
  s[level] = { until: Date.now() + minutes * 60_000 }
  saveSnooze(s)
}

export function clearSnooze(level: AlarmLevel) {
  const s = loadSnooze()
  delete s[level]
  saveSnooze(s)
}

// Trend rate of change in mmol/L per minute (approx)
const TREND_RATE: Record<TrendDirection, number> = {
  rising_quickly: 0.15,
  rising: 0.08,
  rising_slowly: 0.03,
  flat: 0,
  falling_slowly: -0.03,
  falling: -0.08,
  falling_quickly: -0.15,
}

export function predictedValue(reading: GlucoseReading, minutes = 20): number {
  const rate = reading.trend ? TREND_RATE[reading.trend] ?? 0 : 0
  return reading.value_mmol + rate * minutes
}

export type ActiveAlarm = {
  level: AlarmLevel
  value: number
  predicted?: number
  isPredictive: boolean
}

export function checkAlarms(
  reading: GlucoseReading | null,
  thresholds: AlarmThresholds,
): ActiveAlarm | null {
  if (!thresholds.enabled || !reading) return null

  const val = reading.value_mmol
  const pred = predictedValue(reading, 20)

  // Actual urgent low
  if (val < thresholds.urgentLow && !isSnoozed('urgent_low')) {
    return { level: 'urgent_low', value: val, isPredictive: false }
  }
  // Actual low
  if (val < thresholds.low && !isSnoozed('low')) {
    return { level: 'low', value: val, isPredictive: false }
  }
  // Predictive urgent low (will reach urgentLow within 20 min)
  if (pred < thresholds.urgentLow && val >= thresholds.urgentLow && !isSnoozed('urgent_low')) {
    return { level: 'urgent_low', value: val, predicted: pred, isPredictive: true }
  }
  // Predictive low
  if (pred < thresholds.low && val >= thresholds.low && !isSnoozed('low')) {
    return { level: 'low', value: val, predicted: pred, isPredictive: true }
  }
  // Actual urgent high
  if (val > thresholds.urgentHigh && !isSnoozed('urgent_high')) {
    return { level: 'urgent_high', value: val, isPredictive: false }
  }
  // Actual high
  if (val > thresholds.high && !isSnoozed('high')) {
    return { level: 'high', value: val, isPredictive: false }
  }

  return null
}

export function checkStale(reading: GlucoseReading | null, staleMinutes: number): boolean {
  if (!reading) return false
  const age = (Date.now() - new Date(reading.timestamp).getTime()) / 60_000
  return age > staleMinutes && !isSnoozed('stale')
}

// Web Audio alarm — no mp3 needed
let audioCtx: AudioContext | null = null
let alarmOscillator: OscillatorNode | null = null
let gainNode: GainNode | null = null

function getAudioCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  return audioCtx
}

export function playAlarm(urgent: boolean) {
  stopAlarm()
  const ctx = getAudioCtx()
  if (ctx.state === 'suspended') ctx.resume()

  gainNode = ctx.createGain()
  gainNode.gain.setValueAtTime(0.4, ctx.currentTime)
  gainNode.connect(ctx.destination)

  alarmOscillator = ctx.createOscillator()
  alarmOscillator.type = 'sine'

  if (urgent) {
    // Alternating high-low tone for urgent
    alarmOscillator.frequency.setValueAtTime(880, ctx.currentTime)
    alarmOscillator.frequency.setValueAtTime(660, ctx.currentTime + 0.25)
    alarmOscillator.frequency.setValueAtTime(880, ctx.currentTime + 0.5)
    alarmOscillator.frequency.setValueAtTime(660, ctx.currentTime + 0.75)
    alarmOscillator.frequency.setValueAtTime(880, ctx.currentTime + 1.0)
    alarmOscillator.frequency.setValueAtTime(660, ctx.currentTime + 1.25)
  } else {
    alarmOscillator.frequency.setValueAtTime(660, ctx.currentTime)
    alarmOscillator.frequency.setValueAtTime(550, ctx.currentTime + 0.4)
    alarmOscillator.frequency.setValueAtTime(660, ctx.currentTime + 0.8)
  }

  alarmOscillator.connect(gainNode)
  alarmOscillator.start()
  alarmOscillator.stop(ctx.currentTime + (urgent ? 2.0 : 1.6))
}

export function stopAlarm() {
  try {
    alarmOscillator?.stop()
  } catch { /* already stopped */ }
  alarmOscillator?.disconnect()
  gainNode?.disconnect()
  alarmOscillator = null
  gainNode = null
}

export function unlockAudio() {
  const ctx = getAudioCtx()
  if (ctx.state === 'suspended') ctx.resume()
}

export function sendNotification(title: string, body: string) {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/vite.svg' })
  }
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') return true
  const result = await Notification.requestPermission()
  return result === 'granted'
}

export const ALARM_LABELS: Record<AlarmLevel, string> = {
  urgent_low: 'Urgent laag',
  low: 'Laag',
  high: 'Hoog',
  urgent_high: 'Urgent hoog',
  stale: 'Sensor verloren',
}

export const ALARM_COLORS: Record<AlarmLevel, string> = {
  urgent_low: '#ff4444',
  low: '#f85149',
  high: '#d29922',
  urgent_high: '#ff9f0a',
  stale: '#8b949e',
}
