// Dev-runner voor detector V2 op JSON-fixtures (Mijlpaal 2).
// Geen database nodig: bouwt features uit elke fixture-timeline, draait de
// detector en checkt de verwachte risico-ondergrens/bovengrens.
//
//   node scripts/run-detector-fixtures.mjs

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildHypoFeatures, timelineFromReadings } from './lib/hypo-features.mjs'
import { evaluateReactiveHypoRiskV2 } from './lib/reactive-hypo-detector.mjs'

const ORDER = { low: 0, watch: 1, likely: 2, urgent: 3 }
const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(here, 'fixtures')

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0) // vaste klok voor reproduceerbaarheid

const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'))
let failures = 0

for (const file of files) {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'))
  const timeline = timelineFromReadings(fixture.readings, NOW)
  const features = buildHypoFeatures(timeline, timeline.length - 1, { nowMs: NOW })
  const result = evaluateReactiveHypoRiskV2(features, { params: fixture.params })

  const checks = []
  if (fixture.expect?.atLeast) {
    const ok = ORDER[result.risk] >= ORDER[fixture.expect.atLeast]
    checks.push({ ok, label: `risk >= ${fixture.expect.atLeast}` })
  }
  if (fixture.expect?.atMost) {
    const ok = ORDER[result.risk] <= ORDER[fixture.expect.atMost]
    checks.push({ ok, label: `risk <= ${fixture.expect.atMost}` })
  }
  const passed = checks.every((c) => c.ok)
  if (!passed) failures += 1

  console.log(`\n${passed ? '✓' : '✗'} ${fixture.name}  →  risk=${result.risk} score=${result.score} confidence=${result.confidence} uncertainty=${result.uncertainty}`)
  console.log(`   ${fixture.description}`)
  console.log(
    `   current=${features.currentMmol} blendedRate=${features.blendedRate} drop=${features.dropFromPeakMmol} ` +
      `minTo45=${features.minutesTo45} minTo40=${features.minutesTo40} lagAdj=${features.lagAdjustedMmol}`,
  )
  console.log(
    `   scenarios: expectedMin30=${result.scenarios.expectedMin30} worstCaseMin30=${result.scenarios.worstCaseMin30} ` +
      `agreement=${result.scenarios.scenarioAgreement}`,
  )
  console.log(`   components: ${JSON.stringify(result.components)}`)
  if (result.reasons.length) console.log(`   reasons: ${result.reasons.join(' | ')}`)
  for (const c of checks) console.log(`   ${c.ok ? 'ok' : 'FAIL'}: ${c.label}`)
}

console.log(`\n${failures === 0 ? 'ALLE FIXTURES OK' : `${failures} FIXTURE(S) GEFAALD`} (${files.length} totaal)`)
process.exit(failures === 0 ? 0 : 1)
