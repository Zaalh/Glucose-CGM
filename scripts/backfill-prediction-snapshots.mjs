var MS_PER_MIN = 60000
var MGDL_PER_MMOL = 18.0182

function mmol(entry) { return Number(entry.sgv) / MGDL_PER_MMOL }
function round(v, d) { var f = Math.pow(10, d); return Math.round(v * f) / f }

function rateOver(timeline, idx, minutesBack) {
  var now = timeline[idx]
  var target = now.date - minutesBack * MS_PER_MIN
  for (var i = idx - 1; i >= 0; i -= 1) {
    if (timeline[i].date <= target) {
      var dt = (now.date - timeline[i].date) / MS_PER_MIN
      if (dt <= 0) return null
      return (mmol(now) - mmol(timeline[i])) / dt
    }
  }
  return null
}

function evaluateRisk(input) {
  var score = 0
  var reasons = []
  if (input.peakMmol >= 10 && input.minutesSincePeak <= 30) { score += 3; reasons.push('Recente piek >10') }
  if (input.dropFromPeakMmol >= 3) { score += 3; reasons.push('Drop vanaf piek >=3.0') }
  else if (input.dropFromPeakMmol >= 2) { score += 2; reasons.push('Drop vanaf piek >=2.0') }
  if (input.dropFromPeakPercent >= 30) { score += 3; reasons.push('Piekdaling >=30%') }
  else if (input.dropFromPeakPercent >= 25) { score += 2; reasons.push('Piekdaling >=25%') }
  if ((input.rate5m || 0) <= -0.08 || (input.rate10m || 0) <= -0.08) { score += 3; reasons.push('Zeer snelle daling') }
  if ((input.rate15m || 0) <= -0.04) { score += 2; reasons.push('Daling 15m') }
  if (input.currentMmol < 4.0) { score += 100; reasons.push('Actueel <4.0') }
  else if (input.currentMmol < 4.5) { score += 4; reasons.push('Actueel <4.5') }

  var risk = score >= 7 ? 'urgent' : score >= 5 ? 'high' : score >= 3 ? 'watch' : 'low'
  return { score: score, risk: risk, reasons: reasons }
}

var entries = db.entries.find({ type: 'sgv' }, { _id: 1, identifier: 1, date: 1, dateString: 1, sgv: 1 }).sort({ date: 1 }).toArray()
var bulk = db.prediction_snapshots.initializeUnorderedBulkOp()
var inserted = 0

for (var i = 30; i < entries.length; i += 1) {
  var e = entries[i]
  var windowStart = e.date - 120 * MS_PER_MIN
  var peak = e
  for (var j = i; j >= 0; j -= 1) {
    if (entries[j].date < windowStart) break
    if (entries[j].sgv > peak.sgv) peak = entries[j]
  }

  var current = mmol(e)
  var peakM = mmol(peak)
  var drop = peakM - current
  var dropPct = peakM > 0 ? (drop / peakM) * 100 : 0
  var minsSincePeak = (e.date - peak.date) / MS_PER_MIN

  var risk = evaluateRisk({
    currentMmol: current,
    rate5m: rateOver(entries, i, 5),
    rate10m: rateOver(entries, i, 10),
    rate15m: rateOver(entries, i, 15),
    peakMmol: peakM,
    minutesSincePeak: minsSincePeak,
    dropFromPeakMmol: drop,
    dropFromPeakPercent: dropPct,
  })

  bulk.insert({
    createdAt: e.dateString || new Date(e.date).toISOString(),
    entryId: e._id,
    entryIdentifier: e.identifier || null,
    currentMmol: round(current, 3),
    risk: risk.risk,
    riskScore: risk.score,
    reasons: risk.reasons,
    modelVersion: 'rules-v1',
    outcomeEvaluated: false,
  })
  inserted += 1
}

if (inserted > 0) bulk.execute()
printjson({ scanned: entries.length, inserted: inserted, collection: 'prediction_snapshots' })
