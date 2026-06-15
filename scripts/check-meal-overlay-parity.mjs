import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const overlay = readFileSync(join(repo, 'nightscout-overlay/rate-overlay.js'), 'utf8')
const moduleSource = readFileSync(join(here, 'lib/meal-detector.mjs'), 'utf8')

const checks = [
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

const failures = checks.filter((check) => !overlay.includes(check.overlay) || !moduleSource.includes(check.module))
const failedLabels = new Set(failures.map((check) => check.label))

for (const check of checks) {
  const ok = !failedLabels.has(check.label)
  console.log(`${ok ? 'OK' : 'FAIL'} ${check.label}`)
}

if (failures.length) {
  console.error(`\n${failures.length} meal overlay parity check(s) failed`)
  process.exit(1)
}

console.log('\nMEAL OVERLAY PARITY OK')
