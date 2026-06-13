// Sanity-check voor de glucose-events feed-builder op een synthetische dag.
//   node scripts/run-glucose-events-check.mjs
//
// Timeline bevat bewust: een sub-10 lokale piek (~7.3), een high-episode (>10,
// piek 12.0, ~35 min), herstel naar bereik, en een stabiel laag-variabel venster.

import assert from 'node:assert/strict'
import { timelineFromReadings } from './lib/hypo-features.mjs'
import { buildGlucoseEvents } from './lib/glucose-events.mjs'

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0)

const readings = [
  // start laag-vlak (nuchter), dan een sub-10 lokale piek
  { minutesAgo: 360, mmol: 4.9 }, { minutesAgo: 350, mmol: 5.0 }, { minutesAgo: 340, mmol: 5.1 },
  { minutesAgo: 320, mmol: 6.0 }, { minutesAgo: 310, mmol: 7.0 }, { minutesAgo: 300, mmol: 7.3 },
  { minutesAgo: 295, mmol: 6.9 }, { minutesAgo: 285, mmol: 6.0 }, { minutesAgo: 275, mmol: 5.4 },
  { minutesAgo: 265, mmol: 5.2 }, { minutesAgo: 255, mmol: 5.1 }, { minutesAgo: 245, mmol: 5.1 },
  // high-episode: stijging boven 10 tot 12.0, ~35 min boven 10
  { minutesAgo: 235, mmol: 6.5 }, { minutesAgo: 230, mmol: 8.5 }, { minutesAgo: 225, mmol: 10.4 },
  { minutesAgo: 220, mmol: 11.2 }, { minutesAgo: 212, mmol: 12.0 }, { minutesAgo: 205, mmol: 11.6 },
  { minutesAgo: 198, mmol: 10.9 }, { minutesAgo: 192, mmol: 10.2 }, { minutesAgo: 188, mmol: 9.6 },
  // herstel + stabiel laag-variabel venster (~60 min rond 8.8)
  { minutesAgo: 180, mmol: 8.9 }, { minutesAgo: 170, mmol: 8.8 }, { minutesAgo: 160, mmol: 8.9 },
  { minutesAgo: 150, mmol: 8.7 }, { minutesAgo: 140, mmol: 8.8 }, { minutesAgo: 130, mmol: 8.9 },
  { minutesAgo: 120, mmol: 8.8 },
]

const timeline = timelineFromReadings(readings, NOW)
const events = buildGlucoseEvents(timeline)

console.log(`events: ${events.length}`)
for (const e of events) {
  console.log(`  ${String(e.type).padEnd(16)} ${e.at}  ${e.mmol} mmol  ${e.detail}${e.badge ? ' [' + e.badge + ']' : ''}`)
}

const types = events.map((e) => e.type)
let ok = false
try {
  assert.equal(types[0], 'first_reading', 'eerste event = first_reading')
  assert.ok(types.includes('rise_local_peak'), 'sub-10 lokale piek gedetecteerd')
  const high = events.find((e) => e.type === 'high_episode')
  assert.ok(high, 'high-episode gedetecteerd')
  assert.ok(high.mmol >= 11.5, 'high-piek ~12.0')
  assert.ok(high.durationMinutes >= 15, 'high-duur >= 15 min')
  assert.ok(high.peakAt, 'high heeft peakAt voor detail-link')
  assert.ok(types.includes('recovery_to_range'), 'herstel naar bereik gedetecteerd')
  assert.ok(types.includes('stable_window'), 'stabiel venster gedetecteerd')
  // chronologisch gesorteerd
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(Date.parse(events[i].at) >= Date.parse(events[i - 1].at), 'events chronologisch')
  }
  ok = true
} catch (err) {
  console.error(`\nFAIL: ${err.message}`)
}
console.log(`\n${ok ? 'OK' : 'FAIL'}: verwacht first_reading + lokale piek + high-episode + herstel + stabiel venster`)
process.exit(ok ? 0 : 1)
