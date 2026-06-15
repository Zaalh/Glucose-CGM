// ONDERZOEK (read-only): is het post-nadir herstel (de "rebound") voorspelbaar genoeg
// om als forecast te tonen? Leest een dump van reactive_hypo_episodes (JSON-array) en
// kwantificeert herstel-verdeling, voorspelbaarheid en stratificatie.
//
// Dump maken (op de iMac / via SSH):
//   docker exec -i glucosecgm-nightscout-mongo-1 mongo nightscout --quiet \
//     --eval 'print(JSON.stringify(db.reactive_hypo_episodes.find({},{_id:0}).toArray()))' > episodes.json
// Draaien:  node scripts/research-rebound-forecast.mjs episodes.json
import fs from 'fs'
const path = process.argv[2] || '/tmp/episodes.json'
const eps = JSON.parse(fs.readFileSync(path, 'utf8'))

const q = (arr, p) => { if (!arr.length) return NaN; const s=[...arr].sort((a,b)=>a-b); const i=(s.length-1)*p; const lo=Math.floor(i),hi=Math.ceil(i); return s[lo]+(s[hi]-s[lo])*(i-lo) }
const med = a => q(a,0.5), mean = a => a.reduce((s,v)=>s+v,0)/a.length
const sd = a => { const m=mean(a); return Math.sqrt(mean(a.map(v=>(v-m)**2))) }
const cv = a => sd(a)/mean(a)
const corr = (x,y) => { const mx=mean(x),my=mean(y); let n=0,dx=0,dy=0; for(let i=0;i<x.length;i++){n+=(x[i]-mx)*(y[i]-my);dx+=(x[i]-mx)**2;dy+=(y[i]-my)**2} return n/Math.sqrt(dx*dy) }
const fmt = v => Number.isFinite(v)? (Math.round(v*100)/100).toString() : 'n/a'

console.log('TOTAAL episodes:', eps.length)
const byOutcome={}; eps.forEach(e=>byOutcome[e.outcome]=(byOutcome[e.outcome]||0)+1)
console.log('outcome:', JSON.stringify(byOutcome))
const byShape={}; eps.forEach(e=>byShape[e.shape]=(byShape[e.shape]||0)+1)
console.log('shape:', JSON.stringify(byShape))

const recov = eps.filter(e => e.nadirMmol < 4.5 && e.recoveryMinutes != null && e.reboundPeakMmol != null
  && !e.qualityFlags.includes('possible_compression_low') && e.qualityScore >= 60)
console.log('\n=== Analyse-set (nadir<4.5, herstel gemeten, quality>=60):', recov.length, '===')

const reboundMag = recov.map(e => e.reboundPeakMmol - e.nadirMmol)
const recMin = recov.map(e => e.recoveryMinutes)
const reboundPeak = recov.map(e => e.reboundPeakMmol)
const reboundMinAfter = recov.map(e => e.reboundMinutesAfterRecovery).filter(Number.isFinite)
const nadir = recov.map(e => e.nadirMmol)
const drop = recov.map(e => e.dropFromPeakMmol)
const peak = recov.map(e => e.peakMmol)
const fall = recov.map(e => Math.abs(e.maxFallRate30m))
const p2n = recov.map(e => e.minutesPeakToNadir)

const report = (label, a) => console.log(`  ${label.padEnd(28)} med=${fmt(med(a))}  IQR[${fmt(q(a,0.25))}-${fmt(q(a,0.75))}]  mean=${fmt(mean(a))}  sd=${fmt(sd(a))}  CV=${fmt(cv(a))}`)
console.log('\n-- Herstel-verdeling --')
report('reboundPeak (mmol)', reboundPeak)
report('rebound-omvang nadir->piek', reboundMag)
report('recoveryMin (nadir->3.9)', recMin)
report('rebound-piek na 3.9 (min)', reboundMinAfter)
report('nadir (mmol)', nadir)
report('drop piek->nadir', drop)
report('minutesPeakToNadir', p2n)

console.log('\n-- Voorspelbaarheid: correleert herstel met info die je AL bij de nadir hebt? --')
console.log('  (|r|<0.2 = geen signaal; |r|>0.4 = bruikbaar)')
const preds = { nadir, drop, peak, fall, minutesPeakToNadir:p2n }
for (const [name, x] of Object.entries(preds)) console.log(`  reboundPeak ~ ${name.padEnd(20)} r=${fmt(corr(x, reboundPeak))}`)
console.log('  ---')
for (const [name, x] of Object.entries(preds)) console.log(`  recoveryMin ~ ${name.padEnd(20)} r=${fmt(corr(x, recMin))}`)

console.log('\n-- Stratificatie naar tijd-van-de-dag --')
const buckets={}
recov.forEach(e=>{(buckets[e.timeOfDayBucket]=buckets[e.timeOfDayBucket]||[]).push(e)})
for (const [b, list] of Object.entries(buckets)) {
  const rp=list.map(e=>e.reboundPeakMmol), rm=list.map(e=>e.recoveryMinutes)
  console.log(`  ${String(b).padEnd(10)} n=${String(list.length).padEnd(3)} reboundPeak med=${fmt(med(rp))} [${fmt(q(rp,0.25))}-${fmt(q(rp,0.75))}]  recMin med=${fmt(med(rm))}`)
}

console.log('\n-- Hoe vaak schiet je door (rebound-overshoot)? --')
const overshoot = recov.filter(e=>e.reboundPeakMmol >= e.peakMmol).length
const high = recov.filter(e=>e.reboundPeakMmol >= 10).length
console.log(`  rebound >= oorspronkelijke piek: ${overshoot}/${recov.length} (${fmt(100*overshoot/recov.length)}%)`)
console.log(`  rebound >= 10 mmol (hoog): ${high}/${recov.length} (${fmt(100*high/recov.length)}%)`)

// Baseline-voorspelfout: "voorspel altijd de mediaan" vs werkelijkheid (MAE)
const mae = (a, pred) => mean(a.map(v=>Math.abs(v-pred)))
console.log('\n-- Naive forecast-fout (als we simpelweg de mediaan zouden tonen) --')
console.log(`  reboundPeak: mediaan=${fmt(med(reboundPeak))} mmol, MAE=${fmt(mae(reboundPeak, med(reboundPeak)))} mmol`)
console.log(`  recoveryMin: mediaan=${fmt(med(recMin))} min,  MAE=${fmt(mae(recMin, med(recMin)))} min`)
