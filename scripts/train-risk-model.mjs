var now = new Date().toISOString()
var policy = (typeof process !== 'undefined' && process.env && process.env.TRAIN_POLICY) ? String(process.env.TRAIN_POLICY) : 'recall-first'

var snaps = db.prediction_snapshots.find({ outcomeEvaluated: true }).toArray()
if (!snaps.length) {
  printjson({ ok: false, message: 'No evaluated prediction_snapshots found' })
  quit(0)
}

function metricForThreshold(th) {
  var tp = 0, fp = 0, fn = 0, tn = 0
  for (var i = 0; i < snaps.length; i += 1) {
    var s = snaps[i]
    var predicted = Number(s.riskScore || 0) >= th
    var actual = Boolean(s.actualNearHypoWithin_30m)
    if (predicted && actual) tp += 1
    else if (predicted && !actual) fp += 1
    else if (!predicted && actual) fn += 1
    else tn += 1
  }
  var precision = tp + fp > 0 ? tp / (tp + fp) : 0
  var recall = tp + fn > 0 ? tp / (tp + fn) : 0
  var f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0
  var fpPerDay = fp
  return { th: th, tp: tp, fp: fp, fn: fn, tn: tn, precision: precision, recall: recall, f1: f1, fpPerDay: fpPerDay }
}

var candidates = [2,3,4,5,6,7,8,9,10]
var scored = []
for (var c = 0; c < candidates.length; c += 1) scored.push(metricForThreshold(candidates[c]))

if (policy === 'precision-first') {
  scored.sort(function(a,b){
    if (b.precision !== a.precision) return b.precision - a.precision
    if (b.recall !== a.recall) return b.recall - a.recall
    return b.f1 - a.f1
  })
} else if (policy === 'balanced') {
  scored.sort(function(a,b){ return b.f1 - a.f1 })
} else {
  scored.sort(function(a,b){
    if (b.recall !== a.recall) return b.recall - a.recall
    if (b.precision !== a.precision) return b.precision - a.precision
    return b.f1 - a.f1
  })
}
var best = scored[0]

var model = {
  modelVersion: 'rules-v1-calibrated',
  active: true,
  trainedUntil: now,
  thresholds: {
    watchScoreMin: Math.max(2, best.th - 2),
    highScoreMin: Math.max(3, best.th),
    urgentScoreMin: Math.max(5, best.th + 2),
  },
  weights: {
    recentPeakOver10: 3,
    dropFromPeak2: 2,
    dropFromPeak3: 3,
    dropPercent25: 2,
    dropPercent30: 3,
    fastRate: 3,
    sustainedRate15m: 2,
    nearHypo: 4,
    hypo: 100,
  },
  calibration: {
    selectedHighThreshold: best.th,
    selectionPolicy: policy,
  },
  metrics: {
    totalEvaluated: snaps.length,
    tp: best.tp,
    fp: best.fp,
    fn: best.fn,
    tn: best.tn,
    precision: best.precision,
    recall: best.recall,
    f1: best.f1,
  },
  notes: 'Auto-calibrated from prediction_snapshots (nearHypoWithin30m target).',
  updatedAt: now,
}

db.model_state.updateOne(
  { modelVersion: model.modelVersion },
  { $set: model, $setOnInsert: { createdAt: now } },
  { upsert: true }
)

// Keep only this model active
 db.model_state.updateMany(
  { modelVersion: { $ne: model.modelVersion } },
  { $set: { active: false, updatedAt: now } }
)

printjson({ ok: true, selected: best, candidates: scored, modelVersion: model.modelVersion })
