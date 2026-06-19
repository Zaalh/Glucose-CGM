// Diagnose: hoe groot is de BLINDE VLEK voor het patroon dip -> harde stijging ->
// harde daling? episode_vectors worden alleen gebouwd uit pattern_events, en die
// komen uit een vaste selector (analyze-patterns.mjs). Een dip->rise->drop die niet
// door die poort komt, wordt nooit geleerd. Dit script meet dat op de RUWE entries.
//
// Verandert niets; alleen-lezen. Draaien (Mongo in container op de iMac):
//   docker compose -f docker-compose.nightscout.yml --profile libre run --rm \
//     libreview-sync node scripts/measure-dip-rise-drop-blindspot.mjs
// Offline rook-test: node scripts/measure-dip-rise-drop-blindspot.mjs --self-test

import { MongoClient } from 'mongodb'

const MGDL_PER_MMOL = 18.0182
const MS_PER_MIN = 60000
const mmol = (e) => Number(e.sgv) / MGDL_PER_MMOL

// Universele vorm-heuristieken (mmol), env-overschrijfbaar — geen persoonlijke tuning.
const num = (k, d) => (Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d)
const DIP_MMOL = num('DIP_MMOL', 0.3) // dip-diepte t.o.v. baseline voor de stijging
const RISE_MMOL = num('RISE_MMOL', 1.0) // stijging dal -> piek
const DROP_MMOL = num('DROP_MMOL', 0.8) // daling piek -> dal erna
const PEAK_SEP_MIN = num('PEAK_SEP_MIN', 30) // min. afstand tussen geaccepteerde pieken
const WINDOW_PRE_MIN = 20 // episode_vectors-venster begint piek-20m (window-blinde-vlek)

function minBetween(entries, fromMs, toMs) {
  let best = null
  for (const e of entries) {
    if (e.date < fromMs) continue
    if (e.date > toMs) break
    if (!best || e.sgv < best.sgv) best = e
  }
  return best
}

function valueAround(entries, targetMs) {
  let best = null
  let bestDiff = Infinity
  for (const e of entries) {
    const d = Math.abs(e.date - targetMs)
    if (d < bestDiff) { best = e; bestDiff = d }
  }
  return best && bestDiff <= 6 * MS_PER_MIN ? best : null
}

// rate (mmol/min) over de laatste ~10 min tot index i
function rateTo(entries, i, minutes = 10) {
  const target = entries[i].date - minutes * MS_PER_MIN
  let ref = null
  for (let j = i - 1; j >= 0; j -= 1) {
    if (entries[j].date <= target) { ref = entries[j]; break }
    ref = entries[j]
  }
  if (!ref) return null
  const dt = (entries[i].date - ref.date) / MS_PER_MIN
  return dt > 0 ? (mmol(entries[i]) - mmol(ref)) / dt : null
}

// Replica van de selector-gate uit analyze-patterns.mjs: wordt dit dal als event
// vastgelegd? -> bepaalt of de vorm ueberhaupt in episode_vectors kan komen.
function selectorWouldRecord(nadirMmol, dropFromPeak, minutesPeakToNadir, nadirRate) {
  const isHypoOrNear = nadirMmol < 4.5
  const fast = nadirRate !== null && nadirRate <= -0.04
  const isFastDrop = dropFromPeak >= 2 && minutesPeakToNadir <= 45 && fast
  return { recorded: isHypoOrNear || isFastDrop, isHypoOrNear, isFastDrop }
}

