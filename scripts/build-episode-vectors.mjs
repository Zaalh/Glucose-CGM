// Bouwt episode_vectors uit pattern_events + entries.
// Numerieke curve-vector (genormaliseerd, vaste lengte) voor cosine-similarity,
// plus een uitlegbare featureVector en de gemeten outcome. Volledig lokaal.
// Draaien: docker compose ... exec -T nightscout-mongo sh -lc "mongo nightscout --quiet" < scripts/build-episode-vectors.mjs
var MS_PER_MIN = 60000
var MGDL_PER_MMOL = 18.0182
var SAMPLE_POINTS = 24          // curve-samples per episode
var PRE_PEAK_MIN = 20           // venster voor de piek
var POST_PEAK_MIN = 40          // venster na de piek
var BASELINE_FROM_MIN = 40      // baseline = gemiddelde [-40, -15] min voor piek
var BASELINE_TO_MIN = 15
var RISE_RATE_MIN = 15          // gladde gem. stijgsnelheid over 15 min voor piek

function mmol(entry) { return Number(entry.sgv) / MGDL_PER_MMOL }
function round(v, d) { var f = Math.pow(10, d); return Math.round(v * f) / f }

var entries = db.entries.find(
  { type: 'sgv' },
  { _id: 1, date: 1, sgv: 1 }
).sort({ date: 1 }).toArray()

function entriesBetween(fromMs, toMs) {
  var out = []
  for (var i = 0; i < entries.length; i += 1) {
    var t = entries[i].date
    if (t < fromMs) continue
    if (t > toMs) break
    out.push(entries[i])
  }
  return out
}

// Lineair geresamplede curve van vaste lengte over [fromMs, toMs].
function resampleCurve(window, fromMs, toMs, points) {
  if (!window.length) return null
  var span = toMs - fromMs
  var out = []
  for (var k = 0; k < points; k += 1) {
    var target = fromMs + (span * k) / (points - 1)
    // dichtstbijzijnde meting
    var best = window[0]
    var bestDiff = Math.abs(best.date - target)
    for (var i = 1; i < window.length; i += 1) {
      var d = Math.abs(window[i].date - target)
      if (d < bestDiff) { best = window[i]; bestDiff = d }
    }
    out.push(mmol(best))
  }
  return out
}

// Zero-mean unit-norm zodat cosine de curvevorm vergelijkt, niet de hoogte.
function normalizeShape(values) {
  var n = values.length
  if (!n) return values
  var mean = 0
  for (var i = 0; i < n; i += 1) mean += values[i]
  mean /= n
  var centered = values.map(function (v) { return v - mean })
  var norm = 0
  for (var j = 0; j < n; j += 1) norm += centered[j] * centered[j]
  norm = Math.sqrt(norm)
  if (norm < 1e-9) return centered.map(function () { return 0 })
  return centered.map(function (v) { return round(v / norm, 4) })
}

var events = db.pattern_events.find({}).toArray()
var bulk = db.episode_vectors.initializeUnorderedBulkOp()
var built = 0

for (var ei = 0; ei < events.length; ei += 1) {
  var ev = events[ei]
  var peakMs = Date.parse(ev.peakDate)
  var endMs = Date.parse(ev.endDate)
  if (!Number.isFinite(peakMs)) continue

  var winFrom = peakMs - PRE_PEAK_MIN * MS_PER_MIN
  var winTo = peakMs + POST_PEAK_MIN * MS_PER_MIN
  var window = entriesBetween(winFrom, winTo)
  if (window.length < 4) continue

  var curve = resampleCurve(window, winFrom, winTo, SAMPLE_POINTS)
  var shape = normalizeShape(curve)

  // baseline voor de stijging
  var baseWindow = entriesBetween(peakMs - BASELINE_FROM_MIN * MS_PER_MIN, peakMs - BASELINE_TO_MIN * MS_PER_MIN)
  var baseline = null
  if (baseWindow.length) {
    var sum = 0
    for (var b = 0; b < baseWindow.length; b += 1) sum += mmol(baseWindow[b])
    baseline = sum / baseWindow.length
  }

  var peakM = Number(ev.peakMmol)
  var endM = Number(ev.endMmol)
  var drop = Number.isFinite(peakM) && Number.isFinite(endM) ? peakM - endM : 0

  // max stijg-/daalsnelheid binnen het venster (mmol/min)
  var maxRise = 0, maxFall = 0
  for (var w = 1; w < window.length; w += 1) {
    var dt = (window[w].date - window[w - 1].date) / MS_PER_MIN
    if (dt <= 0) continue
    var rate = (mmol(window[w]) - mmol(window[w - 1])) / dt
    if (rate > maxRise) maxRise = rate
    if (rate < maxFall) maxFall = rate
  }

  // Gladde gem. stijgsnelheid (mmol/min) over 15 min voor de piek, vanaf de meting
  // op-of-voor dat moment. Identiek aan riseRateToPeak in hypo-features.mjs zodat
  // de live-match en deze opgeslagen waarde dezelfde grootheid vergelijken.
  var riseTarget = peakMs - RISE_RATE_MIN * MS_PER_MIN
  var riseBefore = null
  for (var r = 0; r < entries.length; r += 1) {
    if (entries[r].date > riseTarget) break
    riseBefore = entries[r]
  }
  var riseRate15m = null
  if (riseBefore && Number.isFinite(peakM)) {
    var riseDt = (peakMs - riseBefore.date) / MS_PER_MIN
    if (riseDt > 0) riseRate15m = Math.max(0, (peakM - mmol(riseBefore)) / riseDt)
  }

  // outcome: laagste waarde tot 60 min na piek
  var afterWindow = entriesBetween(peakMs, peakMs + 60 * MS_PER_MIN)
  var minAfter = Infinity
  for (var a = 0; a < afterWindow.length; a += 1) minAfter = Math.min(minAfter, mmol(afterWindow[a]))
  if (!Number.isFinite(minAfter)) minAfter = endM
  var outcome = minAfter < 4.0 ? 'hypo' : minAfter < 4.5 ? 'near_hypo' : 'stable'

  var featureVector = {
    peakMmol: round(peakM, 3),
    baselineMmol: baseline !== null ? round(baseline, 3) : null,
    riseFromBaseline: baseline !== null ? round(peakM - baseline, 3) : null,
    dropFromPeakMmol: round(drop, 3),
    dropPercentFromPeak: peakM > 0 ? round((drop / peakM) * 100, 2) : 0,
    minutesPeakToEnd: round((endMs - peakMs) / MS_PER_MIN, 2),
    maxRiseRate: round(maxRise, 4),
    riseRate15m: riseRate15m === null ? null : round(riseRate15m, 4),
    maxFallRate: round(maxFall, 4),
    minMmolAfter60: round(minAfter, 3),
  }

  var eventKey = (ev.type || 'event') + ':' + ev.peakDate
  bulk.find({ eventKey: eventKey }).upsert().updateOne({
    $set: {
      eventKey: eventKey,
      eventType: ev.type || null,
      startDate: ev.startDate || null,
      peakDate: ev.peakDate || null,
      endDate: ev.endDate || null,
      vectorVersion: 'curve-v1',
      vector: shape,
      featureVector: featureVector,
      outcome: outcome,
      labels: ev.labels || [],
      updatedAt: new Date().toISOString(),
    },
    $setOnInsert: { createdAt: new Date().toISOString() },
  })
  built += 1
}

if (built > 0) bulk.execute()
printjson({ events: events.length, built: built, collection: 'episode_vectors' })
