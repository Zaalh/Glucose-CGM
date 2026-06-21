// BETER ONDERZOEK — kan CONTEXT (uit CGM zelf afgeleid, geen handmatige invoer) de
// harde M3-frontier doorbreken? Idee: hypo's clusteren postprandiaal en/of op bepaalde
// tijden. Een context-GATED alarm is dan gevoeliger waar de kans hoog is (postprandiaal)
// en minder gevoelig op de rustige baseline → minder valse alarmen bij gelijke recall.
//
// Postprandiale proxy uit bestaande features (parity, goedkoop): riseFromBaseline >=
// RISE_MMOL én minutesSincePeak <= POST_MIN (recente maaltijdpiek). Tijd-van-dag erbij.
// V2-score herberekend (DEFAULT_PARAMS, geen pattern — relatief vergelijk, beide armen
// zelfde params). Alleen-lezen. npm run alarm:context / alarm:context-check.

import { MongoClient } from 'mongodb'
import { buildHypoFeatures } from './lib/hypo-features.mjs'
import { evaluateReactiveHypoRiskV2 } from './lib/reactive-hypo-detector.mjs'
import { findHypoEvents, consolidateAlarms, scoreEvents, MS_PER_DAY, round } from './lib/eval-metrics.mjs'

const MS_PER_MIN = 60_000
const RISE_MMOL = 1.5 // maaltijd-grootte stijging
const POST_MIN = 90 // postprandiaal venster na de piek
const TZ_OFFSET_H = 2

function buildSeries(timeline) {
  const out = []
  for (let idx = 12; idx < timeline.length; idx += 1) {
    let f
    try { f = buildHypoFeatures(timeline, idx, { nowMs: timeline[idx].date, cleanTimeline: false }) } catch { continue }
    if (!f || !Number.isFinite(f.currentMmol)) continue
    const r = evaluateReactiveHypoRiskV2(f, {})
    const rise = Number.isFinite(f.riseFromBaseline) ? f.riseFromBaseline : 0
    const msp = Number.isFinite(f.minutesSincePeak) ? f.minutesSincePeak : 999
    const postprandial = rise >= RISE_MMOL && msp >= 0 && msp <= POST_MIN
    const hour = Math.floor(((timeline[idx].date / 3_600_000) + TZ_OFFSET_H) % 24)
    out.push({ ms: timeline[idx].date, score: Number.isFinite(r?.score) ? r.score : 0, postprandial, hour })
  }
  return out
}

function evalScheme(series, hypoEvents, observedDays, decide) {
  const alarms = consolidateAlarms(series.map((s) => ({ ms: s.ms, alarm: decide(s) })), { mergeGapMin: 15 })
  return scoreEvents(alarms, hypoEvents, { horizonMin: 30, observedDays })
}

// candidate-drempels: ~20 quantielen van de score-verdeling
function candidates(series) {
  const scores = series.map((s) => s.score).sort((a, b) => a - b)
  const out = new Set()
  for (let q = 0; q <= 20; q += 1) out.add(scores[Math.min(scores.length - 1, Math.floor((q / 20) * scores.length))])
  return [...out].sort((a, b) => a - b)
}

// minimale vals-alarm/dag bij recall >= target, voor een schema-familie
function bestAtRecall(series, hypoEvents, observedDays, schemes, target) {
  let best = null
  for (const s of schemes) {
    const m = evalScheme(series, hypoEvents, observedDays, s.decide)
    if (m.recall !== null && m.recall >= target) {
      if (!best || m.falseAlarmsPerDay < best.falseAlarmsPerDay) best = { ...m, label: s.label }
    }
  }
  return best
}

export function analyze(timeline) {
  const series = buildSeries(timeline)
  const hypoEvents = findHypoEvents(timeline)
  const observedDays = (timeline[timeline.length - 1].date - timeline[0].date) / MS_PER_DAY
  const cand = candidates(series)

  // descriptief: clustert hypo postprandiaal / per dagdeel? (punt-niveau prevalentie)
  const post = series.filter((s) => s.postprandial)
  const lowMs = new Set()
  for (const h of hypoEvents) lowMs.add(Math.floor(h.onsetMs / MS_PER_MIN))
  const fracPostprandial = round(post.length / (series.length || 1))

  // GLOBAL: één drempel
  const globalSchemes = cand.map((t) => ({ label: `global>=${t}`, decide: (s) => s.score >= t }))
  // GATED: postprandiaal gevoeliger (lo), baseline strenger (hi). lo <= hi.
  const gatedSchemes = []
  for (const hi of cand) for (const lo of cand) {
    if (lo > hi) continue
    gatedSchemes.push({ label: `gated lo=${lo}|hi=${hi}`, decide: (s) => (s.postprandial ? s.score >= lo : s.score >= hi) })
  }

  const out = { windowDays: round(observedDays, 1), hypoEvents: hypoEvents.length, fracPostprandialPoints: fracPostprandial, targets: {} }
  for (const target of [0.95, 0.85, 0.7]) {
    const g = bestAtRecall(series, hypoEvents, observedDays, globalSchemes, target)
    const gx = bestAtRecall(series, hypoEvents, observedDays, gatedSchemes, target)
    out.targets[`recall_${target}`] = {
      global: g && { falseAlarmsPerDay: g.falseAlarmsPerDay, medianLeadMin: g.medianLeadMin, recall: g.recall },
      gated: gx && { falseAlarmsPerDay: gx.falseAlarmsPerDay, medianLeadMin: gx.medianLeadMin, recall: gx.recall, label: gx.label },
      improvement: g && gx ? round(g.falseAlarmsPerDay - gx.falseAlarmsPerDay, 2) : null,
    }
  }
  return out
}

function syntheticTimeline() {
  // hypo's UITSLUITEND postprandiaal (na een stijging) -> context-gating moet helpen
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
  const r = []
  for (let day = 0; day < 8; day += 1) for (let min = 0; min < 1440; min += 1) {
    let v = 5.5
    const meal = min - 200
    if (meal >= 0 && meal < 60) v = 5.5 + meal * 0.07 // stijging naar piek 9.7
    else if (meal >= 60 && meal < 100) v = 9.7 - (meal - 60) * 0.155 // reactieve daling -> ~3.5
    else if (meal >= 100 && meal < 125) v = 3.5 // aanhoudende hypo (>=15m sustained)
    else if (meal >= 125 && meal < 145) v = 3.5 + (meal - 125) * 0.1 // herstel
    r.push({ date: t0 + (day * 1440 + min) * 60_000, sgv: Math.round(v * 18.0182) })
  }
  return r
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const res = analyze(syntheticTimeline())
    console.log(JSON.stringify(res, null, 2))
    const r85 = res.targets['recall_0.85']
    const ok = res.hypoEvents >= 4 && r85 && r85.global && r85.gated
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
    console.log('\n--- duiding (context-gated vs global) ---')
    console.log(`venster ${res.windowDays}d | ${res.hypoEvents} events | ${Math.round(res.fracPostprandialPoints * 100)}% punten postprandiaal`)
    for (const t of ['recall_0.95', 'recall_0.85', 'recall_0.7']) {
      const r = res.targets[t]
      if (!r.global || !r.gated) { console.log(`${t}: niet haalbaar`); continue }
      console.log(`${t}: GLOBAL ${r.global.falseAlarmsPerDay}/dag (lead ${r.global.medianLeadMin}m) vs GATED ${r.gated.falseAlarmsPerDay}/dag (lead ${r.gated.medianLeadMin}m) -> winst ${r.improvement}/dag`)
    }
  } finally { await client.close() }
}
main().catch((err) => { console.error(err); process.exit(1) })