export function analyze(entries) {
  const sorted = entries.slice().sort((a, b) => a.date - b.date)
  const peaks = []
  // lokale piek = max binnen +-15 min
  for (let i = 0; i < sorted.length; i += 1) {
    const t = sorted[i].date
    let isPeak = true
    for (const e of sorted) {
      if (e.date < t - 15 * MS_PER_MIN) continue
      if (e.date > t + 15 * MS_PER_MIN) break
      if (e.sgv > sorted[i].sgv) { isPeak = false; break }
    }
    if (!isPeak) continue
    if (peaks.length && t - peaks[peaks.length - 1].date < PEAK_SEP_MIN * MS_PER_MIN) {
      if (sorted[i].sgv > peaks[peaks.length - 1].sgv) peaks[peaks.length - 1] = sorted[i]
      continue
    }
    peaks.push(sorted[i])
  }

  const out = {
    totalEntries: sorted.length,
    peaks: peaks.length,
    candidates: 0,
    artifactRejected: 0, // afgekeurd als sensor-spike/compressie-low (1-sample dip / implausibele rate)
    candidatesTrueHypo: 0, // bodem < 3.9 (klinisch Level-1) — de subset die er echt toe doet
    caught: 0,
    missed: 0,
    missedMildDrop: 0, // dal >= 4.5 en drop < 2 -> klassieke blinde vlek
    missedSlowOrLate: 0, // drop >= 2 maar niet snel / > 45 min
    dipOutsideWindow: 0, // dip-tijd voor piek-20m -> buiten opgeslagen curve
  }
  const dipMinutesBeforePeak = [] // verdeling: hoe ver voor de piek ligt de dip echt

  for (const peak of peaks) {
    const peakMmol = mmol(peak)
    const leadingTrough = minBetween(sorted, peak.date - 60 * MS_PER_MIN, peak.date)
    const nadir = minBetween(sorted, peak.date, peak.date + 60 * MS_PER_MIN)
    if (!leadingTrough || !nadir || leadingTrough.date === peak.date) continue
    const troughMmol = mmol(leadingTrough)
    const nadirMmol = mmol(nadir)
    const riseToPeak = peakMmol - troughMmol
    const dropFromPeak = peakMmol - nadirMmol
    const baseline = valueAround(sorted, leadingTrough.date - 30 * MS_PER_MIN)
    const dipDepth = baseline ? mmol(baseline) - troughMmol : 0

    const isDipRiseDrop = dipDepth >= DIP_MMOL && riseToPeak >= RISE_MMOL && dropFromPeak >= DROP_MMOL
    if (!isDipRiseDrop) continue

    // Artefact-gate: een echte fysiologische dip is door >=2 metingen bevestigd en de
    // in-/uit-rate is plausibel. Een 1-sample dip of |rate| > 0.6 mmol/min is verdacht
    // (sensor-spike / compressie-low) en hoort niet als dip->rise->drop te tellen.
    const nearTrough = sorted.filter((e) => Math.abs(e.date - leadingTrough.date) <= 6 * MS_PER_MIN && mmol(e) <= troughMmol + 0.4)
    const troughIdx = sorted.indexOf(leadingTrough)
    const troughRate = troughIdx > 0 ? Math.abs(rateTo(sorted, troughIdx, 5) ?? 0) : 0
    if (nearTrough.length < 2 || troughRate > 0.6) { out.artifactRejected += 1; continue }

    out.candidates += 1
    if (nadirMmol < 3.9) out.candidatesTrueHypo += 1

    const minutesPeakToNadir = (nadir.date - peak.date) / MS_PER_MIN
    const nadirIdx = sorted.indexOf(nadir)
    const nadirRate = nadirIdx > 0 ? rateTo(sorted, nadirIdx, 10) : null
    const sel = selectorWouldRecord(nadirMmol, dropFromPeak, minutesPeakToNadir, nadirRate)

    if (sel.recorded) out.caught += 1
    else {
      out.missed += 1
      if (nadirMmol >= 4.5 && dropFromPeak < 2) out.missedMildDrop += 1
      else if (dropFromPeak >= 2) out.missedSlowOrLate += 1
    }
    const dipBefore = (peak.date - leadingTrough.date) / MS_PER_MIN
    dipMinutesBeforePeak.push(dipBefore)
    if (dipBefore > WINDOW_PRE_MIN) out.dipOutsideWindow += 1
  }

  // Mediaan hoe ver de dip voor de piek ligt — maakt de window-bevinding concreet
  // (i.p.v. een triviale "stijging duurt >20m"). Bepaalt hoeveel het venster moet groeien.
  dipMinutesBeforePeak.sort((a, b) => a - b)
  out.dipMedianMinBeforePeak = dipMinutesBeforePeak.length
    ? Math.round(dipMinutesBeforePeak[Math.floor(dipMinutesBeforePeak.length / 2)])
    : null

  out.caughtPct = out.candidates ? Math.round((out.caught / out.candidates) * 100) : null
  out.missedPct = out.candidates ? Math.round((out.missed / out.candidates) * 100) : null
  return out
}

function syntheticEntries() {
  // ruime baseline 6 (>30m) -> dip 5.2 -> piek 10 -> dal 3.6 (caught: <4.5), 3-min resolutie
  const seq = []
  const block = [
    6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, // ~33m baseline voor de dip
    5.6, 5.2, 5.4, 6.2, 7.5, 8.8, 10, 9.2, 7.8, 6.4, 5.2, 4.3, 3.8, 3.6, 3.9, 4.6, 5.4,
  ]
  let t = 0
  for (const v of block) { seq.push({ date: t * MS_PER_MIN, sgv: Math.round(v * MGDL_PER_MMOL) }); t += 3 }
  return seq
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const res = analyze(syntheticEntries())
    console.log(JSON.stringify(res, null, 2))
    const ok = res.candidates >= 1 && res.caught >= 1
    console.log(`\n${ok ? 'SELF-TEST OK' : 'SELF-TEST FAIL'}`)
    process.exit(ok ? 0 : 1)
  }

  const uri = process.env.MONGODB_URI ?? 'mongodb://nightscout-mongo:27017/nightscout'
  const client = new MongoClient(uri)
  await client.connect()
  try {
    const entries = await client
      .db()
      .collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true } }, { projection: { _id: 0, date: 1, sgv: 1 } })
      .sort({ date: 1 })
      .toArray()
    const res = analyze(entries)
    console.log(JSON.stringify(res, null, 2))
    console.log('\n--- duiding ---')
    console.log(`kandidaten (na artefact-gate): ${res.candidates}  (afgekeurd als artefact: ${res.artifactRejected})`)
    console.log(`  waarvan ECHT hypo (bodem<3.9): ${res.candidatesTrueHypo}`)
    console.log(`selector-blinde vlek: gemist ${res.missed}/${res.candidates} (${res.missedPct}%) — milde daling ${res.missedMildDrop}, traag/laat ${res.missedSlowOrLate}`)
    console.log(`window: dip ligt mediaan ${res.dipMedianMinBeforePeak} min voor de piek; ${res.dipOutsideWindow} buiten [piek-20m].`)
    console.log('  NB: een dip >20m voor de piek is deels verwacht (maaltijdstijging duurt >20m); de mediaan zegt hoeveel het venster moet groeien.')
  } finally {
    await client.close()
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
