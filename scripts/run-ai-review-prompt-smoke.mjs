// §21.5 smoke: bouwt de observatie-review-prompt ZONDER LLM-call en zonder Mongo,
// en controleert dat de §21-verrijking (AGP-stats, episodes, lost-in-the-middle-
// volgorde, evidence-schema) daadwerkelijk in de payload zit. Faalt met exit 1 als
// een invariant breekt, zodat regressies in de prompt-structuur opvallen.
import { previewReviewPrompt } from './lib/ai-review-core.mjs'

const stats = {
  window: { days: 14 },
  coveragePct: 92,
  tbr: 3.1,
  veryLow: 0.4,
  tir: 88,
  tar: 9,
  mean: 6.2,
  cv: 28,
  lows: { count: 5 },
  trend: { recentTir: 88, prevTir: 84, tirDelta: 4 },
  reactive: { total: 5, hypo: 2, nearHypo: 1, medianNadirMmol: 3.4, totalAreaBelow3_9: 42 },
  perHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, lowPct: h === 11 ? 14 : 1, n: 50 })),
  highToLowContext: { relevant: 2, total: 3 },
}
const episodes = [
  { peakAt: '2026-06-17T11:00:00Z', peakMmol: 9.1, nadirMmol: 3.3, minutesPeakToNadir: 45, fallRateMmolPerMin: 0.13, severity: 'relevant', shape: 'fast_drop', timeOfDayBucket: 'morning', recoveryMinutes: 25, outcome: 'hypo', readings: [1, 2, 3] },
]

const { system, user } = previewReviewPrompt({ stats, episodes, snapshots: [], feedback: [] })
const parsed = JSON.parse(user)
const keys = Object.keys(parsed)

const failures = []
function check(cond, msg) {
  if (!cond) failures.push(msg)
}

// Lost-in-the-middle: kernsamenvatting boven, kernopdracht als allerlaatste sleutel.
check(keys[0] === 'agpSummary', `eerste sleutel moet agpSummary zijn, is ${keys[0]}`)
check(keys[keys.length - 1] === 'task', `laatste sleutel moet task zijn, is ${keys[keys.length - 1]}`)
// AGP-stats verrijking aanwezig + TBR-first + eenheid-in-sleutel.
check(parsed.agpSummary && parsed.agpSummary['tbr_3.9_pct'] === 3.1, 'agpSummary.tbr_3.9_pct ontbreekt/onjuist')
check(parsed.agpSummary && parsed.agpSummary.reactive, 'agpSummary.reactive ontbreekt')
// perHour gereduceerd tot {hour, lowPct} (token-budget).
const ph = parsed.agpSummary && parsed.agpSummary.perHourLowPct
check(Array.isArray(ph) && ph.length === 24 && Object.keys(ph[0]).join(',') === 'hour,lowPct', 'perHourLowPct moet 24× {hour,lowPct} zijn')
// Kwetsbaar venster afgeleid.
check(parsed.vulnerableWindow && parsed.vulnerableWindow.hour === 11, 'vulnerableWindow.hour moet 11 zijn')
// Episodes compact, geen ruwe readings, top-5.
check(Array.isArray(parsed.recentEpisodes) && parsed.recentEpisodes.length === 1, 'recentEpisodes ontbreekt')
check(parsed.recentEpisodes && !('readings' in parsed.recentEpisodes[0]), 'recentEpisodes mag GEEN ruwe readings bevatten')
// Evidence-schema in de system-prompt.
check(system.includes('"evidence"'), 'system-prompt mist het evidence-schema')
check(system.includes('agpSummary'), 'system-prompt verwijst niet naar agpSummary')

if (failures.length) {
  console.error('✗ ai-review-prompt-smoke: ' + failures.length + ' fout(en):')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log('✓ ai-review-prompt-smoke: AGP-stats/episodes/evidence + lost-in-the-middle-volgorde aanwezig.')
