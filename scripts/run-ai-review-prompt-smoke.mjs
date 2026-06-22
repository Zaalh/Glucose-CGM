// §21.5 smoke: verifieert de §21-verrijking van de observatie-review ZONDER LLM-call en
// ZONDER Mongo. Drie blokken:
//   1) prompt-structuur (happy-path): AGP-stats, episodes, lost-in-the-middle-volgorde,
//      evidence-schema zitten in de payload;
//   2) prompt edge-cases: stats=null, lege/n=0 perHour, ruis-gate, token-strip, cap;
//   3) skip-conditie (W5) via mock-db: wanneer draait de review en wanneer slaat 'm over,
//      zonder ooit Ollama te raken.
// Faalt met exit 1 als een invariant breekt, zodat regressies opvallen.
import { previewReviewPrompt, runAiReview, enforceLowConfirmation, lowsNeedConfirmation } from './lib/ai-review-core.mjs'

const failures = []
function check(cond, msg) {
  if (!cond) failures.push(msg)
}

// --- Blok 1: prompt-structuur (happy-path) ---------------------------------------
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

// --- Blok 2: prompt edge-cases ---------------------------------------------------
// stats=null (aggregatie gefaald → degraded): geen crash, task blijft laatste sleutel.
{
  const u = JSON.parse(previewReviewPrompt({ snapshots: [], feedback: [], stats: null, episodes: [] }).user)
  check(u.agpSummary === null, 'stats=null → agpSummary moet null zijn')
  check(u.vulnerableWindow === null, 'stats=null → vulnerableWindow moet null zijn')
  check(Object.keys(u).pop() === 'task', 'stats=null → task blijft laatste sleutel')
}
// Alle perHour n=0 → perHourLowPct leeg, geen kwetsbaar venster.
{
  const s = { window: { days: 14 }, coveragePct: 5, perHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, lowPct: 0, n: 0 })) }
  const a = JSON.parse(previewReviewPrompt({ stats: s, episodes: [] }).user)
  check(a.agpSummary.perHourLowPct.length === 0, 'n=0 overal → perHourLowPct leeg')
  check(a.vulnerableWindow === null, 'n=0 overal → geen kwetsbaar venster')
}
// Ruis-gate: een uur met hoge lowPct maar n<10 telt NIET als kwetsbaar venster.
{
  const s = { window: { days: 14 }, coveragePct: 50, perHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, lowPct: h === 3 ? 99 : 1, n: h === 3 ? 5 : 40 })) }
  const vw = JSON.parse(previewReviewPrompt({ stats: s, episodes: [] }).user).vulnerableWindow
  check(!vw || vw.hour !== 3, 'ruis-gate: uur met n<10 mag geen kwetsbaar venster zijn')
}
// Token-budget: heatmap/perWeekday/gmi/per-uur-percentielen worden weggelaten.
{
  const s = {
    window: { days: 14 }, coveragePct: 90, tbr: 4, veryLow: 1, tir: 85, tar: 10, mean: 6, cv: 25, lows: { count: 3 }, gmi: 6.1,
    heatmap: Array.from({ length: 168 }, () => 1), perWeekday: Array.from({ length: 7 }, () => ({})),
    perHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, lowPct: 2, n: 40, mean: 6, tir: 85, p10: 4, p25: 5, p50: 6, p75: 7, p90: 8 })),
  }
  const a = JSON.parse(previewReviewPrompt({ stats: s, episodes: [] }).user).agpSummary
  check(a.heatmap === undefined, 'heatmap moet weggelaten zijn')
  check(a.perWeekday === undefined, 'perWeekday moet weggelaten zijn')
  check(a.gmi === undefined, 'gmi moet weggelaten zijn')
  check(a.perHourLowPct.every((p) => Object.keys(p).join(',') === 'hour,lowPct'), 'per-uur percentielen/mean/tir moeten gestript zijn (geen artefactPct → {hour,lowPct})')
}
// Per-uur artefact-rate (§21 #4): aanwezig artefactPct stroomt mee; afwezig → weggelaten.
{
  const s = {
    window: { days: 14 }, coveragePct: 80,
    perHour: [
      { hour: 6, lowPct: 11, artefactPct: 80, n: 50 },
      { hour: 14, lowPct: 4, artefactPct: null, n: 50 },
    ],
  }
  const ph = JSON.parse(previewReviewPrompt({ stats: s, episodes: [] }).user).agpSummary.perHourLowPct
  const h6 = ph.find((p) => p.hour === 6)
  const h14 = ph.find((p) => p.hour === 14)
  check(h6 && h6.artefactPct === 80, 'uur met artefactPct → meegegeven ({hour,lowPct,artefactPct})')
  check(h14 && !('artefactPct' in h14), 'uur met artefactPct=null → veld weggelaten')
}
// Verbeterde statistiek (#1 burden, #2 dag/nacht, #3 sufficiency) stromen door compactStats.
{
  const s = {
    window: { days: 14 }, coveragePct: 85, tbr: 4.9, veryLow: 0.6, tir: 93,
    hypoBurden: { episodes: 70, artefactEpisodes: 16, cleanEpisodes: 54, artefactPct: 23, areaBelow3_9: 176, areaBelow3_9Clean: 120 },
    dayNight: { night: { n: 5000, tbr: 8.0, tir: 90 }, day: { n: 12000, tbr: 3.7, tir: 94 } },
    dataSufficiency: { reliable: true, days: 14, coveragePct: 85, standard: '≥14d & ≥70% dekking' },
    perHour: [],
  }
  const a = JSON.parse(previewReviewPrompt({ stats: s, episodes: [] }).user).agpSummary
  check(a.hypoBurden && a.hypoBurden.cleanEpisodes === 54 && a.hypoBurden.areaBelow3_9Clean === 120, 'hypoBurden (#1) stroomt door')
  check(a.dayNight && a.dayNight.night.tbr === 8.0 && a.dayNight.day.tbr === 3.7, 'dayNight (#2) stroomt door')
  check(a.dataSufficiency && a.dataSufficiency.reliable === true, 'dataSufficiency (#3) stroomt door')
}
// Episode-cap top-15 + ontbrekende velden → null (geen crash).
{
  const many = Array.from({ length: 20 }, (_, i) => ({ peakAt: `2026-06-${(i % 28) + 1}T11:00:00Z`, readings: [1, 2, 3] }))
  const u = JSON.parse(previewReviewPrompt({ stats: null, episodes: many }).user)
  check(u.recentEpisodes.length === 15, '20 episodes → top-15')
  check(u.recentEpisodes.every((e) => !('readings' in e)), 'episodes mogen geen ruwe readings bevatten')
  check(u.recentEpisodes[0].peakMmol === null, 'ontbrekend episode-veld → null')
}

