// M5 — meet een GEGRADEERD alarm (twee niveaus) vóór we het bouwen. M3 toonde dat
// lead en weinig-valse-alarmen elkaar uitsluiten bij één drempel. Een gegradeerd
// schema benut beide kanten:
//   WATCH  = lage drempel: vroege, zachte "let op" (lange lead, meer vals, niet-indringend)
//   URGENT = hoge drempel: indringend alarm (weinig vals, korte lead)
// Vraag: geeft WATCH zinvolle vroege lead op de meeste events, terwijl URGENT zeldzaam
// blijft? En hoeveel eerder waarschuwt WATCH dan URGENT (de winst van het zachte niveau)?
//
// Scores herberekend met huidige code (V2, DEFAULT_PARAMS, geen pattern). Alleen-lezen.
// npm run alarm:graded / alarm:graded-check.

import { MongoClient } from 'mongodb'
import { buildHypoFeatures } from './lib/hypo-features.mjs'
import { evaluateReactiveHypoRiskV2 } from './lib/reactive-hypo-detector.mjs'
import { findHypoEvents, consolidateAlarms, MS_PER_DAY, round } from './lib/eval-metrics.mjs'

const MS_PER_MIN = 60_000
const HORIZON_MIN = 30
const DETECT_TOL_MIN = 15
const WATCH_BUDGET = 12 // /dag — zacht niveau mag vaker (niet-indringend)
const URGENT_BUDGET = 3 // /dag — indringend niveau moet zeldzaam

function v2Series(timeline) {
  const out = []
  for (let idx = 12; idx < timeline.length; idx += 1) {
    let f
    try { f = buildHypoFeatures(timeline, idx, { nowMs: timeline[idx].date, cleanTimeline: false }) } catch { continue }
    if (!f || !Number.isFinite(f.currentMmol)) continue
    const r = evaluateReactiveHypoRiskV2(f, {})
    out.push({ ms: timeline[idx].date, score: Number.isFinite(r?.score) ? r.score : 0 })
  }
  return out
}

// Per-event: vroegste dekkende alarm-lead bij drempel thr (null = niet gedetecteerd).
function perEventLeads(series, hypoEvents, thr) {
  const alarms = consolidateAlarms(series.map((s) => ({ ms: s.ms, alarm: s.score >= thr })), { mergeGapMin: 15 })
  const horizon = HORIZON_MIN * MS_PER_MIN
  const tol = DETECT_TOL_MIN * MS_PER_MIN
  const leads = hypoEvents.map((h) => {
    let best = null
    for (const ev of alarms) {
      if (ev.endMs >= h.onsetMs - horizon && ev.startMs <= h.onsetMs + tol) {
        const lead = (h.onsetMs - ev.startMs) / MS_PER_MIN
        if (best === null || lead > best) best = lead
      }
    }
    return best === null ? null : Math.max(-DETECT_TOL_MIN, Math.min(best, HORIZON_MIN))
  })
  const detected = leads.filter((l) => l !== null).length
  const falseAlarms = alarms.length - alarms.filter((ev) => hypoEvents.some((h) => ev.endMs >= h.onsetMs - horizon && ev.startMs <= h.onsetMs + tol)).length
  return { leads, detected, alarmEvents: alarms.length, falseAlarms }
}

function median(xs) {
  const a = xs.filter((x) => x !== null).sort((x, y) => x - y)
  return a.length ? Math.round(a[Math.floor(a.length / 2)]) : null
}

// kies drempel: laagste score met vals-alarm/dag <= budget
function thresholdForBudget(series, hypoEvents, observedDays, budget) {
  const scores = [...new Set(series.map((s) => s.score))].sort((a, b) => a - b)
  let chosen = scores[scores.length - 1] ?? 0
  for (const thr of scores) {
    const { falseAlarms } = perEventLeads(series, hypoEvents, thr)
    if (falseAlarms / observedDays <= budget) { chosen = thr; break }
  }
  return chosen
}

