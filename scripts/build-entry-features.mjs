var RATE_WINDOWS = ['3m', '5m', '10m', '15m', '20m', '30m', '45m', '60m', '90m', '120m']
var MS_PER_MIN = 60000

function mmol(entry) {
  return Number(entry.sgv) / 18.0182
}

function safeRate(entry, key) {
  var node = entry && entry.glucoseRateMmolPerMin && entry.glucoseRateMmolPerMin[key]
  if (!node || typeof node.rate !== 'number') return null
  return node.rate
}

function round(v, d) {
  var f = Math.pow(10, d)
  return Math.round(v * f) / f
}

function avg(values) {
  var nums = values.filter(function (x) { return Number.isFinite(x) })
  if (!nums.length) return null
  return nums.reduce(function (a, b) { return a + b }, 0) / nums.length
}

function baselineAt(timeline, idx, minutesBack) {
  var target = timeline[idx].date - minutesBack * MS_PER_MIN
  var best = null
  var bestDiff = Infinity
  for (var i = idx - 1; i >= 0; i -= 1) {
    var diff = Math.abs(timeline[i].date - target)
    if (diff < bestDiff) {
      best = timeline[i]
      bestDiff = diff
    }
    if (timeline[i].date < target - 45000) break
  }
  return best
}

function findLocalPeak(timeline, idx, lookbackMinutes) {
  var minDate = timeline[idx].date - lookbackMinutes * MS_PER_MIN
  var peak = timeline[idx]
  for (var i = idx; i >= 0; i -= 1) {
    if (timeline[i].date < minDate) break
    if (timeline[i].sgv > peak.sgv) peak = timeline[i]
  }
  return peak
}

var entries = db.entries.find(
  { type: 'sgv' },
  { _id: 1, identifier: 1, date: 1, dateString: 1, sgv: 1, glucoseRateMmolPerMin: 1 }
).sort({ date: 1 }).toArray()

var bulk = db.entry_features.initializeUnorderedBulkOp()
var touched = 0

for (var i = 0; i < entries.length; i += 1) {
  var e = entries[i]
  var current = mmol(e)
  if (!Number.isFinite(current)) continue

  var b30 = baselineAt(entries, i, 30)
  var b60 = baselineAt(entries, i, 60)
  var b120 = baselineAt(entries, i, 120)

  var peak = findLocalPeak(entries, i, 120)
  var peakMmol = mmol(peak)
  var dropFromPeak = peakMmol - current
  var dropPercent = peakMmol > 0 ? (dropFromPeak / peakMmol) * 100 : 0

  var rates = {}
  for (var j = 0; j < RATE_WINDOWS.length; j += 1) {
    var key = RATE_WINDOWS[j]
    rates[key] = e.glucoseRateMmolPerMin && e.glucoseRateMmolPerMin[key]
      ? e.glucoseRateMmolPerMin[key]
      : null
  }

  var r5 = safeRate(e, '5m')
  var r10 = safeRate(e, '10m')
  var r15 = safeRate(e, '15m')
  var r20 = safeRate(e, '20m')

  var turnaroundDetected = Number.isFinite(r5) && Number.isFinite(r15) && r15 > 0.02 && r5 < -0.02

  var vector = {
    mmol: round(current, 3),
    rate_5m: r5,
    rate_10m: r10,
    rate_15m: r15,
    rate_20m: r20,
    dropFromPeak: round(dropFromPeak, 3),
    dropPercentFromPeak: round(dropPercent, 2),
    minutesSinceLocalPeak: round((e.date - peak.date) / MS_PER_MIN, 2),
    riseFromBaseline30m: b30 ? round(current - mmol(b30), 3) : null,
  }

  bulk.find({ entryId: e._id }).upsert().updateOne({
    $set: {
      entryId: e._id,
      entryIdentifier: e.identifier || null,
      date: e.dateString || new Date(e.date).toISOString(),
      mmol: round(current, 3),
      rawRates: rates,
      baseline_30m: b30 ? round(mmol(b30), 3) : null,
      baseline_60m: b60 ? round(mmol(b60), 3) : null,
      baseline_120m: b120 ? round(mmol(b120), 3) : null,
      localPeakMmol: round(peakMmol, 3),
      localPeakDate: peak.dateString || new Date(peak.date).toISOString(),
      minutesSinceLocalPeak: round((e.date - peak.date) / MS_PER_MIN, 2),
      dropFromPeakMmol: round(dropFromPeak, 3),
      dropFromPeakPercent: round(dropPercent, 2),
      turnaroundDetected: Boolean(turnaroundDetected),
      featureVector: vector,
      featureVersion: 'v1-rules',
      updatedAt: new Date().toISOString(),
    },
    $setOnInsert: {
      createdAt: new Date().toISOString(),
    },
  })

  touched += 1
}

if (touched > 0) bulk.execute()

printjson({ scanned: entries.length, upsertedOrUpdated: touched, collection: 'entry_features' })