// --- Blok 2b: deterministische low-confirmation hardening (residu #1) -------------
{
  const lowObs = { summary: 'Kwetsbaar venster rond 06:00 met hoge lage-percentages', hypothesis: 'verhoogd risico op dalingen', needsUserConfirmation: false }
  const highObs = { summary: 'TIR is 93% met stabiel profiel', hypothesis: 'gunstige variabiliteit', needsUserConfirmation: false }
  const confirmedObs = { summary: 'Eén bevestigde hypo (3.607 mmol/L) gemeld door gebruiker', hypothesis: 'reële episode', needsUserConfirmation: false }
  const artefact = { reactive: { pctPostprandialCandidate: 0, medianRecoveryMin: 2, pctPoorQuality: 23 } }
  const healthy = { reactive: { pctPostprandialCandidate: 60, medianRecoveryMin: 25, pctPoorQuality: 5 } }
  check(enforceLowConfirmation([lowObs], artefact)[0].needsUserConfirmation === true, 'hardening: artefact-data + low → needsConfirm geforceerd')
  check(enforceLowConfirmation([highObs], artefact)[0].needsUserConfirmation === false, 'hardening: artefact-data + niet-low → ongemoeid')
  check(enforceLowConfirmation([lowObs], healthy)[0].needsUserConfirmation === false, 'hardening: gezonde data → geen override')
  // Lift is PER OBSERVATIE: een obs die zelf naar bevestiging verwijst is vrijgesteld...
  check(enforceLowConfirmation([confirmedObs], artefact)[0].needsUserConfirmation === false, 'hardening: obs die bevestiging citeert → vrijgesteld')
  // ...maar dat mag de backstop voor de óverige artefact-low-obs niet uitschakelen (regressie #1).
  check(enforceLowConfirmation([confirmedObs, lowObs], artefact)[1].needsUserConfirmation === true, 'hardening: bevestigde obs schakelt backstop voor andere low-obs NIET uit')
  check(lowsNeedConfirmation({ reactive: { pctPostprandialCandidate: 60, medianRecoveryMin: 3, pctPoorQuality: 5 } }) === true, 'hardening: snel herstel (3min) triggert')
  check(enforceLowConfirmation([lowObs], null)[0].needsUserConfirmation === false, 'hardening: stats=null → veilig ongemoeid')
  const orig = { ...lowObs }; enforceLowConfirmation([lowObs], artefact); check(lowObs.needsUserConfirmation === orig.needsUserConfirmation, 'hardening: puur (origineel onaangetast)')
}

