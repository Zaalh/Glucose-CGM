// Pure builder voor de intraday "Glucose Events"-feed (History-tab).
//
// Zet één dag-timeline om in een gesorteerde stroom van betekenisvolle events:
// eerste meting, lokale pieken, high-episodes (>10), herstel naar bereik en
// stabiele (laag-variabele) vensters. Geen database/I-O — een timeline in,
// events uit — zodat de live sync, de feed-endpoint én de test dezelfde logica delen.
//
// Timeline-formaat (oplopend op tijd): { date: <ms>, sgv: <mg/dL> }.

import { MGDL_PER_MMOL, round } from './hypo-features.mjs'

const MS_PER_MIN = 60_000

export const DEFAULT_EVENT_OPTIONS = {
  highMmol: 10.0, // boven = high
  lowMmol: 3.9, // onder = low
  minRiseMmol: 1.0, // lokale piek moet zoveel boven het voorafgaande dal liggen
  minDropMmol: 1.0, // lokale daling moet zoveel onder de voorafgaande piek liggen
  riseLookbackMin: 60, // venster om dat dal te zoeken
  dropLookbackMin: 90, // venster om die piek te zoeken
  dropCooldownMin: 30, // voorkom meerdere events voor dezelfde afdaling
  highMinMinutes: 15, // high-run telt vanaf deze duur ...
  highMinCount: 3, // ... of dit aantal metingen
  stableWindowMin: 45, // minimale lengte van een stabiel venster
  stableMaxCvPct: 12, // CV-grens voor "low variability"
  gapMinutes: 30, // datagat onderbreekt runs/vensters
}

function mmol(entry) {
  return Number(entry.sgv) / MGDL_PER_MMOL
}

function isoOf(entry) {
  return entry.dateString || new Date(entry.date).toISOString()
}

// Lokale piek: niemand binnen ~10 min ervoor/erna ligt hoger.
function isLocalPeak(timeline, i) {
  const here = Number(timeline[i].sgv)
  const from = timeline[i].date - 10 * MS_PER_MIN
  const to = timeline[i].date + 10 * MS_PER_MIN
  for (let j = i - 1; j >= 0 && timeline[j].date >= from; j -= 1) {
    if (Number(timeline[j].sgv) > here) return false
  }
  for (let j = i + 1; j < timeline.length && timeline[j].date <= to; j += 1) {
    if (Number(timeline[j].sgv) > here) return false
  }
  return true
}

// Laagste waarde in het lookback-venster vóór index i (voor de stijghoogte).
function troughBefore(timeline, i, lookbackMin) {
  const from = timeline[i].date - lookbackMin * MS_PER_MIN
  let lo = mmol(timeline[i])
  for (let j = i - 1; j >= 0 && timeline[j].date >= from; j -= 1) {
    const v = mmol(timeline[j])
    if (v < lo) lo = v
  }
  return lo
}

// Hoogste waarde in het lookback-venster vóór index i (voor de daalhoogte).
function peakBefore(timeline, i, lookbackMin) {
  const from = timeline[i].date - lookbackMin * MS_PER_MIN
  let hi = mmol(timeline[i])
  let hiAt = timeline[i]
  for (let j = i - 1; j >= 0 && timeline[j].date >= from; j -= 1) {
    const v = mmol(timeline[j])
    if (v > hi) { hi = v; hiAt = timeline[j] }
  }
  return { mmol: hi, at: hiAt }
}

