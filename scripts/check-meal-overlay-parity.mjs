import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as lib from './lib/meal-detector.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const overlaySource = readFileSync(join(repo, 'nightscout-overlay/rate-overlay.js'), 'utf8')
const moduleSource = readFileSync(join(here, 'lib/meal-detector.mjs'), 'utf8')

// ---------------------------------------------------------------------------
// Deel 1: snelle substring-canaries.
// Goedkoop en leesbaar; vangen een hernoemde drempel meteen. Niet voldoende op
// zichzelf (alleen de geplukte regels), daarom volgt hieronder de gedragstest.
// ---------------------------------------------------------------------------
const canaries = [
  {
    label: 'sustained rise threshold',
    overlay: 'mmol(Number(entry.sgv)) >= troughMmol + 0.45',
    module: 'mmol(Number(entry.sgv)) >= troughMmol + 0.45',
  },
  {
    label: 'sustained rise point count',
    overlay: 'var sustainedRise = sustainedRisePoints >= 2;',
    module: 'const sustainedRise = sustainedRisePoints >= 2',
  },
  {
    label: 'fast rising gate',
    overlay: 'var fastGate = rate10 !== null && rate10 >= cal.slowRate && riseFromTrough >= 0.5 && ageMin >= 5 && sustainedRise;',
    module: 'const fastGate = rate10 !== null && rate10 >= cal.slowRate && riseFromTrough >= 0.5 && ageMin >= 5 && sustainedRise',
  },
  {
    label: 'medium rising gate',
    overlay: 'var medium = riseFromTrough >= 0.6 && ageMin >= 10 && sustainedRise && (rate10 === null || rate10 >= 0.04 || riseFromTrough >= 1.2);',
    module: 'const medium = riseFromTrough >= 0.6 && ageMin >= 10 && sustainedRise && (rate10 === null || rate10 >= 0.04 || riseFromTrough >= 1.2)',
  },
  {
    label: 'slow rising gate',
    overlay: 'var slow = riseFromTrough >= 0.9 && ageMin >= 25 && sustainedRise;',
    module: 'const slow = riseFromTrough >= 0.9 && ageMin >= 25 && sustainedRise',
  },
  {
    label: 'rising output includes sustainedRisePoints',
    overlay: 'sustainedRisePoints: sustainedRisePoints',
    module: 'sustainedRisePoints,',
  },
  {
    label: 'meal trough window',
    overlay: 'var MEAL_TROUGH_WINDOW_MS = 60 * 60000;',
    module: 'export const MEAL_TROUGH_WINDOW_MS = 60 * 60_000',
  },
]

const canaryFailures = canaries.filter((check) => !overlaySource.includes(check.overlay) || !moduleSource.includes(check.module))
const canaryFailedLabels = new Set(canaryFailures.map((check) => check.label))
for (const check of canaries) {
  console.log(`${canaryFailedLabels.has(check.label) ? 'FAIL' : 'OK'} canary: ${check.label}`)
}

// ---------------------------------------------------------------------------
// Deel 2: gedragspariteit.
// De live overlay (rate-overlay.js) heeft een eigen handgeschreven kopie van de
// detector; de lib wordt in productie NIET geimporteerd. Hier snijden we de
// echte overlay-functies uit de broncode (brace-matching, geen handkopie),
// draaien ze in een sandbox met geinjecteerde deps + controleerbare Date.now,
// en eisen identiek gedrag t.o.v. de lib over een brede scenario-batterij.
// Faalt de extractie (bv. na refactor naar arrow-functies), dan faalt de check
// luid -- dat is gewenst: het dwingt een herziening van deze guard af.
// ---------------------------------------------------------------------------
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0)
const MGDL_PER_MMOL = 18.0182

function extractFunction(name) {
  const re = new RegExp(`function ${name}\\s*\\(`)
  const match = re.exec(overlaySource)
  if (!match) throw new Error(`overlay-functie ${name} niet gevonden (parity-extractie kapot?)`)
  const open = overlaySource.indexOf('{', match.index)
  let depth = 0
  for (let i = open; i < overlaySource.length; i += 1) {
    if (overlaySource[i] === '{') depth += 1
    else if (overlaySource[i] === '}') {
      depth -= 1
      if (depth === 0) return overlaySource.slice(match.index, i + 1)
    }
  }
  throw new Error(`onbalans in overlay-functie ${name}`)
}

const overlayFunctions = ['mmol', 'readingTime', 'findBaseline', 'updateMealEpisodeMemory', 'mealFromEpisodeMemory', 'detectMealState', 'projectReactiveNadir', 'classifyMealRisk', 'scoreReactiveMealRisk']
  .map(extractFunction)
  .join('\n\n')

