// Empirische vergelijking van snelheid-schatters voor het reactieve-hypo-patroon
// (piek -> daling). Meet per modus, op echte 1-min Nightscout-data:
//   - lead-time: hoeveel minuten vóór de bodem de daling betrouwbaar wordt geflagd
//   - valse alarmen: hoe vaak de modus buiten een echte daling "daalt" roept
// Eerlijke vergelijking: per modus de detectie-drempel zo gekozen dat het
// vals-alarm-budget gelijk is (ROC-stijl), daarna lead-time vergelijken.
//
// Data: node scripts/research-rate-pattern-leadtime.mjs /pad/naar/entries.json
//   (entries.json = Nightscout /api/v1/entries/sgv.json?count=NNNN)

import fs from 'fs'

const MGDL = 18.0182
const MIN = 60_000
const mmol = (m) => m / MGDL

const path = process.argv[2] || '/tmp/big.json'
const raw = JSON.parse(fs.readFileSync(path, 'utf8'))

// Ascending, uniek per timestamp.
const byT = new Map()
for (const e of raw) {
  if (!Number.isFinite(e.date) || !Number.isFinite(e.sgv)) continue
  if (!byT.has(e.date)) byT.set(e.date, e.sgv)
}
const S = [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, sgv]) => ({ t, y: mmol(sgv) }))
console.log(`punten: ${S.length}, span ${((S.at(-1).t - S[0].t) / 86400000).toFixed(1)} dagen`)

// ---- schatters (identiek aan rate-overlay.js) ----
function momentaan(i) {
  if (i < 1) return null
  const dt = (S[i].t - S[i - 1].t) / MIN
  if (!(dt > 0) || dt > 2.5) return null
  return (S[i].y - S[i - 1].y) / dt
}
function findIdxBack(i, minutes, tolMs = 75_000) {
  const target = S[i].t - minutes * MIN
  let best = -1, bd = Infinity
  for (let j = i - 1; j >= 0; j--) {
    if (S[i].t - S[j].t > minutes * MIN + tolMs * 2) break
    const d = Math.abs(S[j].t - target)
    if (d < bd) { bd = d; best = j }
  }
  return bd <= tolMs ? best : -1
}
function verhouding(i, N) {
  const j = findIdxBack(i, N)
  if (j < 0) return null
  return (S[i].y - S[j].y) / ((S[i].t - S[j].t) / MIN)
}
function regressie(i, winMin) {
  const win = winMin * MIN + 75_000
  const tau = Math.min(win, 12 * MIN) * 0.6
  const lt = S[i].t, minT = lt - win
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0
  for (let j = i; j >= 0; j--) {
    if (S[j].t < minT) break
    const x = (S[j].t - lt) / MIN, y = S[j].y, w = Math.exp((S[j].t - lt) / tau)
    sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y; n++
  }
  if (n < 3) return null
  const den = sw * sxx - sx * sx
  if (Math.abs(den) < 1e-9) return null
  return (sw * sxy - sx * sy) / den
}

// Blend zoals getForecastRateMmol: gewogen gemiddelde van regressie over 5/10/15/20 min.
function blend(i, w) {
  let num = 0, den = 0
  const wins = [5, 10, 15, 20]
  for (let k = 0; k < wins.length; k++) {
    const s = regressie(i, wins[k])
    if (s != null) { num += s * w[k]; den += w[k] }
  }
  return den > 0 ? num / den : null
}

const MODES = {
  'momentaan(1m)': (i) => momentaan(i),
  'verhouding-5m': (i) => verhouding(i, 5),
  'verhouding-15m': (i) => verhouding(i, 15),
  'regressie-5m': (i) => regressie(i, 5),
  'regressie-10m': (i) => regressie(i, 10),
  'regressie-15m': (i) => regressie(i, 15),
  // blends over 5/10/15/20 min:
  'blend-huidig': (i) => blend(i, [0.35, 0.30, 0.20, 0.15]), // huidige getForecastRateMmol
  'blend-mid': (i) => blend(i, [0.15, 0.35, 0.35, 0.15]),    // verschoven naar 10-15m
  'blend-1015': (i) => blend(i, [0.05, 0.45, 0.45, 0.05]),   // bijna puur 10-15m
}

