var MGDL_PER_MMOL = 18.0182
function mmol(e){ return Number(e.sgv)/MGDL_PER_MMOL }
function dayKeyFromMs(ms){ return new Date(ms).toISOString().slice(0,10) }

var entries = db.entries.find({type:'sgv'},{date:1,sgv:1}).sort({date:1}).toArray()
var events = db.pattern_events.find({},{type:1,startDate:1,peakDate:1,createdAt:1,labels:1}).toArray()
var snaps = db.prediction_snapshots.find({outcomeEvaluated:true},{createdAt:1,result:1}).toArray()

var byDay = {}

for (var i=0;i<entries.length;i+=1){
  var e=entries[i]
  var d=dayKeyFromMs(e.date)
  if (!byDay[d]) byDay[d]={date:d,pointsCount:0,timeBelow40:0,timeBelow45:0,timeAbove85:0,timeAbove100:0,hypoCount:0,nearHypoCount:0,spikeCount:0,fastDropCount:0,suspectedMealCount:0,fastCrashCurveCount:0,falsePositiveCount:0,missedHypoCount:0,averageLeadTimeMinutes:null,modelVersion:'rules-v1-calibrated'}
  var row=byDay[d]
  row.pointsCount += 1
  var v=mmol(e)
  if (v<4.0) row.timeBelow40 += 1
  if (v<4.5) row.timeBelow45 += 1
  if (v>8.5) row.timeAbove85 += 1
  if (v>10.0) row.timeAbove100 += 1
}

for (var j=0;j<events.length;j+=1){
  var ev=events[j]
  var t=Date.parse(ev.peakDate || ev.startDate || ev.createdAt || '')
  if (!Number.isFinite(t)) continue
  var d=dayKeyFromMs(t)
  if (!byDay[d]) continue
  var row=byDay[d]
  if (ev.type==='hypo' || ev.type==='hypo_after_hyper') row.hypoCount += 1
  if (ev.type==='near_hypo' || ev.type==='near_hypo_after_hyper') row.nearHypoCount += 1
  if (ev.type==='spike') row.spikeCount += 1
  if (ev.type==='fast_drop') row.fastDropCount += 1
  if (ev.labels && ev.labels.indexOf('fast_reactive')>=0) row.fastCrashCurveCount += 1
}

for (var k=0;k<snaps.length;k+=1){
  var s=snaps[k]
  var t=Date.parse(s.createdAt || '')
  if (!Number.isFinite(t)) continue
  var d=dayKeyFromMs(t)
  if (!byDay[d]) continue
  if (s.result==='false_positive') byDay[d].falsePositiveCount += 1
  if (s.result==='false_negative') byDay[d].missedHypoCount += 1
}

var days = Object.keys(byDay).sort()
var bulk = db.daily_summaries.initializeUnorderedBulkOp()
for (var n=0;n<days.length;n+=1){
  var key=days[n]
  var row=byDay[key]
  bulk.find({date:key}).upsert().updateOne({$set:row,$setOnInsert:{createdAt:new Date().toISOString()}})
}
if (days.length) bulk.execute()
printjson({ok:true, days:days.length, collection:'daily_summaries'})
