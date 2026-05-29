import { execSync } from 'node:child_process'

const mongoScript = `
var MS_PER_MIN = 60000;
var MGDL_PER_MMOL = 18.0182;
function mmol(e){ return Number(e.sgv)/MGDL_PER_MMOL; }
function rateOver(timeline, idx, minutesBack){
  var now=timeline[idx];
  var target=now.date-minutesBack*MS_PER_MIN;
  for (var i=idx-1;i>=0;i--){
    if (timeline[i].date<=target){
      var dt=(now.date-timeline[i].date)/MS_PER_MIN;
      if (dt<=0) return null;
      return (mmol(now)-mmol(timeline[i]))/dt;
    }
  }
  return null;
}
function evaluateRisk(input){
  var score=0,reasons=[];
  if (input.peakMmol>=10 && input.minutesSincePeak<=30){ score+=3; reasons.push('Recente piek >10'); }
  if (input.dropFromPeakMmol>=3){ score+=3; reasons.push('Drop >=3.0'); }
  else if (input.dropFromPeakMmol>=2){ score+=2; reasons.push('Drop >=2.0'); }
  if (input.dropFromPeakPercent>=30){ score+=3; reasons.push('Daling >=30%'); }
  else if (input.dropFromPeakPercent>=25){ score+=2; reasons.push('Daling >=25%'); }
  if ((input.rate5m||0)<=-0.08 || (input.rate10m||0)<=-0.08){ score+=3; reasons.push('Snelle daling'); }
  if ((input.rate15m||0)<=-0.04){ score+=2; reasons.push('Daling 15m'); }
  if (input.currentMmol<4.0){ score+=100; reasons.push('<4.0'); }
  else if (input.currentMmol<4.5){ score+=4; reasons.push('<4.5'); }
  var risk = score>=7 ? 'urgent' : score>=5 ? 'high' : score>=3 ? 'watch' : 'low';
  return {score:score,risk:risk,reasons:reasons};
}
function blendRate(rate5m, rate10m, rate15m){
  var r5 = Number.isFinite(rate5m) ? rate5m : null;
  var r10 = Number.isFinite(rate10m) ? rate10m : null;
  var r15 = Number.isFinite(rate15m) ? rate15m : null;
  var num = (r5||0)*0.5 + (r10||0)*0.33 + (r15||0)*0.17;
  var den = (r5===null?0:0.5) + (r10===null?0:0.33) + (r15===null?0:0.17);
  return den>0 ? num/den : 0;
}
function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
function probBelow(value, threshold){
  var d = threshold - value;
  var p = 1/(1+Math.exp(-d*2.4));
  return Math.round(clamp(p,0,1)*1000)/1000;
}
function buildForecast(currentMmol, rate5m, rate10m, rate15m){
  var horizons=[10,15,20,30], out={}, probs={};
  var rate = blendRate(rate5m, rate10m, rate15m);
  horizons.forEach(function(h){
    var v = clamp(currentMmol + rate*h, 1.5, 33);
    out[String(h)] = Math.round(v*1000)/1000;
    probs[String(h)] = { lt45: probBelow(v,4.5), lt40: probBelow(v,4.0) };
  });
  return { predictedMmol: out, probabilities: probs };
}
var timeline = db.entries.find({type:'sgv'},{_id:1,identifier:1,date:1,dateString:1,sgv:1}).sort({date:1}).limit(180).toArray();
if (!timeline.length) { printjson({ok:false,message:'no entries'}); quit(0); }
var i = timeline.length-1;
var e = timeline[i];
var windowStart = e.date - 120*MS_PER_MIN;
var peak = e;
for (var j=i;j>=0;j--){ if (timeline[j].date < windowStart) break; if (timeline[j].sgv > peak.sgv) peak = timeline[j]; }
var current=mmol(e), peakM=mmol(peak), drop=peakM-current;
var dropPct = peakM>0 ? (drop/peakM)*100 : 0;
var minsSincePeak=(e.date-peak.date)/MS_PER_MIN;
var rate5=rateOver(timeline,i,5), rate10=rateOver(timeline,i,10), rate15=rateOver(timeline,i,15);
var risk=evaluateRisk({ currentMmol: current, rate5m: rate5, rate10m: rate10, rate15m: rate15, peakMmol: peakM, minutesSincePeak: minsSincePeak, dropFromPeakMmol: drop, dropFromPeakPercent: dropPct });
var fc=buildForecast(current, rate5, rate10, rate15);
var exists = db.prediction_snapshots.findOne({ entryId: e._id });
if (exists) { printjson({ok:true,inserted:false,reason:'exists',entryId:e._id}); quit(0); }
db.prediction_snapshots.insertOne({ createdAt: e.dateString || new Date(e.date).toISOString(), entryId: e._id, entryIdentifier: e.identifier || null, currentMmol: Math.round(current*1000)/1000, risk: risk.risk, riskScore: risk.score, reasons: risk.reasons, predictedMmol: fc.predictedMmol, probabilities: fc.probabilities, modelVersion: 'rules-v1', outcomeEvaluated: false });
printjson({ok:true,inserted:true,entryId:e._id,risk:risk.risk,riskScore:risk.score});
`;

const cmd = "docker compose -f docker-compose.nightscout.yml exec -T nightscout-mongo sh -lc 'mongo nightscout --quiet'";
const out = execSync(cmd, { input: mongoScript, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
process.stdout.write(out);