// ---- echte daling-episodes: lokale piek -> bodem met sustained daling ----
// Piek = max in ±10 min. Bodem = min in de 60 min erna. Kwalificeert als de
// daling >= 1.4 mmol is (PEAK_DROP_THRESHOLDS.watch.minDrop) binnen 60 min.
const MINDROP = 1.4, MAXDROP_MIN = 60, PEAKWIN = 10
function timeIdx(fromIdx, minutes) {
  const target = S[fromIdx].t + minutes * MIN
  let k = fromIdx
  while (k < S.length - 1 && S[k].t < target) k++
  return k
}
const episodes = []
for (let i = PEAKWIN; i < S.length; i++) {
  // lokale piek?
  let isPeak = true
  for (let j = i - PEAKWIN; j <= i + PEAKWIN && j < S.length; j++) {
    if (j >= 0 && S[j].y > S[i].y + 1e-9) { isPeak = false; break }
  }
  if (!isPeak) continue
  const end = timeIdx(i, MAXDROP_MIN)
  let troughIdx = i, troughY = S[i].y
  for (let j = i + 1; j <= end; j++) if (S[j].y < troughY) { troughY = S[j].y; troughIdx = j }
  if (S[i].y - troughY >= MINDROP && troughIdx > i) {
    // overlappende pieken samenvoegen: alleen nieuwe als ruim na vorige bodem
    const last = episodes.at(-1)
    if (!last || S[i].t > last.troughT + 20 * MIN) {
      episodes.push({ peakIdx: i, peakT: S[i].t, troughIdx, troughT: S[troughIdx].t })
    }
  }
}
console.log(`echte daling-episodes (>=${MINDROP} mmol binnen ${MAXDROP_MIN}m): ${episodes.length}`)

// ---- profiel van JOUW patroon: peak-level, nadir, daling, duur, max daalsnelheid ----
for (const e of episodes) {
  e.peakY = S[e.peakIdx].y
  e.nadirY = S[e.troughIdx].y
  e.drop = e.peakY - e.nadirY
  e.durMin = (e.troughT - e.peakT) / MIN
  let mx = 0
  for (let j = e.peakIdx + 1; j <= e.troughIdx; j++) {
    const s = regressie(j, 10)
    if (s != null && s < mx) mx = s
  }
  e.maxFall10 = mx // mmol/min, meest negatieve regressie-10m
}
function pct(arr, p) { const a = arr.slice().sort((x, y) => x - y); return a[Math.floor((a.length - 1) * p)] }
const nadirs = episodes.map((e) => e.nadirY)
const peaks = episodes.map((e) => e.peakY)
const falls = episodes.map((e) => e.maxFall10)
console.log('\n=== profiel van jouw dalingen ===')
console.log(`piek  (mmol):  mediaan ${pct(peaks, 0.5).toFixed(1)}   p10-p90 ${pct(peaks, 0.1).toFixed(1)}-${pct(peaks, 0.9).toFixed(1)}`)
console.log(`bodem (mmol):  mediaan ${pct(nadirs, 0.5).toFixed(1)}   p10-p90 ${pct(nadirs, 0.1).toFixed(1)}-${pct(nadirs, 0.9).toFixed(1)}`)
console.log(`daling(mmol):  mediaan ${pct(episodes.map(e=>e.drop), 0.5).toFixed(1)}`)
console.log(`max daalsnelheid (regressie-10m): mediaan ${pct(falls, 0.5).toFixed(3)}  steilste ${Math.min(...falls).toFixed(3)} mmol/min`)
const below45 = episodes.filter((e) => e.nadirY < 4.5)
const below39 = episodes.filter((e) => e.nadirY < 3.9)
console.log(`episodes die laag bereiken: nadir<4.5 -> ${below45.length}/${episodes.length}   nadir<3.9 (hypo) -> ${below39.length}/${episodes.length}`)

// markeer "binnen episode" minuten (piek t/m bodem) om valse alarmen te scheiden
const inEpisode = new Array(S.length).fill(false)
for (const e of episodes) for (let j = e.peakIdx; j <= e.troughIdx; j++) inEpisode[j] = true

