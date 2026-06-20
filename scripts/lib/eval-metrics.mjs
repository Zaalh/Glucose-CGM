// Gedeelde evaluatie-metrics voor alarm-kwaliteit (één bron, drift-preventie).
// Klinisch, EVENT-niveau: een gebruiker ervaart events (één daling = één alarm),
// niet losse minuten. Zie alarm-kwaliteit-plan.md.

const MGDL_PER_MMOL = 18.0182
const MS_PER_MIN = 60_000
export const mmol = (sgv) => Number(sgv) / MGDL_PER_MMOL
export const round = (x, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d)

// Hypo-EVENT: glucose < thresholdMmol dat ~minMinutes aanhoudt (ruis-tolerant:
// >= fractie van de metingen in het venster onder de drempel). Geeft de onset-tijd.
// timeline: oplopend gesorteerd [{date, sgv}]. Events worden niet dubbel geteld
// (na een event springen we voorbij het lage venster).
export function findHypoEvents(timeline, { thresholdMmol = 3.9, minMinutes = 15, fraction = 0.6 } = {}) {
  const events = []
  let i = 0
  while (i < timeline.length) {
    if (mmol(timeline[i].sgv) >= thresholdMmol) { i += 1; continue }
    const onset = timeline[i].date
    let low = 0
    let total = 0
    let lastIdx = i
    for (let j = i; j < timeline.length; j += 1) {
      if (timeline[j].date > onset + minMinutes * MS_PER_MIN) break
      total += 1
      if (mmol(timeline[j].sgv) < thresholdMmol) low += 1
      lastIdx = j
    }
    if (total >= 2 && low / total >= fraction) {
      let nadir = Infinity
      for (let j = i; j <= lastIdx; j += 1) nadir = Math.min(nadir, mmol(timeline[j].sgv))
      events.push({ onsetMs: onset, nadirMmol: round(nadir) })
      // spring voorbij het lage venster zodat één daling één event is
      let k = lastIdx
      while (k < timeline.length && mmol(timeline[k].sgv) < thresholdMmol) k += 1
      i = Math.max(k, i + 1)
    } else {
      i += 1
    }
  }
  return events
}

// Consolideer een reeks per-meting alarmbeslissingen tot alarm-EVENTS.
// series: oplopend [{ms, alarm:boolean}]. Opeenvolgende alarm-punten met een gat
// <= mergeGapMin vormen één event {startMs, endMs}.
export function consolidateAlarms(series, { mergeGapMin = 15 } = {}) {
  const events = []
  let cur = null
  for (const s of series) {
    if (!s.alarm) continue
    if (cur && s.ms - cur.endMs <= mergeGapMin * MS_PER_MIN) {
      cur.endMs = s.ms
    } else {
      if (cur) events.push(cur)
      cur = { startMs: s.ms, endMs: s.ms }
    }
  }
  if (cur) events.push(cur)
  return events
}

// Event-niveau scoring. Een hypo-event is GEDETECTEERD als een alarm-event actief is in
// [onset - horizon, onset + detectTolerance]. De tolerantie ná de onset vangt sensorlag/
// gelijktijdige detectie (een alarm dat tijdens de daling vuurt telt nog, zij het laat).
// Een alarm-event is GOED als het minstens één hypo-event zo dekt, anders VALS.
// Lead = onset - alarmStart (positief = vroege waarschuwing; negatief = laat/tijdens).
export function scoreEvents(alarmEvents, hypoEvents, { horizonMin = 30, detectToleranceMin = 15, observedDays = null } = {}) {
  const horizon = horizonMin * MS_PER_MIN
  const tol = detectToleranceMin * MS_PER_MIN
  const detected = new Set()
  const goodAlarms = new Set()
  const leads = []
  for (let h = 0; h < hypoEvents.length; h += 1) {
    const o = hypoEvents[h].onsetMs
    for (let a = 0; a < alarmEvents.length; a += 1) {
      const ev = alarmEvents[a]
      // alarm actief in het venster [o - horizon, o + tol]?
      if (ev.endMs >= o - horizon && ev.startMs <= o + tol) {
        detected.add(h)
        goodAlarms.add(a)
        leads.push(Math.max(-detectToleranceMin, Math.min((o - ev.startMs) / MS_PER_MIN, horizonMin)))
      }
    }
  }
  const totalAlarms = alarmEvents.length
  const falseAlarms = totalAlarms - goodAlarms.size
  leads.sort((a, b) => a - b)
  return {
    hypoEvents: hypoEvents.length,
    alarmEvents: totalAlarms,
    detectedHypos: detected.size,
    recall: hypoEvents.length ? round(detected.size / hypoEvents.length) : null,
    precision: totalAlarms ? round(goodAlarms.size / totalAlarms) : null,
    falseAlarms,
    falseAlarmsPerDay: observedDays ? round(falseAlarms / observedDays, 2) : null,
    medianLeadMin: leads.length ? Math.round(leads[Math.floor(leads.length / 2)]) : null,
  }
}

// --- threshold-vrije ranking-helpers (herbruikbaar) -------------------------
export function rocAuc(scored) {
  const pos = scored.filter((s) => s.y === 1).length
  const neg = scored.length - pos
  if (!pos || !neg) return null
  const sorted = scored.slice().sort((a, b) => a.p - b.p)
  let rs = 0
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j < sorted.length && sorted[j].p === sorted[i].p) j += 1
    const ar = (i + 1 + j) / 2
    for (let k = i; k < j; k += 1) if (sorted[k].y === 1) rs += ar
    i = j
  }
  return round((rs - (pos * (pos + 1)) / 2) / (pos * neg))
}
export function averagePrecision(scored) {
  const sorted = scored.slice().sort((a, b) => b.p - a.p)
  const tot = scored.filter((s) => s.y === 1).length
  if (!tot) return null
  let tp = 0, fp = 0, ap = 0, prev = 0
  for (const s of sorted) {
    if (s.y === 1) tp += 1; else fp += 1
    const r = tp / tot
    ap += (tp / (tp + fp)) * (r - prev)
    prev = r
  }
  return round(ap)
}

export const MS_PER_DAY = 24 * 60 * MS_PER_MIN
