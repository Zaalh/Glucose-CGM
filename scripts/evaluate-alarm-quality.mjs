// M2 — event-niveau nulmeting van V1/V2 ZOALS GEDEPLOYED. Gebruikt de werkelijke
// alarmbeslissingen uit prediction_snapshots + de echte glucose-timeline, en scoort
// op EVENT-niveau (klinisch hypo-event <3.9 ≥15m, alarm-events geconsolideerd).
// Antwoordt de M2-vraag: is de vals-alarm-last (per dag) een probleem?
//
// Alleen-lezen. npm run alarm:quality (echte data) / alarm:check (self-test).

import { MongoClient } from 'mongodb'
import { findHypoEvents, consolidateAlarms, scoreEvents, MS_PER_DAY } from './lib/eval-metrics.mjs'

const ALARM = new Set(['high', 'urgent'])

function evaluateSeries(series, hypoEvents, windowMs) {
  const observedDays = windowMs > 0 ? windowMs / MS_PER_DAY : null
  const alarmEvents = consolidateAlarms(series, { mergeGapMin: 15 })
  return scoreEvents(alarmEvents, hypoEvents, { horizonMin: 30, observedDays })
}

export function analyze(timeline, snapshots) {
  // V2-actieve, op tijd gesorteerde beslissingen (legacyRisk != null => V2 primair,
  // V1 in legacyRisk). Zo vergelijken we V1 en V2 op exact hetzelfde venster.
  const dec = snapshots
    .filter((s) => s.legacyRisk != null && s.createdAt)
    .map((s) => ({ ms: Date.parse(s.createdAt), v1: ALARM.has(s.legacyRisk), v2: ALARM.has(s.risk) }))
    .filter((d) => Number.isFinite(d.ms))
    .sort((a, b) => a.ms - b.ms)
  if (dec.length < 2) return null
  const startMs = dec[0].ms
  const endMs = dec[dec.length - 1].ms
  const windowMs = endMs - startMs
  const hypoEvents = findHypoEvents(timeline).filter((e) => e.onsetMs >= startMs && e.onsetMs <= endMs)
  return {
    windowDays: Math.round((windowMs / MS_PER_DAY) * 10) / 10,
    decisions: dec.length,
    hypoEvents: hypoEvents.length,
    V1: evaluateSeries(dec.map((d) => ({ ms: d.ms, alarm: d.v1 })), hypoEvents, windowMs),
    V2: evaluateSeries(dec.map((d) => ({ ms: d.ms, alarm: d.v2 })), hypoEvents, windowMs),
  }
}

function syntheticData() {
  // 2 dagen, twee echte hypo-dalingen; V2 vuurt iets gerichter dan V1.
  const timeline = []
  let t = Date.UTC(2026, 0, 1, 0, 0, 0)
  const snaps = []
  for (let day = 0; day < 2; day += 1) {
    for (let min = 0; min < 1440; min += 1) {
      // baseline 6, twee dalingen rond min 300 en 800
      let v = 6
      const near = (m) => Math.abs(min - m)
      if (near(300) < 25) v = 3.5 + Math.abs(near(300)) * 0.02
      else if (near(800) < 25) v = 3.4 + Math.abs(near(800)) * 0.02
      timeline.push({ date: t, sgv: Math.round(v * 18.0182) })
      // V2 waarschuwt vroeg (start ~10m vóór de daling), V1 idem maar met extra ruis.
      const declining = (min > 270 && min < 305) || (min > 770 && min < 805)
      const v1Noise = min % 17 === 0 // V1 wat ruisiger
      snaps.push({
        createdAt: new Date(t).toISOString(),
        legacyRisk: declining || v1Noise ? 'high' : 'low',
        risk: declining ? 'high' : 'low',
      })
      t += 60_000
    }
  }
  return { timeline, snaps }
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const { timeline, snaps } = syntheticData()
    const res = analyze(timeline, snaps)
    console.log(JSON.stringify(res, null, 2))
    // V2 moet de dalingen vangen, en minder vals alarmeren dan de ruisige V1.
    const ok = res && res.hypoEvents >= 2 && res.V2.recall === 1 &&
      res.V2.falseAlarmsPerDay < res.V1.falseAlarmsPerDay && res.V2.medianLeadMin !== null
    console.log(`\n${ok ? 'SELF-TEST OK' : 'SELF-TEST FAIL'}`)
    process.exit(ok ? 0 : 1)
  }

  const uri = process.env.MONGODB_URI ?? 'mongodb://nightscout-mongo:27017/nightscout'
  const client = new MongoClient(uri)
  await client.connect()
  try {
    const entries = await client.db().collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true } }, { projection: { _id: 0, date: 1, sgv: 1 } })
      .sort({ date: 1 }).toArray()
    const timeline = entries.map((e) => ({ date: Number(e.date), sgv: Number(e.sgv) }))
    const snapshots = await client.db().collection('prediction_snapshots')
      .find({ legacyRisk: { $ne: null } }, { projection: { _id: 0, createdAt: 1, risk: 1, legacyRisk: 1 } })
      .sort({ createdAt: 1 }).toArray()
    console.log(`entries=${timeline.length} | V2-actieve snapshots=${snapshots.length}\n`)
    const res = analyze(timeline, snapshots)
    if (!res) { console.log('Te weinig V2-actieve beslissingen.'); return }
    console.log(JSON.stringify(res, null, 2))
    console.log('\n--- duiding (event-niveau, zoals gedeployed) ---')
    console.log(`venster ${res.windowDays} dagen | ${res.hypoEvents} echte hypo-events (<3.9, >=15m)`)
    for (const k of ['V1', 'V2']) {
      const m = res[k]
      console.log(`  ${k}: recall=${m.recall} (${m.detectedHypos}/${m.hypoEvents}) | precisie=${m.precision} | vals-alarm/dag=${m.falseAlarmsPerDay} | alarm-events=${m.alarmEvents} | mediaan lead=${m.medianLeadMin}m`)
    }
    console.log('\nM2-beslispunt: is vals-alarm/dag te hoog? Zo ja -> M3 (drempel op vals-alarm-budget).')
  } finally {
    await client.close()
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
