// Gedeelde, pure kern voor de rebound-forecast (post-nadir herstel).
//
// Eén bron van waarheid voor zowel de offline profiel-generator
// (scripts/build-rebound-profile.mjs) als de shadow-evaluator
// (scripts/evaluate-rebound-forecast.mjs) — zo blijven train en serve gelijk,
// net als bij de V2-detector (zie scripts/lib/episode-similarity.mjs).
//
// Kernbevinding uit het onderzoek (zie memory rebound-forecast-research):
// de rebound-piek correleert NIET met de dip-diepte/drop/dalingssnelheid
// (alle |r|<0.2) — counter-regulatie brengt je telkens terug naar een
// persoonlijk set-point (~7.3 mmol). Daarom is de forecast simpelweg een
// vaste, empirische herstelcurve (absolute mmol per horizon) met een band,
// verankerd op het tijdstip van de nadir. Out-of-sample geverifieerd:
// MAE +15/+30/+45/+60 = 0.77/1.05/1.28/1.22 mmol, geen overfit.

import { MGDL_PER_MMOL } from './hypo-features.mjs'

// Horizonten (minuten na de nadir) waarop we de curve bemonsteren. 0..90 zodat
// de volledige band getoond kan worden; de forecast-waarde zit op +15..+60.
export const REBOUND_HORIZONS = Array.from({ length: 19 }, (_, i) => i * 5) // 0,5,...,90
// Tolerantie bij het matchen van een meting op een horizon (CGM ~1-5 min raster).
export const REBOUND_SAMPLE_TOL_MS = 5 * 60_000
// Minimaal aantal samples per horizon voordat we er een quantiel op vertrouwen.
export const REBOUND_MIN_SAMPLES = 12
// Kern-horizonten die een curve MOET hebben om mee te tellen. Zonder deze eis
// wordt elke horizon over een andere (scheve) subset episodes berekend, wat een
// niet-monotone, onbetrouwbare mediaan-curve geeft (episodes met datagaten op de
// late horizonten trekken die omlaag). De gevalideerde research gebruikte
// complete curves; dit dwingt diezelfde consistente set af.
export const REBOUND_REQUIRED_HORIZONS = [0, 15, 30, 45, 60]
// Een "bevestigde nadir" telt als reactieve dip als hij hieronder dook.
export const REBOUND_ANCHOR_MMOL = 4.5

// ---- kleine statistiek-helpers (lineair geïnterpoleerde quantielen) ----
export function quantile(arr, p) {
  if (!arr.length) return NaN
  const s = [...arr].sort((a, b) => a - b)
  const i = (s.length - 1) * p
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return s[lo] + (s[hi] - s[lo]) * (i - lo)
}
export const median = (a) => quantile(a, 0.5)
export const meanAbsError = (vals, pred) =>
  vals.length ? vals.reduce((s, v) => s + Math.abs(v - pred), 0) / vals.length : NaN

// Filtert episodes tot de set die we voor herstel-statistiek vertrouwen.
// Spiegelt exact het onderzoeksfilter (research-rebound-forecast.mjs).
export function isUsableReboundEpisode(ep) {
  return Boolean(
    ep &&
      Number(ep.nadirMmol) < REBOUND_ANCHOR_MMOL &&
      ep.recoveryMinutes != null &&
      ep.reboundPeakMmol != null &&
      Number.isFinite(Date.parse(ep.nadirAt)) &&
      Number(ep.qualityScore ?? 0) >= 60 &&
      !(ep.qualityFlags ?? []).includes('possible_compression_low'),
  )
}

// Zet ruwe Nightscout-entries om naar een oplopend gesorteerde {t, v(mmol)}-reeks.
export function prepareEntries(rawEntries) {
  return rawEntries
    .filter((e) => Number.isFinite(Number(e.date)) && Number.isFinite(Number(e.sgv)))
    .map((e) => ({ t: Number(e.date), v: Number(e.sgv) / MGDL_PER_MMOL }))
    .sort((a, b) => a.t - b.t)
}