export function analyze(timeline) {
  const series = v2Series(timeline)
  const hypoEvents = findHypoEvents(timeline)
  const observedDays = (timeline[timeline.length - 1].date - timeline[0].date) / MS_PER_DAY
  const watchThr = thresholdForBudget(series, hypoEvents, observedDays, WATCH_BUDGET)
  const urgentThr = thresholdForBudget(series, hypoEvents, observedDays, URGENT_BUDGET)
  const watch = perEventLeads(series, hypoEvents, watchThr)
  const urgent = perEventLeads(series, hypoEvents, urgentThr)
  // escalatie-winst: voor events die BEIDE niveaus vangen, hoeveel eerder is WATCH?
  const gains = []
  for (let i = 0; i < hypoEvents.length; i += 1) {
    if (watch.leads[i] !== null && urgent.leads[i] !== null) gains.push(watch.leads[i] - urgent.leads[i])
  }
  const level = (thr, m) => ({
    threshold: round(thr, 2), recall: round(m.detected / (hypoEvents.length || 1)),
    medianLeadMin: median(m.leads), falseAlarmsPerDay: round(m.falseAlarms / observedDays, 2), alarmEvents: m.alarmEvents,
  })
  return {
    windowDays: round(observedDays, 1), hypoEvents: hypoEvents.length,
    WATCH: { budget: WATCH_BUDGET, ...level(watchThr, watch) },
    URGENT: { budget: URGENT_BUDGET, ...level(urgentThr, urgent) },
    escalation: { eventsWithBoth: gains.length, medianExtraLeadMin_watchVsUrgent: median(gains) },
  }
}

function syntheticTimeline() {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
  const r = []
  for (let day = 0; day < 6; day += 1) for (let min = 0; min < 1440; min += 1) {
    let v = 6
    const d1 = Math.abs(min - 300), d2 = Math.abs(min - 900)
    if (d1 < 30) v = 3.4 + d1 * 0.018
    else if (d2 < 30) v = 3.4 + d2 * 0.018
    r.push({ date: t0 + (day * 1440 + min) * 60_000, sgv: Math.round(v * 18.0182) })
  }
  return r
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const res = analyze(syntheticTimeline())
    console.log(JSON.stringify(res, null, 2))
    const ok = res.hypoEvents >= 4 && res.WATCH.recall !== null && res.URGENT.recall !== null &&
      res.WATCH.medianLeadMin !== null
    console.log(`\n${ok ? 'SELF-TEST OK' : 'SELF-TEST FAIL'}`)
    process.exit(ok ? 0 : 1)
  }
  const uri = process.env.MONGODB_URI ?? 'mongodb://nightscout-mongo:27017/nightscout'
  const client = new MongoClient(uri); await client.connect()
  try {
    const entries = await client.db().collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true } }, { projection: { _id: 0, date: 1, sgv: 1 } }).sort({ date: 1 }).toArray()
    const timeline = entries.map((e) => ({ date: Number(e.date), sgv: Number(e.sgv) }))
    console.log(`entries=${timeline.length}\n`)
    const res = analyze(timeline)
    console.log(JSON.stringify(res, null, 2))
    console.log('\n--- duiding (gegradeerd alarm) ---')
    console.log(`venster ${res.windowDays} dagen | ${res.hypoEvents} echte hypo-events`)
    console.log(`WATCH  (≤${res.WATCH.budget}/dag): recall=${res.WATCH.recall} lead=${res.WATCH.medianLeadMin}m vals/dag=${res.WATCH.falseAlarmsPerDay}`)
    console.log(`URGENT (≤${res.URGENT.budget}/dag): recall=${res.URGENT.recall} lead=${res.URGENT.medianLeadMin}m vals/dag=${res.URGENT.falseAlarmsPerDay}`)
    console.log(`Escalatie: ${res.escalation.eventsWithBoth} events met beide; WATCH waarschuwt mediaan ${res.escalation.medianExtraLeadMin_watchVsUrgent}m eerder dan URGENT`)
  } finally { await client.close() }
}
main().catch((err) => { console.error(err); process.exit(1) })
