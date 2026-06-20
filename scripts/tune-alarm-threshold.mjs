// M3 — zoek per detector (V1, V2) de score-drempel die de event-niveau RECALL
// maximaliseert binnen een VALS-ALARM-BUDGET (events/dag). Beantwoordt: hoeveel
// recall/lead houden we over als we de alarmlast terugbrengen naar bv. <=3/dag?
//
// Scores worden met de HUIDIGE code herberekend op de timeline (consistente schaal;
// de opgeslagen snapshot-scores mengen modelversies). V2 met DEFAULT_PARAMS, zonder
// pattern (eerder verwaarloosbaar). Alleen-lezen.
// npm run alarm:tune (echte data) / alarm:tune-check (self-test).

import { MongoClient } from 'mongodb'
import { buildHypoFeatures } from './lib/hypo-features.mjs'
import { evaluateRiskRuleV1 } from './lib/legacy-risk-v1.mjs'
import { evaluateReactiveHypoRiskV2 } from './lib/reactive-hypo-detector.mjs'
import { findHypoEvents, consolidateAlarms, scoreEvents, MS_PER_DAY, round } from './lib/eval-metrics.mjs'

const BUDGETS = [1, 2, 3, 5] // doel vals-alarmen per dag

// Bouw één keer de score-reeksen + hypo-events.
function buildSeries(timeline) {
  const v1 = []
  const v2 = []
  for (let idx = 12; idx < timeline.length; idx += 1) {
    let f
    try { f = buildHypoFeatures(timeline, idx, { nowMs: timeline[idx].date, cleanTimeline: false }) } catch { continue }
    if (!f || !Number.isFinite(f.currentMmol)) continue
    const r1 = evaluateRiskRuleV1({
      currentMmol: f.currentMmol, rate5m: f.rate5m, rate10m: f.rate10m, rate15m: f.rate15m,
      peakMmol: f.peakMmol120m, minutesSincePeak: f.minutesSincePeak,
      dropFromPeakMmol: f.dropFromPeakMmol, dropFromPeakPercent: f.dropFromPeakPercent,
    })
    const r2 = evaluateReactiveHypoRiskV2(f, {})
    const ms = timeline[idx].date
    v1.push({ ms, score: Number.isFinite(r1?.score) ? r1.score : 0 })
    v2.push({ ms, score: Number.isFinite(r2?.score) ? r2.score : 0 })
  }
  return { v1, v2 }
}

function sweep(series, hypoEvents, observedDays) {
  const scores = [...new Set(series.map((s) => s.score))].sort((a, b) => a - b)
  // kandidaat-drempels: alle unieke scores (alarm als score >= thr)
  const curve = []
  for (const thr of scores) {
    const alarms = consolidateAlarms(series.map((s) => ({ ms: s.ms, alarm: s.score >= thr })), { mergeGapMin: 15 })
    const m = scoreEvents(alarms, hypoEvents, { horizonMin: 30, observedDays })
    curve.push({ thr, recall: m.recall, falseAlarmsPerDay: m.falseAlarmsPerDay, medianLeadMin: m.medianLeadMin, alarmEvents: m.alarmEvents })
  }
  // beste (hoogste recall, dan hoogste lead) binnen elk budget
  const perBudget = {}
  for (const budget of BUDGETS) {
    const feasible = curve.filter((c) => c.falseAlarmsPerDay !== null && c.falseAlarmsPerDay <= budget)
    feasible.sort((a, b) => (b.recall - a.recall) || ((b.medianLeadMin || 0) - (a.medianLeadMin || 0)) || (a.thr - b.thr))
    perBudget[`budget_${budget}_per_day`] = feasible.length
      ? { thr: round(feasible[0].thr, 2), recall: feasible[0].recall, falseAlarmsPerDay: feasible[0].falseAlarmsPerDay, medianLeadMin: feasible[0].medianLeadMin }
      : null
  }
  // referentie: laagste drempel (= huidig "altijd alarmeren bij score>0"-achtig)
  const maxRecall = curve.reduce((b, c) => ((c.recall || 0) > (b.recall || 0) ? c : b), curve[0])
  return { perBudget, maxRecallPoint: maxRecall ? { thr: round(maxRecall.thr, 2), recall: maxRecall.recall, falseAlarmsPerDay: maxRecall.falseAlarmsPerDay, medianLeadMin: maxRecall.medianLeadMin } : null }
}

export function analyze(timeline) {
  const { v1, v2 } = buildSeries(timeline)
  const hypoEvents = findHypoEvents(timeline)
  const span = timeline.length ? timeline[timeline.length - 1].date - timeline[0].date : 0
  const observedDays = span / MS_PER_DAY
  return {
    windowDays: round(observedDays, 1), hypoEvents: hypoEvents.length,
    V1: sweep(v1, hypoEvents, observedDays),
    V2: sweep(v2, hypoEvents, observedDays),
  }
}

function syntheticTimeline() {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
  const readings = []
  for (let day = 0; day < 4; day += 1) {
    for (let min = 0; min < 1440; min += 1) {
      let v = 6
      const d1 = Math.abs(min - 300), d2 = Math.abs(min - 900)
      if (d1 < 25) v = 3.4 + d1 * 0.02
      else if (d2 < 25) v = 3.4 + d2 * 0.02
      readings.push({ date: t0 + (day * 1440 + min) * 60_000, sgv: Math.round(v * 18.0182) })
    }
  }
  return readings
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const res = analyze(syntheticTimeline())
    console.log(JSON.stringify(res, null, 2))
    const ok = res.hypoEvents >= 4 && res.V1.maxRecallPoint && res.V2.perBudget.budget_3_per_day !== undefined
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
    console.log('\n--- duiding (drempel op vals-alarm-budget) ---')
    console.log(`venster ${res.windowDays} dagen | ${res.hypoEvents} echte hypo-events`)
    for (const k of ['V1', 'V2']) {
      const r = res[k]
      console.log(`${k}: max-recall ${r.maxRecallPoint.recall} bij ${r.maxRecallPoint.falseAlarmsPerDay}/dag (drempel ${r.maxRecallPoint.thr})`)
      for (const b of BUDGETS) {
        const p = r.perBudget[`budget_${b}_per_day`]
        console.log(`   <=${b}/dag: ${p ? `recall=${p.recall} lead=${p.medianLeadMin}m drempel=${p.thr}` : 'niet haalbaar'}`)
      }
    }
  } finally { await client.close() }
}
main().catch((err) => { console.error(err); process.exit(1) })