// Dichtstbijzijnde meting bij `targetMs`, of null als niets binnen `tolMs` ligt.
// Binaire zoek; `entries` moet oplopend gesorteerd zijn (prepareEntries).
export function sampleAt(entries, targetMs, tolMs = REBOUND_SAMPLE_TOL_MS) {
  let lo = 0
  let hi = entries.length - 1
  let best = null
  let bestDiff = Infinity
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    const diff = entries[m].t - targetMs
    if (Math.abs(diff) < bestDiff) {
      bestDiff = Math.abs(diff)
      best = entries[m]
    }
    if (diff < 0) lo = m + 1
    else hi = m - 1
  }
  return bestDiff <= tolMs ? best.v : null
}

// Haalt per bruikbare episode de absolute herstelwaarden op elke horizon op.
// Geeft één rij per episode terug: { nadirT, nadirMmol, peakMmol, night, byHorizon }.
// Door dit te delen tussen generator en evaluator blijft extractie identiek.
export function extractRecoverySamples(episodes, preparedEntries, opts = {}) {
  const horizons = opts.horizons ?? REBOUND_HORIZONS
  const tolMs = opts.tolMs ?? REBOUND_SAMPLE_TOL_MS
  const requireHorizons = opts.requireHorizons ?? REBOUND_REQUIRED_HORIZONS
  const rows = []
  for (const ep of episodes) {
    if (!isUsableReboundEpisode(ep)) continue
    const nadirT = Date.parse(ep.nadirAt)
    const byHorizon = {}
    for (const h of horizons) {
      byHorizon[h] = sampleAt(preparedEntries, nadirT + h * 60_000, tolMs)
    }
    // Alleen complete curves: elke vereiste kern-horizon moet bemonsterd zijn.
    if (requireHorizons.some((h) => byHorizon[h] == null)) continue
    rows.push({
      nadirT,
      nadirMmol: Number(ep.nadirMmol),
      peakMmol: Number(ep.peakMmol),
      reboundPeakMmol: Number(ep.reboundPeakMmol),
      night: Boolean(ep.nightEpisode),
      byHorizon,
    })
  }
  return rows
}

// Bouwt de band (p10/p25/median/p75/p90 + n) per horizon uit een set sample-rijen.
// Horizonten met < minSamples worden overgeslagen (te weinig bewijs).
export function bandFromSamples(rows, opts = {}) {
  const horizons = opts.horizons ?? REBOUND_HORIZONS
  const minSamples = opts.minSamples ?? REBOUND_MIN_SAMPLES
  const out = []
  for (const h of horizons) {
    const vals = rows.map((r) => r.byHorizon[h]).filter((v) => v != null)
    if (vals.length < minSamples) continue
    out.push({
      minute: h,
      n: vals.length,
      p10: round2(quantile(vals, 0.1)),
      p25: round2(quantile(vals, 0.25)),
      median: round2(median(vals)),
      p75: round2(quantile(vals, 0.75)),
      p90: round2(quantile(vals, 0.9)),
    })
  }
  return out
}

const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)

// Volledig profiel-artefact (geschreven naar scripts/rebound-recovery-profile.json).
export function buildReboundProfile(episodes, rawEntries, opts = {}) {
  const horizons = opts.horizons ?? REBOUND_HORIZONS
  const minSamples = opts.minSamples ?? REBOUND_MIN_SAMPLES
  const prepared = Array.isArray(rawEntries) && rawEntries.length && rawEntries[0].t != null
    ? rawEntries
    : prepareEntries(rawEntries)

  const rows = extractRecoverySamples(episodes, prepared, { horizons, tolMs: opts.tolMs })
  const curve = bandFromSamples(rows, { horizons, minSamples })

  const reboundPeaks = episodes.filter(isUsableReboundEpisode).map((e) => Number(e.reboundPeakMmol))
  const overshootPct = reboundPeaks.length
    ? round2((100 * reboundPeaks.filter((v) => v >= 10).length) / reboundPeaks.length)
    : null

  const nightRows = rows.filter((r) => r.night)
  const dayRows = rows.filter((r) => !r.night)

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    units: 'mmol/L',
    anchorThresholdMmol: REBOUND_ANCHOR_MMOL,
    sampleToleranceMin: (opts.tolMs ?? REBOUND_SAMPLE_TOL_MS) / 60_000,
    minSamplesPerHorizon: minSamples,
    episodesUsed: rows.length,
    setPointMmol: round2(median(reboundPeaks)),
    overshootHighPct: overshootPct, // % rebound-pieken >= 10 mmol (band-bovenkant kan misleiden)
    curve, // globale band — de gevalideerde forecast
    // Nacht/dag alleen als artefact-context; pas gebruiken zodra n per stratum groot genoeg is.
    nightCurve: bandFromSamples(nightRows, { horizons, minSamples }),
    dayCurve: bandFromSamples(dayRows, { horizons, minSamples }),
  }
}

