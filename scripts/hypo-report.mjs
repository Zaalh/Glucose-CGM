// Gevensterd rapport over de reactieve-hypo detector: per dag of per week.
//
// Toont voor het gekozen venster: aantal (near-)hypo's, time-in-range, snelste
// daling, en V1 vs V2 (default én geleerde params) op precision/recall/lead-time.
// Omdat je patroon kan wisselen, draai je dit per dag (--days 1) en per week
// (--days 7); gedateerde rapporten maken de verschuiving zichtbaar.
//
// Draaien (mongo in compose-netwerk):
//   docker compose ... run --rm libreview-sync node scripts/hypo-report.mjs --days 7
// Lokaal zonder database:
//   node scripts/hypo-report.mjs --self-test

import { readFileSync } from 'node:fs'
import { MongoClient } from 'mongodb'
import { MGDL_PER_MMOL } from './lib/hypo-features.mjs'
import { buildReplayContext, evaluateV1, evaluateV2 } from './evaluate-hypo-detector.mjs'

const MS_PER_MIN = 60_000
const STATE_PATH = new URL('./reactive-hypo-v2-state.json', import.meta.url)
const GAP_MS = 15 * MS_PER_MIN // intervallen >15 min niet meetellen voor time-in-range
const TZ = process.env.LIBREVIEW_TZ ?? 'Europe/Amsterdam'
const WEEKDAYS = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag']

const weekdayOf = (ms) => new Intl.DateTimeFormat('nl-NL', { weekday: 'long', timeZone: TZ }).format(new Date(ms))
const caldayOf = (ms) =>
  new Intl.DateTimeFormat('nl-NL', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ }).format(new Date(ms))

const mmolOf = (e) => Number(e.sgv) / MGDL_PER_MMOL
function round(v, d) {
  if (!Number.isFinite(v)) return null
  const f = 10 ** d
  return Math.round(v * f) / f
}

function argDays() {
  const i = process.argv.indexOf('--days')
  if (i >= 0) {
    const n = Number(process.argv[i + 1])
    if (Number.isFinite(n) && n > 0) return n
  }
  return 1
}

function loadTunedParams() {
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    return s && s.params ? s : null
  } catch {
    return null
  }
}

// Minuten per bucket op basis van opeenvolgende metingen (gaten >15 min tellen niet).
function timeInRange(windowEntries) {
  const buckets = { below40: 0, below45: 0, in_range: 0, above100: 0 }
  for (let i = 1; i < windowEntries.length; i += 1) {
    const dt = windowEntries[i].date - windowEntries[i - 1].date
    if (dt <= 0 || dt > GAP_MS) continue
    const m = mmolOf(windowEntries[i - 1])
    const min = dt / MS_PER_MIN
    if (m < 4.0) buckets.below40 += min
    else if (m < 4.5) buckets.below45 += min
    else if (m <= 10.0) buckets.in_range += min
    else buckets.above100 += min
  }
  for (const k of Object.keys(buckets)) buckets[k] = round(buckets[k], 0)
  return buckets
}

// Steilste daling (mmol) over ~15 min binnen het venster.
function fastestDrop15m(windowEntries) {
  let worst = 0
  for (let i = 0; i < windowEntries.length; i += 1) {
    const from = windowEntries[i].date - 15 * MS_PER_MIN
    for (let j = i - 1; j >= 0 && windowEntries[j].date >= from; j -= 1) {
      const drop = mmolOf(windowEntries[j]) - mmolOf(windowEntries[i])
      if (drop > worst) worst = drop
    }
  }
  return round(worst, 2)
}

function line(m) {
  return {
    recall: m.recall,
    precision: m.precision,
    leadMin: m.medianLeadTimeMinutes,
    earlyCovered: m.earlyCovered,
    missed: m.missed,
    falsePositive: m.falsePositive,
    predictiveAlerts: m.predictiveAlerts,
  }
}

