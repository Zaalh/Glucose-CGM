// Vergelijkt V1 en V2 ZOALS WERKELIJK GEDEPLOYED, uit prediction_snapshots — dus met
// de getunede live-params en de echte alarmbeslissingen die de gebruiker zag (geen
// recompute-caveats). Antwoordt: is V2 (live primaire alarmbron) écht beter dan V1?
//
// Per snapshot (V2 actief => legacyRisk != null): V2-alarm = risk in {high,urgent} (primair),
// V1-alarm = legacyRisk in {high,urgent}. Werkelijke uitkomst = actualMinMmol_30m < 3.9.
// Ranking-AUC uit shadowScore (V2) vs legacyScore (V1) op dezelfde subset.
//
// Alleen-lezen. npm run v1v2:deployed (echte data) / v1v2:check (self-test).
// Offline rook-test: node scripts/compare-v1-v2-deployed.mjs --self-test

import { MongoClient } from 'mongodb'

const HYPO_MMOL = 3.9
const ALARM = new Set(['high', 'urgent'])
const round = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000)

function confusion(rows, decideFn) {
  let tp = 0, fp = 0, fn = 0, tn = 0
  for (const r of rows) {
    const alarm = decideFn(r)
    if (r.actualHypo && alarm) tp += 1
    else if (!r.actualHypo && alarm) fp += 1
    else if (r.actualHypo && !alarm) fn += 1
    else tn += 1
  }
  const recall = tp + fn > 0 ? tp / (tp + fn) : null
  const precision = tp + fp > 0 ? tp / (tp + fp) : null
  const specificity = tn + fp > 0 ? tn / (tn + fp) : null
  const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : null
  return {
    tp, fp, fn, tn,
    alarmRate: round((tp + fp) / (rows.length || 1)),
    recall: round(recall), precision: round(precision), specificity: round(specificity),
    falseAlarmRate: round(tn + fp > 0 ? fp / (tn + fp) : null), f1: round(f1),
  }
}
function rocAuc(rows, scoreFn) {
  const scored = rows.map((r) => ({ p: scoreFn(r), y: r.actualHypo ? 1 : 0 })).filter((s) => Number.isFinite(s.p))
  const pos = scored.filter((s) => s.y === 1).length, neg = scored.length - pos
  if (!pos || !neg) return null
  const sorted = scored.slice().sort((a, b) => a.p - b.p)
  let rs = 0
  for (let i = 0; i < sorted.length; ) {
    let j = i; while (j < sorted.length && sorted[j].p === sorted[i].p) j += 1
    const ar = (i + 1 + j) / 2
    for (let k = i; k < j; k += 1) if (sorted[k].y === 1) rs += ar
    i = j
  }
  return round((rs - (pos * (pos + 1)) / 2) / (pos * neg))
}

function analyze(rows) {
  const v1 = { ...confusion(rows, (r) => ALARM.has(r.legacyRisk)), rocAuc: rocAuc(rows, (r) => r.legacyScore) }
  const v2 = { ...confusion(rows, (r) => ALARM.has(r.risk)), rocAuc: rocAuc(rows, (r) => r.shadowScore ?? r.riskScore) }
  const actualPos = rows.filter((r) => r.actualHypo).length
  return { n: rows.length, actualHypo: actualPos, baseRate: round(actualPos / (rows.length || 1)), V1: v1, V2: v2 }
}

async function main() {
  if (process.argv.includes('--self-test')) {
    // synthetische snapshots: V2 net iets agressiever (meer recall, meer FP) dan V1
    const rows = []
    for (let i = 0; i < 200; i += 1) {
      const hypo = i % 5 === 0
      rows.push({
        actualHypo: hypo,
        legacyRisk: hypo ? (i % 2 ? 'high' : 'low') : (i % 13 === 0 ? 'high' : 'low'),
        risk: hypo ? 'high' : (i % 7 === 0 ? 'high' : 'low'),
        legacyScore: hypo ? 6 + (i % 3) : i % 4,
        shadowScore: hypo ? 7 + (i % 3) : i % 5,
      })
    }
    const res = analyze(rows)
    console.log(JSON.stringify(res, null, 2))
    const ok = res.n === 200 && res.V1.rocAuc !== null && res.V2.rocAuc !== null && res.V2.recall !== null
    console.log(`\n${ok ? 'SELF-TEST OK' : 'SELF-TEST FAIL'}`)
    process.exit(ok ? 0 : 1)
  }

  const uri = process.env.MONGODB_URI ?? 'mongodb://nightscout-mongo:27017/nightscout'
  const client = new MongoClient(uri)
  await client.connect()
  try {
    const all = await client.db().collection('prediction_snapshots')
      .find(
        { outcomeEvaluated: true, legacyRisk: { $ne: null }, actualMinMmol_30m: { $ne: null } },
        { projection: { _id: 0, createdAt: 1, risk: 1, riskScore: 1, legacyRisk: 1, legacyScore: 1, shadowScore: 1, actualMinMmol_30m: 1 } },
      )
      .sort({ createdAt: 1 })
      .toArray()
    const rows = all
      .filter((r) => Number.isFinite(r.actualMinMmol_30m))
      .map((r) => ({ ...r, actualHypo: r.actualMinMmol_30m < HYPO_MMOL }))
    if (!rows.length) { console.log('Geen V2-actieve, geëvalueerde snapshots gevonden.'); return }

    // recent venster: laatste 30 dagen (huidige getunede V2)
    const cutoff = Date.parse(rows[rows.length - 1].createdAt) - 30 * 86_400_000
    const recent = rows.filter((r) => Date.parse(r.createdAt) >= cutoff)

    const res = { allEvaluated: analyze(rows), last30Days: analyze(recent) }
    console.log(JSON.stringify(res, null, 2))
    console.log('\n--- duiding (V2 live primair vs V1, zoals gedeployed) ---')
    for (const key of ['allEvaluated', 'last30Days']) {
      const r = res[key]
      console.log(`[${key}] n=${r.n} echte-hypo=${r.actualHypo} base-rate=${r.baseRate}`)
      console.log(`  V1: recall=${r.V1.recall} precision=${r.V1.precision} F1=${r.V1.f1} vals-alarm=${r.V1.falseAlarmRate} alarmrate=${r.V1.alarmRate} ROC=${r.V1.rocAuc}`)
      console.log(`  V2: recall=${r.V2.recall} precision=${r.V2.precision} F1=${r.V2.f1} vals-alarm=${r.V2.falseAlarmRate} alarmrate=${r.V2.alarmRate} ROC=${r.V2.rocAuc}`)
    }
    console.log('\nNB: alarm = risk in {high,urgent}; uitkomst = actualMinMmol_30m < 3.9 (zoals opgeslagen, 30m, niet sustained).')
  } finally {
    await client.close()
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
