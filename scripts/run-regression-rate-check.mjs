// Smoke-test voor de tijd-gewogen kleinste-kwadraten helling (regressie-modus) in
// nightscout-overlay/rate-overlay.js. rate-overlay.js draait als browser-IIFE (raakt
// document/localStorage bij load), dus de kernformule wordt hier identiek gespiegeld en
// de eigenschappen vastgepind: (a) gladder dan 2-punts op ruisige/vlakke data,
// (b) reageert binnen ~3 min op een knik, (c) continu (geen 0.0555-kwantisatie).
//
// Houd in sync met regressionSlope() in rate-overlay.js.

const MGDL_PER_MMOL = 18.0182
const MS_PER_MIN = 60_000
const REG_TAU_FRACTION = 0.6
const REG_TAU_MAX_MS = 12 * MS_PER_MIN
const REG_MIN_POINTS = 3
const MAX_BASELINE_DIFF_MS = 75_000

const mmol = (mgdl) => mgdl / MGDL_PER_MMOL

// Spiegelt regressionSlope() uit rate-overlay.js.
function regressionSlope(readings, latestTime, windowMs, tauMs) {
  const tau = tauMs && tauMs > 0 ? tauMs : windowMs * REG_TAU_FRACTION
  const minT = latestTime - windowMs
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0
  for (const r of readings) {
    const t = r.date
    if (!Number.isFinite(t) || t > latestTime || t < minT) continue
    const x = (t - latestTime) / MS_PER_MIN
    const y = mmol(r.sgv)
    const w = Math.exp((t - latestTime) / tau)
    sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y; n += 1
  }
  if (n < REG_MIN_POINTS) return null
  const denom = sw * sxx - sx * sx
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-9) return null
  const slope = (sw * sxy - sx * sy) / denom
  return Number.isFinite(slope) ? { slope, n } : null
}

// 2-punts referentie (zoals calculateRows/calculateMomentRows).
function twoPointSlope(readings, latestTime, minutesBack) {
  const target = latestTime - minutesBack * MS_PER_MIN
  let base = null, bestDiff = Infinity
  for (const r of readings) {
    if (r.date >= latestTime) continue
    const d = Math.abs(r.date - target)
    if (d < bestDiff) { bestDiff = d; base = r }
  }
  if (!base || bestDiff > MAX_BASELINE_DIFF_MS) return null
  const latest = readings.reduce((a, b) => (b.date <= latestTime && b.date > a.date ? b : a))
  return mmol(latest.sgv - base.sgv) / ((latestTime - base.date) / MS_PER_MIN)
}

const now = Date.UTC(2026, 5, 18, 12, 0, 0)
function series(values) {
  // values[0] = oudste; 1-min spacing, eindigt op nu.
  return values.map((sgv, i) => ({
    date: now - (values.length - 1 - i) * MS_PER_MIN,
    sgv,
    type: 'sgv',
  }))
}
const regWindow = 15 * MS_PER_MIN
const regTau = Math.min(regWindow, REG_TAU_MAX_MS) * REG_TAU_FRACTION

function fail(msg) { throw new Error(msg) }

// (a) Ruisige vlakke lijn: regressie moet duidelijk gladder dan 2-punts.
// Echte ~vlakke trend met ±1 mg/dL meet-ruis (kwantisatie).
const flat = series([110, 111, 110, 109, 110, 111, 110, 109, 110, 111, 110, 109, 110, 111, 110])
const regFlat = regressionSlope(flat, now, regWindow, regTau)
if (!regFlat) fail('regressie gaf null op de vlakke serie')
// 2-punts spreiding over korte vensters (1-5m): de ruis-amplitude.
const tp = []
for (let m = 1; m <= 5; m++) {
  const s = twoPointSlope(flat, now, m)
  if (Number.isFinite(s)) tp.push(s)
}
const tpSpread = Math.max(...tp) - Math.min(...tp)
if (!(Math.abs(regFlat.slope) < tpSpread)) {
  fail(`Verwacht |regressie| (${regFlat.slope.toFixed(4)}) < 2-punts-spreiding (${tpSpread.toFixed(4)})`)
}
if (!(Math.abs(regFlat.slope) < 0.02)) {
  fail(`Vlakke serie: verwacht |helling| ~0, kreeg ${regFlat.slope.toFixed(4)}`)
}

// (b) Knik: 10 min vlak, dan een daling van 3 mg/dL/min over de laatste 3 min.
// Zo consumeert de alarm-basis het: het korte venster (~5m, getPrimaryRate) reageert
// snel, terwijl het lange venster (15m) bewust gedempt blijft (ruisrobuust).
const knik = series([110, 110, 110, 110, 110, 110, 110, 110, 110, 110, 107, 104, 101])
const shortWindow = 5 * MS_PER_MIN
const regShort = regressionSlope(knik, now, shortWindow, shortWindow * REG_TAU_FRACTION)
const regLong = regressionSlope(knik, now, regWindow, regTau)
if (!regShort || !regLong) fail('regressie gaf null op de knik-serie')
if (!(regShort.slope < -0.1)) {
  fail(`Knik: kort venster moet snel dalen, kreeg ${regShort.slope.toFixed(4)}`)
}
if (!(regLong.slope > regShort.slope)) {
  fail(`Knik: lang venster (${regLong.slope.toFixed(4)}) moet gedempter zijn dan kort (${regShort.slope.toFixed(4)})`)
}

// (c) Continu: een realistische daling van ~3 mg/dL/min met natuurlijke variatie per
// minuut (2-4 mg/dL stappen). De regressie middelt dat tot een continue helling, niet
// een vastgeklikt veelvoud van 0.0555 (waar elke losse 2-punts-stap wél op klikt).
const dalend = series([140, 137, 135, 131, 128, 126, 122, 119, 115, 113, 110, 106, 104, 101, 97])
const regDal = regressionSlope(dalend, now, regWindow, regTau)
if (!regDal) fail('regressie gaf null op de dalende serie')
const quantum = 1 / MGDL_PER_MMOL // 0.0555 mmol/min stap bij 1-min 2-punts
const nearestK = Math.round(regDal.slope / quantum)
const offGrid = Math.abs(regDal.slope - nearestK * quantum)
if (!(offGrid > 1e-6)) {
  fail(`Verwacht continue helling (niet op het 0.0555-raster), kreeg ${regDal.slope.toFixed(6)}`)
}
if (!(regDal.slope < -0.14 && regDal.slope > -0.18)) {
  fail(`Dalende serie: verwacht ~-0.166 mmol/min, kreeg ${regDal.slope.toFixed(4)}`)
}

console.log('regression-rate-check OK')
console.log(`  vlak:   helling ${regFlat.slope.toFixed(4)} mmol/min  (2-punts spreiding ${tpSpread.toFixed(4)})`)
console.log(`  knik:   kort ${regShort.slope.toFixed(4)} / lang ${regLong.slope.toFixed(4)} mmol/min  (kort reageert, lang dempt)`)
console.log(`  dalend: helling ${regDal.slope.toFixed(4)} mmol/min  (continu, off-grid)`)