// Sandbox: de overlay-functies met de constanten/deps die ze uit de IIFE-scope
// verwachten. loadMealEpisode bootst de overlay-expiry na zodat de wall-clock
// tak (Date.now) ook meeloopt.
const sandboxSource = `
const MGDL_PER_MMOL = ${MGDL_PER_MMOL};
const MAX_BASELINE_DIFF_MS = 75000;
const MEAL_TROUGH_WINDOW_MS = 60 * 60000;
let __episode = null;
let __now = ${NOW};
const Date = { now: () => __now };
let __cal = null;
function loadMealCalibration() { return __cal; }
function loadMealEpisode() {
  const episode = __episode;
  if (!episode || episode.schemaVersion !== 1) return null;
  if (!Number.isFinite(Number(episode.expiresAt)) || Date.now() > Number(episode.expiresAt)) return null;
  return episode;
}
function saveMealEpisode(episode) { __episode = episode; }
function clearMealEpisode() { __episode = null; }
${overlayFunctions}
export function run(readings, cal, episode, nowMs, signals) {
  __cal = cal; __episode = episode || null; __now = nowMs;
  const result = detectMealState(readings);
  const risk = scoreReactiveMealRisk(result, cal, signals ? signals.hypoRisk : null, signals ? signals.peakSignal : null);
  return { result, episode: __episode, risk };
}
`
const sandboxUrl = 'data:text/javascript;base64,' + Buffer.from(sandboxSource).toString('base64')
const overlay = await import(sandboxUrl)

function runLib(readings, cal, episode, nowMs, signals) {
  let stored = episode || null
  const loadMealEpisode = () => {
    const current = stored
    if (!current || current.schemaVersion !== 1) return null
    if (!Number.isFinite(Number(current.expiresAt)) || nowMs > Number(current.expiresAt)) return null
    return current
  }
  const result = lib.detectMealState(readings, {
    calibration: cal,
    nowMs,
    loadMealEpisode,
    saveMealEpisode: (next) => { stored = next },
    clearMealEpisode: () => { stored = null },
  })
  const risk = lib.scoreReactiveMealRisk(result, cal, signals ? signals.hypoRisk : null, signals ? signals.peakSignal : null)
  return { result, episode: stored, risk }
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null
}

function normalizeEpisode(episode) {
  if (!episode) return null
  // Volledige boekhouding vergelijken, niet alleen phase/peak: drift in
  // baseline/trough/expiry hoort de guard ook te vangen, niet pas wanneer het
  // toevallig de fase in een latere stap omslaat.
  return {
    phase: episode.phase ?? null,
    startedAt: episode.startedAt ?? null,
    troughTime: episode.troughTime ?? null,
    troughMmol: round(episode.troughMmol),
    baselineMmol: round(episode.baselineMmol),
    peakTime: episode.peakTime ?? null,
    peakMmol: round(episode.peakMmol),
    expiresAt: episode.expiresAt ?? null,
  }
}

function normalize({ result, episode, risk }) {
  const r = result
  return {
    phase: r?.phase ?? null,
    speed: r?.speed ?? null,
    fromMemory: Boolean(r?.fromMemory),
    minutesSinceMeal: r?.minutesSinceMeal ?? null,
    minutesSincePeak: r?.minutesSincePeak ?? null,
    riseFromTrough: round(r?.riseFromTrough),
    dropFromPeak: round(r?.dropFromPeak),
    dropRate: round(r?.dropRate),
    preDipMmol: round(r?.preDipMmol),
    expectedDipAt: r?.expectedDipAt ?? null,
    episode: normalizeEpisode(episode),
    risk: risk ? { score: risk.score, level: risk.level } : null,
  }
}

function mkReadings(points) {
  return points
    .map((point) => ({ date: NOW - point.minutesAgo * 60000, sgv: Math.round(point.mmol * MGDL_PER_MMOL) }))
    .sort((a, b) => b.date - a.date)
}

function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }
}

function randomWalk(seed, count, start) {
  const rnd = seededRandom(seed)
  const points = []
  let value = start
  for (let i = count - 1; i >= 0; i -= 1) {
    value += (rnd() - 0.5) * 0.6
    value = Math.max(2.2, Math.min(16, value))
    points.push({ minutesAgo: i * 5, mmol: value })
  }
  return mkReadings(points)
}

function mealCurve(seed) {
  const rnd = seededRandom(seed)
  const trough = 4 + rnd() * 1.5
  const rise = 1.5 + rnd() * 3
  const peak = trough + rise
  const riseMin = 25 + Math.floor(rnd() * 30)
  const fallMin = 30 + Math.floor(rnd() * 40)
  const undershoot = rnd() * 1.2
  const total = riseMin + fallMin
  const points = []
  for (let m = total; m >= 0; m -= 5) {
    let value
    if (m > total - riseMin) {
      value = trough + rise * Math.min(1, (total - m) / riseMin)
    } else {
      value = peak - (rise + undershoot) * Math.min(1, (total - riseMin - m) / fallMin)
    }
    points.push({ minutesAgo: m, mmol: Math.max(2.5, value) })
  }
  return mkReadings(points)
}