// Hoofd-entree: bouwt de event-stroom uit een dag-timeline.
export function buildGlucoseEvents(timeline, options = {}) {
  const opt = { ...DEFAULT_EVENT_OPTIONS, ...options }
  const tl = (timeline || []).filter((e) => Number.isFinite(Number(e?.sgv)) && Number.isFinite(Number(e?.date))).slice().sort((a, b) => a.date - b.date)
  const events = []
  if (!tl.length) return events

  // Eerste meting van de dag (nuchtere glucose).
  events.push({
    type: 'first_reading',
    at: isoOf(tl[0]),
    mmol: round(mmol(tl[0]), 1),
    label: 'Eerste meting van de dag',
    detail: 'Nuchtere glucose',
  })

  // High-runs (>highMmol): markeer de runs zodat lokale pieken erbinnen niet
  // dubbel als gewone piek verschijnen; high krijgt eigen event + herstel.
  const inHighRun = new Array(tl.length).fill(false)
  let runStart = null
  for (let i = 0; i < tl.length; i += 1) {
    const isHigh = mmol(tl[i]) > opt.highMmol
    const gap = i > 0 ? (tl[i].date - tl[i - 1].date) / MS_PER_MIN : 0
    if (isHigh && runStart === null) runStart = i
    if (runStart !== null && (!isHigh || gap > opt.gapMinutes || i === tl.length - 1)) {
      const endIdx = (!isHigh || gap > opt.gapMinutes) ? i - 1 : i
      if (endIdx >= runStart) {
        const durationMin = Math.max(1, Math.round((tl[endIdx].date - tl[runStart].date) / MS_PER_MIN))
        const count = endIdx - runStart + 1
        if (durationMin >= opt.highMinMinutes || count >= opt.highMinCount) {
          // Piek binnen de run.
          let pIdx = runStart
          for (let j = runStart; j <= endIdx; j += 1) { if (mmol(tl[j]) > mmol(tl[pIdx])) pIdx = j; inHighRun[j] = true }
          const rise = mmol(tl[pIdx]) - troughBefore(tl, runStart, opt.riseLookbackMin)
          const onsetMin = Math.max(1, (tl[pIdx].date - tl[runStart].date) / MS_PER_MIN)
          events.push({
            type: 'high_episode',
            at: isoOf(tl[pIdx]),
            mmol: round(mmol(tl[pIdx]), 1),
            label: 'Stijging gedetecteerd',
            detail: '+' + round(rise / onsetMin, 2) + ' mmol/L/min · ' + durationMin + ' min boven ' + opt.highMmol,
            badge: 'high episode',
            peakAt: isoOf(tl[pIdx]),
            durationMinutes: durationMin,
          })
          // Herstel naar bereik: eerste meting na de run onder de high-grens.
          const recIdx = endIdx + 1
          if (recIdx < tl.length && mmol(tl[recIdx]) <= opt.highMmol) {
            events.push({
              type: 'recovery_to_range',
              at: isoOf(tl[recIdx]),
              mmol: round(mmol(tl[recIdx]), 1),
              label: 'Terug in bereik',
              detail: 'Onder ' + opt.highMmol + ' mmol/L',
              badge: 'in range',
            })
          }
        }
      }
      runStart = isHigh ? i : null
    }
  }

  // Lokale pieken buiten high-runs (betekenisvolle stijging vanaf het dal).
  for (let i = 1; i < tl.length - 1; i += 1) {
    if (inHighRun[i]) continue
    if (!isLocalPeak(tl, i)) continue
    const rise = mmol(tl[i]) - troughBefore(tl, i, opt.riseLookbackMin)
    if (rise < opt.minRiseMmol) continue
    events.push({
      type: 'rise_local_peak',
      at: isoOf(tl[i]),
      mmol: round(mmol(tl[i]), 1),
      label: 'Stijging gedetecteerd',
      detail: round(mmol(tl[i]), 1) + ' mmol/L · lokale piek',
    })
  }

  // Lokale dalingen: markeer betekenisvolle dalen na een voorafgaande piek. Dit
  // staat los van de hypo-episodebuilder; ook een niet-hypo daling hoort in de feed.
  let lastDropEventAt = null
  for (let i = 1; i < tl.length - 1; i += 1) {
    const here = Number(tl[i].sgv)
    const prev = Number(tl[i - 1].sgv)
    const next = Number(tl[i + 1].sgv)
    if (!(here < prev && here <= next)) continue
    if (lastDropEventAt !== null && (tl[i].date - lastDropEventAt) / MS_PER_MIN < opt.dropCooldownMin) continue
    const peak = peakBefore(tl, i, opt.dropLookbackMin)
    const drop = peak.mmol - mmol(tl[i])
    if (drop < opt.minDropMmol) continue
    const minutes = Math.max(1, (tl[i].date - peak.at.date) / MS_PER_MIN)
    events.push({
      type: 'fall_local_trough',
      at: isoOf(tl[i]),
      mmol: round(mmol(tl[i]), 1),
      label: 'Daling gedetecteerd',
      detail: '-' + round(drop, 1) + ' mmol vanaf piek · ' + round(-(drop / minutes), 2) + ' mmol/L/min',
      peakAt: isoOf(peak.at),
    })
    lastDropEventAt = tl[i].date
  }

  // Stabiele vensters: niet-overlappende segmenten van >= stableWindowMin met
  // lage CV en geen high/low. Emit één event per segment (op het midden).
  let s = 0
  while (s < tl.length) {
    let e = s
    const vals = [mmol(tl[s])]
    while (e + 1 < tl.length) {
      const gap = (tl[e + 1].date - tl[e].date) / MS_PER_MIN
      const v = mmol(tl[e + 1])
      if (gap > opt.gapMinutes || v > opt.highMmol || v < opt.lowMmol) break
      e += 1
      vals.push(v)
    }
    const spanMin = (tl[e].date - tl[s].date) / MS_PER_MIN
    if (spanMin >= opt.stableWindowMin && vals.length >= 3) {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length)
      const cv = mean ? (sd / mean) * 100 : 100
      if (cv <= opt.stableMaxCvPct) {
        const midIdx = Math.floor((s + e) / 2)
        events.push({
          type: 'stable_window',
          at: isoOf(tl[midIdx]),
          mmol: round(mean, 1),
          label: 'Stabiel venster',
          detail: 'Laag-variabel venster · CV ' + round(cv, 0) + '% · ' + Math.round(spanMin) + ' min',
        })
      }
    }
    s = e + 1
  }

  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return events
}