const days = (S.at(-1).t - S[0].t) / 86400000

// ---- per modus: sweep drempel, meet lead-time (in episode) en FP/dag (buiten) ----
function evalMode(fn, thr, epis = episodes) {
  // detectie = slope <= -thr (dalend). lead = bodem - eerste detectie tussen piek en bodem.
  const detLeads = []
  let detected = 0
  for (const e of epis) {
    let fired = -1
    for (let j = e.peakIdx; j <= e.troughIdx; j++) {
      const s = fn(j)
      if (s != null && s <= -thr) { fired = j; break }
    }
    if (fired >= 0) { detected++; detLeads.push((e.troughT - S[fired].t) / MIN) }
  }
  // valse alarmen: crossing-events (boven->onder drempel) buiten episodes
  let fp = 0, prevBelow = false
  for (let j = 0; j < S.length; j++) {
    const s = fn(j)
    const below = s != null && s <= -thr
    if (below && !prevBelow && !inEpisode[j]) fp++
    prevBelow = below
  }
  detLeads.sort((a, b) => a - b)
  const medLead = detLeads.length ? detLeads[Math.floor(detLeads.length / 2)] : 0
  return { recall: detected / epis.length, medLead, fpPerDay: fp / days }
}

// Bij gelijke gevoeligheid (recall): wie heeft de minste valse alarmen + meeste lead-time?
// Per modus de drempel die de doel-recall haalt met de laagste FP/dag.
function atRecall(fn, target, epis = episodes) {
  let best = null
  for (let thr = 0.02; thr <= 0.30; thr += 0.0025) {
    const r = evalMode(fn, thr, epis)
    if (r.recall >= target) {
      if (!best || r.fpPerDay < best.fpPerDay) best = { ...r, thr }
    }
  }
  return best
}

// JOUW reactieve patroon: dalingen die laag-gebied bereiken (nadir < 4.5 mmol).
// Hier telt of regressie juist déze betrouwbaar én vroeg pakt.
console.log('\n=== werkt het voor JOUW patroon? (alleen dalingen met nadir < 4.5 mmol) ===')
if (below45.length < 4) {
  console.log(`  te weinig (${below45.length}) in dit venster van 4 dagen voor harde cijfers`)
} else {
  console.log(`  ${below45.length} reactieve dalingen. Per modus: laagste FP/dag bij 100% van déze gepakt.`)
  console.log('  modus            FP/dag   lead(med)  drempel  recall')
  for (const name of ['momentaan(1m)', 'verhouding-15m', 'regressie-10m', 'regressie-15m', 'blend-huidig']) {
    const b = atRecall(MODES[name], 1.0, below45)
    if (!b) { console.log(`  ${name.padEnd(16)} (pakt niet alle ${below45.length})`); continue }
    console.log(`  ${name.padEnd(16)} ${b.fpPerDay.toFixed(2).padStart(5)}   ${String(b.medLead.toFixed(1)).padStart(6)} min  ${b.thr.toFixed(3)}   ${(b.recall * 100).toFixed(0)}%`)
  }
}

for (const target of [0.6, 0.8]) {
  console.log(`\n=== bij gelijke gevoeligheid: detecteer >= ${(target * 100).toFixed(0)}% van de dalingen ===`)
  console.log('modus            FP/dag   lead(med)  drempel  echte recall')
  const rows = []
  for (const [name, fn] of Object.entries(MODES)) {
    const b = atRecall(fn, target)
    rows.push({ name, b })
  }
  rows.sort((a, b) => (a.b ? a.b.fpPerDay : 1e9) - (b.b ? b.b.fpPerDay : 1e9))
  for (const { name, b } of rows) {
    if (!b) { console.log(`${name.padEnd(16)} (haalt deze recall niet)`); continue }
    console.log(
      `${name.padEnd(16)} ${b.fpPerDay.toFixed(2).padStart(5)}   ` +
      `${String(b.medLead.toFixed(1)).padStart(6)} min  ` +
      `${b.thr.toFixed(3)}   ${(b.recall * 100).toFixed(0)}%`
    )
  }
}
