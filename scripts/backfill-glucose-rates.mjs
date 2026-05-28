var RATE_WINDOWS_MINUTES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 30, 45, 60, 90, 120]
var RATE_MAX_BASELINE_DIFF_MS = 45000
var MGDL_PER_MMOL = 18.0182

function findBaseline(timeline, latestIndex, minutesBack) {
  var latestTime = timeline[latestIndex].date
  var target = latestTime - minutesBack * 60000
  var best = null
  var bestDiff = Infinity

  for (var i = latestIndex - 1; i >= 0; i -= 1) {
    var entry = timeline[i]
    var time = Number(entry.date)
    if (!Number.isFinite(time)) continue

    if (target - time > RATE_MAX_BASELINE_DIFF_MS) break

    var diff = Math.abs(time - target)
    if (diff < bestDiff) {
      best = entry
      bestDiff = diff
    }
  }

  return bestDiff <= RATE_MAX_BASELINE_DIFF_MS ? best : null
}

function round(value, digits) {
  var factor = Math.pow(10, digits)
  return Math.round(value * factor) / factor
}

var entries = db.entries.find(
  { type: 'sgv' },
  { date: 1, dateString: 1, sgv: 1 }
).sort({ date: 1 }).toArray()

var updated = 0

for (var entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
  var entry = entries[entryIndex]
  var rates = {}

  for (var windowIndex = 0; windowIndex < RATE_WINDOWS_MINUTES.length; windowIndex += 1) {
    var minutes = RATE_WINDOWS_MINUTES[windowIndex]
    var baseline = findBaseline(entries, entryIndex, minutes)
    var key = String(minutes) + 'm'

    if (!baseline) {
      rates[key] = null
      continue
    }

    var actualMinutes = (entry.date - baseline.date) / 60000
    if (actualMinutes <= 0) {
      rates[key] = null
      continue
    }

    var deltaMgdl = Number(entry.sgv) - Number(baseline.sgv)
    rates[key] = {
      rate: round((deltaMgdl / MGDL_PER_MMOL) / actualMinutes, 4),
      delta: round(deltaMgdl / MGDL_PER_MMOL, 3),
      actualMinutes: round(actualMinutes, 2),
      baselineDate: baseline.dateString || new Date(baseline.date).toISOString(),
    }
  }

  db.entries.updateOne(
    { _id: entry._id },
    {
      $set: {
        glucoseRate: rates,
        glucoseRateMmolPerMin: rates,
      },
    }
  )
  updated += 1
}

printjson({ scanned: entries.length, updated: updated })
