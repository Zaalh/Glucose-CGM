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

var entries = db.entries.find(
  { type: 'sgv' },
  { _id: 1, identifier: 1, date: 1, dateString: 1, sgv: 1, glucoseRateMmolPerMin: 1 }
).sort({ date: 1 }).toArray()

// Idempotent: leeg de collectie eerst zodat herhaald draaien (bv. de dagelijkse cron)
// geen duplicaten opbouwt. pattern_events wordt elke run volledig herbouwd uit entries.
// Zonder dit dupliceert elke run alle events -> scheef getrokken live similar-counts.
db.pattern_events.remove({})

var bulk = db.pattern_events.initializeUnorderedBulkOp()
var created = 0

for (var i = 2; i < entries.length; i += 1) {
  var e = entries[i]
  var current = mmol(e)
  var r5 = safeRate(e, '5m')
  var r10 = safeRate(e, '10m')

  var lookbackStart = e.date - 60 * MS_PER_MIN
  var localPeak = null
  for (var j = i - 1; j >= 0; j -= 1) {
    if (entries[j].date < lookbackStart) break
    if (!localPeak || entries[j].sgv > localPeak.sgv) localPeak = entries[j]
  }
  if (!localPeak) continue

  var peakMmol = mmol(localPeak)
  var drop = peakMmol - current
  var minutesSincePeak = (e.date - localPeak.date) / MS_PER_MIN
  var isFastDrop = drop >= 2 && minutesSincePeak <= 45 && (r5 !== null && r5 <= -0.05 || r10 !== null && r10 <= -0.04)
  var isNearHypo = current < 4.5
  var isHypo = current < 4.0

  if (!isFastDrop && !isNearHypo && !isHypo) continue

  var type = isHypo ? 'hypo' : isNearHypo ? 'near_hypo' : 'fast_drop'
  var labels = []
  if (peakMmol >= 10 && minutesSincePeak <= 60 && current < 4.5) {
    type = current < 4.0 ? 'hypo_after_hyper' : 'near_hypo_after_hyper'
    labels.push('fast_reactive')
  } else if (isFastDrop) {
    labels.push('fast_drop_risk')
  }

  bulk.insert({
    type: type,
    startDate: localPeak.dateString || new Date(localPeak.date).toISOString(),
    endDate: e.dateString || new Date(e.date).toISOString(),
    peakDate: localPeak.dateString || new Date(localPeak.date).toISOString(),
    startMmol: round(peakMmol, 3),
    endMmol: round(current, 3),
    peakMmol: round(peakMmol, 3),
    minMmol: round(current, 3),
    durationMinutes: round(minutesSincePeak, 2),
    sourceEntryIds: [localPeak._id, e._id],
    rates: {
      '5m': r5,
      '10m': r10,
    },
    features: {
      dropFromPeakMmol: round(drop, 3),
      minutesSincePeak: round(minutesSincePeak, 2),
    },
    labels: labels,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  created += 1
}

if (created > 0) bulk.execute()

printjson({ scanned: entries.length, inserted: created, collection: 'pattern_events' })
