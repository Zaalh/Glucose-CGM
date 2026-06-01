// Sanity-check voor de episode-builder op een synthetische timeline (M3).
//   node scripts/run-episode-builder-check.mjs
//
// Timeline bevat bewust twee episodes: een reactieve hypo (piek 10 -> nadir 3.8)
// en een veilige daling (piek 8 -> nadir 5.5), met vlakke stukken ertussen.

import { timelineFromReadings } from './lib/hypo-features.mjs'
import { buildEpisodes, outcomeHistogram } from './lib/episode-builder.mjs'

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0)

const readings = [
  // Episode A: reactieve hypo
  { minutesAgo: 240, mmol: 5.0 }, { minutesAgo: 230, mmol: 5.2 }, { minutesAgo: 220, mmol: 6.0 },
  { minutesAgo: 210, mmol: 7.8 }, { minutesAgo: 205, mmol: 9.2 }, { minutesAgo: 200, mmol: 10.0 },
  { minutesAgo: 195, mmol: 9.6 }, { minutesAgo: 190, mmol: 8.8 }, { minutesAgo: 185, mmol: 7.9 },
  { minutesAgo: 180, mmol: 6.9 }, { minutesAgo: 175, mmol: 5.8 }, { minutesAgo: 170, mmol: 4.6 },
  { minutesAgo: 167, mmol: 4.1 }, { minutesAgo: 165, mmol: 3.8 }, { minutesAgo: 162, mmol: 4.0 },
  { minutesAgo: 158, mmol: 4.6 }, { minutesAgo: 152, mmol: 5.2 }, { minutesAgo: 150, mmol: 5.5 },
  // vlak
  { minutesAgo: 140, mmol: 5.3 }, { minutesAgo: 130, mmol: 5.2 }, { minutesAgo: 120, mmol: 5.2 },
  // Episode B: veilige daling
  { minutesAgo: 110, mmol: 5.4 }, { minutesAgo: 105, mmol: 6.2 }, { minutesAgo: 100, mmol: 7.2 },
  { minutesAgo: 96, mmol: 7.8 }, { minutesAgo: 95, mmol: 8.0 }, { minutesAgo: 92, mmol: 7.9 },
  { minutesAgo: 88, mmol: 7.4 }, { minutesAgo: 82, mmol: 6.8 }, { minutesAgo: 76, mmol: 6.1 },
  { minutesAgo: 70, mmol: 5.5 }, { minutesAgo: 66, mmol: 5.6 }, { minutesAgo: 60, mmol: 5.8 },
  // vlak einde
  { minutesAgo: 50, mmol: 5.6 }, { minutesAgo: 40, mmol: 5.5 }, { minutesAgo: 30, mmol: 5.5 },
  { minutesAgo: 20, mmol: 5.4 }, { minutesAgo: 10, mmol: 5.5 }, { minutesAgo: 0, mmol: 5.5 },
]

const timeline = timelineFromReadings(readings, NOW)
const episodes = buildEpisodes(timeline)

console.log(`episodes: ${episodes.length}`)
console.log(`outcomes: ${JSON.stringify(outcomeHistogram(episodes))}`)
for (const e of episodes) {
  console.log(
    `  ${e.outcome.padEnd(10)} peak=${e.peakMmol} nadir=${e.nadirMmol} drop=${e.dropFromPeakMmol} ` +
      `pk->nadir=${e.minutesPeakToNadir}m pk->u45=${e.minutesPeakToUnder45} pk->u40=${e.minutesPeakToUnder40} ` +
      `maxFall=${e.maxFallRate30m}`,
  )
}

const outcomes = episodes.map((e) => e.outcome)
const ok = episodes.length === 2 && outcomes.includes('hypo') && outcomes.includes('safe_drop')
console.log(`\n${ok ? 'OK' : 'FAIL'}: verwacht 2 episodes (hypo + safe_drop)`)
process.exit(ok ? 0 : 1)