// --- Blok 3: skip-conditie (W5) via mock-db, zonder Ollama -----------------------
// Een configured-uitziende router passeert de provider-check; een mock-db levert de
// snapshots en gooit bij de feedback-query een sentinel, zodat "voorbij de skip
// gekomen" detecteerbaar is ZONDER een echte LLM-call.
const router = { providers: [{ name: 'mock' }] }
function makeDb({ snaps = [] } = {}) {
  const chain = (toArray) => ({ find: () => ({ sort: () => ({ limit: () => ({ toArray }) }) }) })
  return {
    collection(name) {
      if (name === 'user_feedback') return chain(() => { throw new Error('REACHED_FEEDBACK') })
      return chain(async () => snaps)
    },
  }
}
async function runState(args) {
  try {
    const r = await runAiReview(args)
    return { skipped: !!r.skipped }
  } catch (e) {
    if (e.message === 'REACHED_FEEDBACK') return { proceeded: true }
    throw e
  }
}

async function skipTests() {
  // A: niets te reviewen → skip
  check((await runState({ db: makeDb(), aiRouter: router, stats: null, episodes: [] })).skipped === true, 'skip A: niets → skipped')
  // B: bruikbare stats (coverage>=10) → review draait
  check((await runState({ db: makeDb(), aiRouter: router, stats: { coveragePct: 50 }, episodes: [] })).proceeded === true, 'skip B: bruikbare stats → draait')
  // C: episodes aanwezig → review draait
  check((await runState({ db: makeDb(), aiRouter: router, stats: null, episodes: [{ nadirMmol: 3.3 }] })).proceeded === true, 'skip C: episodes → draait')
  // D: coverage onder drempel (10) → skip
  check((await runState({ db: makeDb(), aiRouter: router, stats: { coveragePct: 5 }, episodes: [] })).skipped === true, 'skip D: coverage<10 → skipped')
  // E: snapshots aanwezig → draait (backward-compat met oude gedrag)
  check((await runState({ db: makeDb({ snaps: [{ _id: 'a', risk: 'watch' }] }), aiRouter: router, stats: null, episodes: [] })).proceeded === true, 'skip E: snapshots → draait')
  // F: geen provider → skipped vóór elke db-touch
  check((await runAiReview({ db: makeDb(), aiRouter: { providers: [] }, stats: null, episodes: [] })).skipped === true, 'skip F: geen provider → skipped')
}

// --- Rapport ---------------------------------------------------------------------
skipTests().then(() => {
  if (failures.length) {
    console.error('✗ ai-review-prompt-smoke: ' + failures.length + ' fout(en):')
    for (const f of failures) console.error('  - ' + f)
    process.exit(1)
  }
  console.log('✓ ai-review-prompt-smoke: prompt-structuur + edge-cases + skip-conditie (W5) OK.')
})
