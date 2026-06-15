import assert from 'node:assert/strict'
import { MEAL_DEFAULTS, projectReactiveNadir, scoreReactiveMealRisk, classifyMealRisk } from './lib/meal-detector.mjs'

const cal = { ...MEAL_DEFAULTS }
const drop = (fields) => ({ phase: 'reactive-drop', dropRate: 0.10, ...fields })
const level = (meal, c = cal) => scoreReactiveMealRisk(meal, c, null, null).level

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'OK' : 'FAIL'} ${label}: ${actual}${ok ? '' : ` (verwacht ${expected})`}`)
}

// projectReactiveNadir: huidig niveau minus resterende verwachte val.
// expectedFall = typicalDrop(1.4) + undershoot(0.2) = 1.6
check('nadir: al voorbij verwachte val -> ~huidig niveau', projectReactiveNadir(drop({ currentMmol: 9, dropFromPeak: 2.0 }), cal), 9)
check('nadir: vroeg in daling -> projecteert lager', Math.round(projectReactiveNadir(drop({ currentMmol: 4.6, dropFromPeak: 0.5 }), cal) * 10) / 10, 3.5)

// KERN: een forse daling die ruim boven 3.9 bodemt mag NIET escaleren.
// 11 -> 9 (normale postprandiale klaring) was voorheen 'watch' (+45 basis).
check('benigne daling 11->9 bodemt hoog -> low', level(drop({ peakMmol: 11, currentMmol: 9, dropFromPeak: 2.0 })), 'low')

// Daling die richting de hypo-zone projecteert escaleert wél.
check('projecteert <4.5 -> watch', level(drop({ peakMmol: 6.4, currentMmol: 5.3, dropFromPeak: 0.5 })), 'watch') // nadir 4.2
check('projecteert <3.9 -> high', level(drop({ peakMmol: 5.1, currentMmol: 4.6, dropFromPeak: 0.5 })), 'high') // nadir 3.5
check('projecteert <3.0 -> urgent', level(drop({ peakMmol: 4.3, currentMmol: 4.0, dropFromPeak: 0.3 })), 'urgent') // nadir 2.7

// Snelle val alleen (veilige bodem) escaleert NIET -- dit is exact het over-firing
// dat we wilden stoppen: snelheid zonder niveau is geen alarm.
check('snelle val maar veilige bodem -> low', level(drop({ peakMmol: 11, currentMmol: 9, dropFromPeak: 2.0, dropRate: 0.25 })), 'low')

// Configureerbaar -> bruikbaar voor iedereen: strengere drempels schuiven de band.
const strict = { ...cal, alertMmol: 4.5, watchMmol: 5.0, seriousMmol: 3.5 }
check('config: hogere alert maakt zelfde daling high', level(drop({ peakMmol: 6.4, currentMmol: 5.3, dropFromPeak: 0.5 }), strict), 'high') // nadir 4.2 < 4.5

// classifyMealRisk grenzen blijven intact.
check('classify 80 -> urgent', classifyMealRisk(80), 'urgent')
check('classify 60 -> high', classifyMealRisk(60), 'high')
check('classify 35 -> watch', classifyMealRisk(35), 'watch')
check('classify 34 -> low', classifyMealRisk(34), 'low')

// Andere fases blijven scoren (geen regressie in de badge-informatie).
assert.equal(scoreReactiveMealRisk({ phase: 'rising', speed: 'snel', riseFromTrough: 2, effRate: 0.2 }, cal, null, null).level !== null, true)

console.log(`\n${failures === 0 ? 'ALLE MAALTIJD-RISICO-CHECKS OK' : `${failures} RISICO-CHECK(S) GEFAALD`}`)
process.exit(failures === 0 ? 0 : 1)
