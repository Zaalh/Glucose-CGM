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
var risk=evaluateRisk({ currentMmol: current, rate5m: rateOver(timeline,i,5), rate10m: rateOver(timeline,i,10), rate15m: rateOver(timeline,i,15), peakMmol: peakM, minutesSincePeak: minsSincePeak, dropFromPeakMmol: drop, dropFromPeakPercent: dropPct });
var exists = db.prediction_snapshots.findOne({ entryId: e._id });
if (exists) { printjson({ok:true,inserted:false,reason:'exists',entryId:e._id}); quit(0); }
db.prediction_snapshots.insertOne({ createdAt: e.dateString || new Date(e.date).toISOString(), entryId: e._id, entryIdentifier: e.identifier || null, currentMmol: Math.round(current*1000)/1000, risk: risk.risk, riskScore: risk.score, reasons: risk.reasons, modelVersion: 'rules-v1', outcomeEvaluated: false });
printjson({ok:true,inserted:true,entryId:e._id,risk:risk.risk,riskScore:risk.score});
`;

const cmd = "docker compose -f docker-compose.nightscout.yml exec -T nightscout-mongo sh -lc 'mongo nightscout --quiet'";
const out = execSync(cmd, { input: mongoScript, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
process.stdout.write(out);
