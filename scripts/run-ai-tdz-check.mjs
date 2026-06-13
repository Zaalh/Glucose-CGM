// Regressie-guard voor de top-level-await TDZ-val in libreview-nightscout-sync.mjs.
//
// De module draait in productie als `--server --loop`. De loop doet een top-level
// `await runForever()` die NOOIT terugkeert, dus de module-init wordt daar voorgoed
// opgeschort. Elke module-scope `const`/`let`/`class` die NA die await staat blijft
// daardoor in de temporal dead zone (TDZ) en gooit bij gebruik vanuit een
// request-handler: "Cannot access 'X' before initialization".
//
// Deze val sloeg twee keer toe (CGM_EVENT_TYPES, TOD_LABEL). Deze check faalt de build
// als er opnieuw een module-scope declaratie onder de await belandt. Dependency-vrij.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(new URL('./libreview-nightscout-sync.mjs', import.meta.url))
const lines = readFileSync(file, 'utf8').split('\n')

const awaitIdx = lines.findIndex((l) => /^\s*await\s+runForever\s*\(\s*\)/.test(l))
assert.notEqual(awaitIdx, -1, 'Anker `await runForever()` niet gevonden — pas de TDZ-check aan.')

// Module-scope declaraties staan op kolom 0 (geen inspringing).
const offenders = []
for (let i = awaitIdx + 1; i < lines.length; i += 1) {
  const m = lines[i].match(/^(const|let|class)\s+([A-Za-z0-9_]+)/)
  if (m) offenders.push(`  regel ${i + 1}: ${m[1]} ${m[2]}`)
}

if (offenders.length) {
  console.error('✗ TDZ-RISICO: module-scope declaratie(s) ná de top-level `await runForever()`:')
  console.error(offenders.join('\n'))
  console.error('\nVerplaats deze boven de await (bij CGM_EVENT_TYPES/TOD_LABEL), anders breekt')
  console.error('het gebruik ervan in --loop-modus met een TDZ-fout.')
  process.exit(1)
}

console.log('✓ ai-tdz-check: geen module-scope const/let/class na de top-level await.')