function buildReport(timeline, days, nowMs) {
  const toMs = nowMs
  const fromMs = nowMs - days * 24 * 60 * MS_PER_MIN
  const windowEntries = timeline.filter((e) => e.date >= fromMs && e.date <= toMs)
  const ctx = buildReplayContext(timeline, { fromMs, toMs })
  const tuned = loadTunedParams()

  const minMmol = windowEntries.length ? round(Math.min(...windowEntries.map(mmolOf)), 2) : null

  return {
    window: { days, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    data: {
      entries: windowEntries.length,
      scoredPoints: ctx.points.length,
      hypoOnsets: ctx.hypoOnsets.length,
      nearHypoOnsets: ctx.nearOnsets.length,
      minMmol,
      fastestDrop15mMmol: fastestDrop15m(windowEntries),
      timeInRangeMinutes: timeInRange(windowEntries),
    },
    detectors: {
      v1: line(evaluateV1(ctx).metrics),
      v2_default: line(evaluateV2(ctx, undefined).metrics),
      v2_tuned: tuned ? line(evaluateV2(ctx, tuned.params).metrics) : null,
    },
    tunedState: tuned ? { trainedAt: tuned.trainedAt, params: tuned.params } : null,
    note:
      ctx.hypoOnsets.length < 3
        ? 'Weinig hypo-events in dit venster: cijfers zijn indicatief.'
        : 'Voldoende events voor een eerste indicatie.',
  }
}

// Per-weekdag profiel over een langere periode (default 28 dagen): laat zien op
// welke weekdagen jouw reactieve hypo's clusteren. `calendarDays` = hoeveel van
// die weekdag in het venster vielen, zodat je "3 van de 4 maandagen" kunt zien.
function buildWeekdayReport(timeline, days, nowMs) {
  const toMs = nowMs
  const fromMs = nowMs - days * 24 * 60 * MS_PER_MIN
  const win = timeline.filter((e) => e.date >= fromMs && e.date <= toMs)
  const ctx = buildReplayContext(timeline, { fromMs, toMs })

  const b = {}
  for (const d of WEEKDAYS) {
    b[d] = { weekday: d, calendarDays: 0, entries: 0, hypoOnsets: 0, nearHypoOnsets: 0, below40Min: 0, below45Min: 0, minMmol: null, fastestDrop15mMmol: 0 }
  }
  const seen = {}

  for (let i = 0; i < win.length; i += 1) {
    const d = weekdayOf(win[i].date)
    const m = mmolOf(win[i])
    b[d].entries += 1
    if (b[d].minMmol === null || m < b[d].minMmol) b[d].minMmol = m
    ;(seen[d] = seen[d] || new Set()).add(caldayOf(win[i].date))
    if (i > 0) {
      const dt = win[i].date - win[i - 1].date
      if (dt > 0 && dt <= GAP_MS) {
        const dp = weekdayOf(win[i - 1].date)
        const mm = mmolOf(win[i - 1])
        const min = dt / MS_PER_MIN
        if (mm < 4.0) b[dp].below40Min += min
        else if (mm < 4.5) b[dp].below45Min += min
      }
    }
    const from = win[i].date - 15 * MS_PER_MIN
    for (let j = i - 1; j >= 0 && win[j].date >= from; j -= 1) {
      const drop = mmolOf(win[j]) - m
      if (drop > b[d].fastestDrop15mMmol) b[d].fastestDrop15mMmol = drop
    }
  }
  for (const o of ctx.hypoOnsets) b[weekdayOf(o.date)].hypoOnsets += 1
  for (const o of ctx.nearOnsets) b[weekdayOf(o.date)].nearHypoOnsets += 1

  for (const d of WEEKDAYS) {
    b[d].calendarDays = seen[d] ? seen[d].size : 0
    b[d].minMmol = round(b[d].minMmol, 2)
    b[d].below40Min = round(b[d].below40Min, 0)
    b[d].below45Min = round(b[d].below45Min, 0)
    b[d].fastestDrop15mMmol = round(b[d].fastestDrop15mMmol, 2)
  }

  return {
    mode: 'weekday',
    tz: TZ,
    window: { days, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    perWeekday: WEEKDAYS.map((d) => b[d]),
    note: 'Per-weekdag profiel — zo zie je of bepaalde dagen riskanter zijn.',
  }
}

function selfTimeline(nowMs) {
  const out = []
  const hypo = [5.2, 6.8, 9.0, 10.0, 8.6, 6.8, 5.2, 4.2, 3.6, 3.5, 3.7, 4.2, 5.0, 5.4]
  const flat = [5.5, 5.5, 5.4, 5.6, 5.5]
  let t = -((hypo.length + flat.length) * 6) * 5
  for (let k = 0; k < 6; k += 1)
    for (const m of [...hypo, ...flat]) {
      out.push({ date: nowMs + t * MS_PER_MIN, sgv: Math.round(m * MGDL_PER_MMOL) })
      t += 5
    }
  return out.sort((a, b) => a.date - b.date)
}

async function main() {
  const byWeekday = process.argv.includes('--by-weekday')
  const days = byWeekday ? (process.argv.includes('--days') ? argDays() : 28) : argDays()
  const selfTest = process.argv.includes('--self-test')
  const nowMs = Date.now()

  let timeline
  let client = null
  if (selfTest) {
    timeline = selfTimeline(nowMs)
  } else {
    const uri = process.env.MONGODB_URI ?? 'mongodb://nightscout-mongo:27017/nightscout'
    client = new MongoClient(uri)
    await client.connect()
    timeline = await client
      .db()
      .collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true } }, { projection: { _id: 0, date: 1, dateString: 1, sgv: 1 } })
      .sort({ date: 1 })
      .toArray()
  }

  try {
    if (byWeekday) {
      const report = buildWeekdayReport(timeline, selfTest ? 7 : days, nowMs)
      console.log(JSON.stringify(report, null, 2))
      if (selfTest) {
        const total = report.perWeekday.reduce((s, d) => s + d.hypoOnsets, 0)
        console.log(`\n${total >= 1 ? 'SELF-TEST OK' : 'SELF-TEST FAIL'}`)
      }
    } else {
      const report = buildReport(timeline, selfTest ? 1 : days, nowMs)
      console.log(JSON.stringify(report, null, 2))
      if (selfTest) console.log(`\n${report.data.hypoOnsets >= 1 ? 'SELF-TEST OK' : 'SELF-TEST FAIL'}`)
    }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error(`[report] mislukt: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
