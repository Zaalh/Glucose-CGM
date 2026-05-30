var MS_PER_MIN = 60000
var MGDL_PER_MMOL = 18.0182
function mmol(entry) { return Number(entry.sgv) / MGDL_PER_MMOL }

var entries = db.entries.find({ type: 'sgv' }, { _id: 1, date: 1, sgv: 1 }).sort({ date: 1 }).toArray()
var byId = {}
for (var i = 0; i < entries.length; i += 1) byId[String(entries[i]._id)] = entries[i]

var snaps = db.prediction_snapshots.find({ outcomeEvaluated: { $ne: true } }).toArray()
var updated = 0

for (var s = 0; s < snaps.length; s += 1) {
  var snap = snaps[s]
  var entry = byId[String(snap.entryId)]
  if (!entry) continue

  var t30 = entry.date + 30 * MS_PER_MIN
  var t60 = entry.date + 60 * MS_PER_MIN
  var t120 = entry.date + 120 * MS_PER_MIN
  var t180 = entry.date + 180 * MS_PER_MIN
  var min30 = Infinity
  var min60 = Infinity
  var min120 = Infinity
  var min180 = Infinity

  for (var i2 = 0; i2 < entries.length; i2 += 1) {
    var t = entries[i2].date
    if (t <= entry.date) continue
    if (t <= t30) min30 = Math.min(min30, mmol(entries[i2]))
    if (t <= t60) min60 = Math.min(min60, mmol(entries[i2]))
    if (t <= t120) min120 = Math.min(min120, mmol(entries[i2]))
    if (t <= t180) min180 = Math.min(min180, mmol(entries[i2]))
    if (t > t180) break
  }

  var hyp30 = min30 < 4.0
  var near30 = min30 < 4.5
  var predicted = snap.risk === 'high' || snap.risk === 'urgent' || snap.risk === 'watch'
  var result = predicted && near30 ? 'true_positive' : predicted && !near30 ? 'false_positive' : !predicted && near30 ? 'false_negative' : 'true_negative'

  db.prediction_snapshots.updateOne({ _id: snap._id }, {
    $set: {
      actualMinMmol_30m: Number.isFinite(min30) ? Math.round(min30 * 1000) / 1000 : null,
      actualMinMmol_60m: Number.isFinite(min60) ? Math.round(min60 * 1000) / 1000 : null,
      actualMinMmol_120m: Number.isFinite(min120) ? Math.round(min120 * 1000) / 1000 : null,
      actualMinMmol_180m: Number.isFinite(min180) ? Math.round(min180 * 1000) / 1000 : null,
      actualHypoWithin_30m: hyp30,
      actualNearHypoWithin_30m: near30,
      actualHypoWithin_60m: min60 < 4.0,
      actualNearHypoWithin_60m: min60 < 4.5,
      actualHypoWithin_180m: min180 < 4.0,
      actualNearHypoWithin_180m: min180 < 4.5,
      result: result,
      outcomeEvaluated: true,
    }
  })
  updated += 1
}

printjson({ snapshotsScanned: snaps.length, updated: updated, collection: 'prediction_snapshots' })
