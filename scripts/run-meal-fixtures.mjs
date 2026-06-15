import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectMealState, MEAL_DEFAULTS, timelineFromMmolReadings } from './lib/meal-detector.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(here, 'meal-fixtures')
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0)

const files = readdirSync(fixturesDir).filter((file) => file.endsWith('.json')).sort()
let failures = 0

for (const file of files) {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'))
  if (!fixture.expect || !Object.hasOwn(fixture.expect, 'phase')) {
    throw new Error(`${file}: fixture.expect.phase is verplicht; gebruik null voor geen maaltijd`)
  }
  if (!Array.isArray(fixture.readings) || fixture.readings.length < 2) {
    throw new Error(`${file}: fixture.readings moet minimaal 2 metingen bevatten`)
  }
  for (let index = 0; index < fixture.readings.length; index += 1) {
    const entry = fixture.readings[index]
    if (!Number.isFinite(Number(entry.minutesAgo)) || !Number.isFinite(Number(entry.mmol))) {
      throw new Error(`${file}: reading ${index} moet numerieke minutesAgo en mmol hebben`)
    }
    if (index > 0 && Number(entry.minutesAgo) >= Number(fixture.readings[index - 1].minutesAgo)) {
      throw new Error(`${file}: readings moeten van oud naar nieuw staan met dalende minutesAgo`)
    }
  }
  const readings = timelineFromMmolReadings(fixture.readings, NOW)
  let episode = fixture.initialEpisode || null
  const result = detectMealState(readings, {
    calibration: { ...MEAL_DEFAULTS, ...(fixture.calibration || {}) },
    nowMs: NOW,
    loadMealEpisode: () => episode,
    saveMealEpisode: (nextEpisode) => { episode = nextEpisode },
    clearMealEpisode: () => { episode = null },
  })

  const expectedPhase = fixture.expect?.phase ?? null
  const actualPhase = result?.phase ?? null
  const checks = [
    { ok: actualPhase === expectedPhase, label: `phase=${expectedPhase}` },
  ]
  if (fixture.expect?.speed) {
    checks.push({ ok: result?.speed === fixture.expect.speed, label: `speed=${fixture.expect.speed}` })
  }
  if (Object.hasOwn(fixture.expect, 'fromMemory')) {
    checks.push({ ok: Boolean(result?.fromMemory) === fixture.expect.fromMemory, label: `fromMemory=${fixture.expect.fromMemory}` })
  }

  const passed = checks.every((check) => check.ok)
  if (!passed) failures += 1

  console.log(`\n${passed ? 'OK' : 'FAIL'} ${fixture.name} -> phase=${actualPhase}${result?.speed ? ` speed=${result.speed}` : ''}`)
  console.log(`   ${fixture.description}`)
  for (const check of checks) console.log(`   ${check.ok ? 'ok' : 'FAIL'}: ${check.label}`)
  if (result) {
    console.log(`   details: ${JSON.stringify({
      minutesSinceMeal: result.minutesSinceMeal,
      minutesSincePeak: result.minutesSincePeak,
      riseFromTrough: result.riseFromTrough,
      dropFromPeak: result.dropFromPeak,
      dropRate: result.dropRate,
      sustainedRisePoints: result.sustainedRisePoints,
    })}`)
  }
}

console.log(`\n${failures === 0 ? 'ALLE MAALTIJD-FIXTURES OK' : `${failures} MAALTIJD-FIXTURE(S) GEFAALD`} (${files.length} totaal)`)
process.exit(failures === 0 ? 0 : 1)
