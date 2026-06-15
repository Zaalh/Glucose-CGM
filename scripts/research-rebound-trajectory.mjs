// ONDERZOEK (read-only): reconstrueert de werkelijke post-nadir herstelcurves, uitgelijnd
// op t=0 = nadir, en bepaalt de mediane traject + onzekerheidsband (p25/p75).
// Beantwoordt: hoe consistent is de vorm van het herstel, en kan een mediaan-curve dienen
// als forecast? Vergelijkt ook globaal vs. dag/nacht.
//   node scripts/research-rebound-trajectory.mjs /tmp/episodes.json /tmp/all_entries.json
import fs from 'fs'
const MMOL = 18.0182
const eps = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/episodes.json', 'utf8'))
const entries = JSON.parse(fs.readFileSync(process.argv[3] || '/tmp/all_entries.json', 'utf8'))
  .map(e => ({ t: e.date, v: e.sgv / MMOL })).sort((a, b) => a.t - b.t)

const q = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo) }
const med = a => q(a, 0.5)
const fmt = v => Number.isFinite(v) ? (Math.round(v * 100) / 100) : NaN

// binaire zoek dichtstbijzijnde meting bij tijdstip target binnen tol ms
function sampleAt(target, tolMs) {
  let lo = 0, hi = entries.length - 1, best = null, bestD = Infinity
  while (lo <= hi) { const m = (lo + hi) >> 1; const d = entries[m].t - target; if (Math.abs(d) < bestD) { bestD = Math.abs(d); best = entries[m] }; if (d < 0) lo = m + 1; else hi = m - 1 }
  return bestD <= tolMs ? best.v : null
}

const recov = eps.filter(e => e.nadirMmol < 4.5 && e.recoveryMinutes != null && e.reboundPeakMmol != null
  && !e.qualityFlags.includes('possible_compression_low') && e.qualityScore >= 60)

const OFFSETS = []; for (let m = 0; m <= 90; m += 5) OFFSETS.push(m)
const TOL = 4 * 60000

function trajectoriesFor(list) {
  const cols = OFFSETS.map(() => [])
  let used = 0
  for (const e of list) {
    const nadirT = Date.parse(e.nadirAt)
    const row = OFFSETS.map(m => sampleAt(nadirT + m * 60000, TOL))
    if (row.filter(v => v != null).length < OFFSETS.length * 0.7) continue
    used++
    row.forEach((v, i) => { if (v != null) cols[i].push(v) })
  }
  return { cols, used }
}

function printCurve(label, list) {
  const { cols, used } = trajectoriesFor(list)
  console.log(`\n=== ${label}  (n=${used} bruikbare curves) ===`)
  console.log('  t(min)  p25   med   p75   spread(p75-p25)')
  for (let i = 0; i < OFFSETS.length; i++) {
    if (OFFSETS[i] % 10 !== 0) continue
    const c = cols[i]; if (!c.length) continue
    const p25 = q(c, 0.25), p50 = med(c), p75 = q(c, 0.75)
    console.log(`  +${String(OFFSETS[i]).padStart(2)}    ${fmt(p25).toFixed(1).padStart(4)}  ${fmt(p50).toFixed(1).padStart(4)}  ${fmt(p75).toFixed(1).padStart(4)}   ${fmt(p75 - p25).toFixed(1)}`)
  }
  // tijd tot ">=4.5 veilig" en ">=5.5 comfortabel" op de mediaan-curve
  const medCurve = cols.map(med)
  const cross = (thr) => { for (let i = 0; i < OFFSETS.length; i++) if (medCurve[i] >= thr) return OFFSETS[i]; return null }
  console.log(`  mediaan kruist 4.5 @ +${cross(4.5)}min, 5.5 @ +${cross(5.5)}min, 6.5 @ +${cross(6.5)}min`)
  return medCurve
}

console.log('Analyse-set:', recov.length, 'reactieve dips (nadir<4.5)')
printCurve('ALLE reactieve dips', recov)
printCurve('NACHT (peak voor 06:00)', recov.filter(e => e.nightEpisode))
printCurve('DAG', recov.filter(e => !e.nightEpisode))
printCurve('SNELLE drop (|maxFall|>=0.25)', recov.filter(e => Math.abs(e.maxFallRate30m) >= 0.25))
printCurve('TRAGE drift (|maxFall|<0.15)', recov.filter(e => Math.abs(e.maxFallRate30m) < 0.15))

// Cohort-test: voorspelt de mediaan-curve elke individuele episode goed?
// MAE van "toon de globale mediaan-curve" t.o.v. de echte waarde, op +15/+30/+45 min.
const { cols } = trajectoriesFor(recov)
const idx = m => OFFSETS.indexOf(m)
console.log('\n=== Forecast-fout van een vaste mediaan-curve (per horizon) ===')
for (const h of [15, 30, 45, 60]) {
  const c = cols[idx(h)]; const m = med(c)
  const mae = c.reduce((s, v) => s + Math.abs(v - m), 0) / c.length
  console.log(`  +${h}min: mediaan=${fmt(m).toFixed(1)} mmol  MAE=${fmt(mae).toFixed(2)}  p10/p90=[${fmt(q(c,0.1)).toFixed(1)}-${fmt(q(c,0.9)).toFixed(1)}]`)
}