// Verankert het profiel op een bevestigde nadir en geeft een band met absolute
// tijdstippen terug. Geen afhankelijkheid van de nadir-waarde: het set-point is
// dip-diepte-onafhankelijk (onderzoeksbevinding). Serve-time gebruikt dit bij een
// bevestigde nadir (isBottoming/isRecovering + recentLowMmol < anchorThresholdMmol).
export function forecastReboundBand(profile, nadirTimeMs, opts = {}) {
  if (!profile || !Array.isArray(profile.curve) || !Number.isFinite(nadirTimeMs)) return null
  const curve = opts.night && profile.nightCurve?.length ? profile.nightCurve : profile.curve
  if (!curve.length) return null
  return {
    anchorTimeMs: nadirTimeMs,
    setPointMmol: profile.setPointMmol,
    overshootHighPct: profile.overshootHighPct,
    points: curve.map((p) => ({
      minute: p.minute,
      atMs: nadirTimeMs + p.minute * 60_000,
      p10: p.p10,
      p25: p.p25,
      median: p.median,
      p75: p.p75,
      p90: p.p90,
    })),
  }
}

// Synthetische dataset voor --self-test (geen DB nodig). Bouwt een handvol
// dips met herstel naar ~7 mmol op een 5-min raster.
export function syntheticReboundData(nEpisodes = 30) {
  const episodes = []
  const entries = []
  const base = Date.parse('2026-05-01T08:00:00.000Z')
  const dayMs = 24 * 60 * 60_000
  for (let k = 0; k < nEpisodes; k++) {
    const peakT = base + k * dayMs
    const nadirT = peakT + 45 * 60_000
    const nadirMmol = 3.4 + (k % 5) * 0.2 // 3.4..4.2
    const setPoint = 6.8 + (k % 4) * 0.4 // ~6.8..8.0
    // entries: piek -> nadir -> herstel naar set-point, 5-min raster
    const pushEntry = (t, mmol) => entries.push({ date: t, sgv: Math.round(mmol * MGDL_PER_MMOL) })
    for (let m = -45; m <= 0; m += 5) pushEntry(peakT + (45 + m) * 60_000 - 45 * 60_000, 9 + m * 0.02)
    // herstelcurve (mediaan-achtig): nadir -> set-point over ~40 min, daarna plateau
    const recover = (h) => {
      if (h <= 0) return nadirMmol
      const frac = Math.min(1, h / 40)
      return nadirMmol + (setPoint - nadirMmol) * frac
    }
    for (let h = 0; h <= 90; h += 5) pushEntry(nadirT + h * 60_000, recover(h))
    episodes.push({
      nadirAt: new Date(nadirT).toISOString(),
      peakAt: new Date(peakT).toISOString(),
      nadirMmol,
      peakMmol: 9,
      reboundPeakMmol: setPoint,
      recoveryMinutes: 20,
      maxFallRate30m: -0.3,
      nightEpisode: k % 3 === 0,
      timeOfDayBucket: 'morning',
      qualityScore: 80,
      qualityFlags: [],
    })
  }
  return { episodes, entries }
}