const calibration = { ...lib.MEAL_DEFAULTS }
const episodeStates = [
  null,
  { schemaVersion: 1, phase: 'rising', startedAt: NOW - 60 * 60000, troughTime: NOW - 70 * 60000, troughMmol: 4.2, baselineMmol: 4.2, peakTime: NOW - 20 * 60000, peakMmol: 8.5, expiresAt: NOW + 120 * 60000, lastUpdatedAt: NOW - 20 * 60000 },
  { schemaVersion: 1, phase: 'plateau', startedAt: NOW - 90 * 60000, troughTime: NOW - 100 * 60000, troughMmol: 4.0, baselineMmol: 4.0, peakTime: NOW - 40 * 60000, peakMmol: 9.0, expiresAt: NOW + 60 * 60000, lastUpdatedAt: NOW - 40 * 60000 },
  { schemaVersion: 1, phase: 'reactive-drop', startedAt: NOW - 120 * 60000, troughTime: NOW - 130 * 60000, troughMmol: 4.5, baselineMmol: 4.5, peakTime: NOW - 50 * 60000, peakMmol: 9.5, expiresAt: NOW + 30 * 60000, lastUpdatedAt: NOW - 50 * 60000 },
  // verlopen episode: dekt de wall-clock expiry-tak
  { schemaVersion: 1, phase: 'reactive-drop', startedAt: NOW - 300 * 60000, troughTime: NOW - 310 * 60000, troughMmol: 4.5, baselineMmol: 4.5, peakTime: NOW - 200 * 60000, peakMmol: 9.5, expiresAt: NOW - 10 * 60000, lastUpdatedAt: NOW - 200 * 60000 },
]

let compared = 0
let mismatched = 0
const mismatchSamples = []

// Roterende signalen om de peakSignal/hypoRisk-takken van de risico-scoring
// in beide kopieen te raken.
const SIGNALS = [
  null,
  { hypoRisk: { css: 'warning' }, peakSignal: null },
  { hypoRisk: { css: 'urgent' }, peakSignal: { severity: 'high' } },
  { hypoRisk: null, peakSignal: { severity: 'watch' } },
]

function compareStep(label, readings, overlayEpisode, libEpisode, nowMs, signals) {
  const overlayOut = overlay.run(readings, calibration, overlayEpisode, nowMs, signals)
  const libOut = runLib(readings, calibration, libEpisode, nowMs, signals)
  compared += 1
  if (JSON.stringify(normalize(overlayOut)) !== JSON.stringify(normalize(libOut))) {
    mismatched += 1
    if (mismatchSamples.length < 8) mismatchSamples.push({ label, overlay: normalize(overlayOut), lib: normalize(libOut) })
  }
  return { overlayEpisode: overlayOut.episode, libEpisode: libOut.episode }
}

// Sliding replay: loop minuut-voor-minuut over een lange reeks, met een
// voortschrijdend venster en episode-geheugen dat tussen stappen wordt
// meegedragen -- exact zoals productie. Dit veegt door alle drempelgrenzen
// (eenmalige eindpunt-evaluatie deed dat niet) en dekt de geheugen-overgangen.
function replaySeries(label, series, startEpisode) {
  const ascending = [...series].sort((a, b) => a.date - b.date)
  let overlayEpisode = startEpisode ? structuredClone(startEpisode) : null
  let libEpisode = startEpisode ? structuredClone(startEpisode) : null
  for (let i = 6; i < ascending.length; i += 1) {
    const nowMs = ascending[i].date
    const window = ascending.slice(Math.max(0, i - 40), i + 1).sort((a, b) => b.date - a.date)
    const next = compareStep(`${label}@${i}`, window, overlayEpisode, libEpisode, nowMs, SIGNALS[i % SIGNALS.length])
    overlayEpisode = next.overlayEpisode
    libEpisode = next.libEpisode
  }
}

// Lange reeksen (~3-5 u, 5-min raster) zodat de replay genoeg stappen heeft.
const SERIES = 250
for (let seed = 1; seed <= SERIES; seed += 1) {
  replaySeries(`walk-${seed}`, randomWalk(seed, 60, 4 + (seed % 8)), null)
  replaySeries(`meal-${seed}`, mealCurve(seed * 17 + 1), null)
  const episode = episodeStates[seed % episodeStates.length]
  replaySeries(`mem-walk-${seed}`, randomWalk(seed * 7 + 3, 60, 6 + (seed % 6)), episode)
  replaySeries(`mem-meal-${seed}`, mealCurve(seed * 13 + 5), episode)
}

console.log(`\nbehavioral parity: ${compared - mismatched}/${compared} identiek`)
for (const sample of mismatchSamples) {
  console.log(`FAIL parity: ${sample.label}`)
  console.log(`   overlay ${JSON.stringify(sample.overlay)}`)
  console.log(`   lib     ${JSON.stringify(sample.lib)}`)
}

const failed = canaryFailures.length > 0 || mismatched > 0
if (failed) {
  console.error(`\n${canaryFailures.length} canary + ${mismatched} gedrags-divergentie(s) gevonden`)
  process.exit(1)
}

console.log('\nMEAL OVERLAY PARITY OK')
