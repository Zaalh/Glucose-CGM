// Patroon-ontdekking voor reactieve hypo's: doorsnijdt jouw eigen data langs
// meerdere assen zodat je zoveel mogelijk patronen vindt:
//   - per uur-van-de-dag (wanneer op de dag clusteren hypo's — vaak post-maaltijd)
//   - per weekdag (welke dagen riskanter)
//   - episode-statistiek (typische piek, drop, tijd-tot-nadir voor (near-)hypo's)
// Plus "highlights": de sterkste clusters.
//
// Bron: reactive_hypo_episodes (M3) voor episode-timing/outcome + entries voor de
// time-below heatmap. Tijdzone-bewust (LIBREVIEW_TZ, default Europe/Amsterdam).
//
//   docker compose ... run --rm libreview-sync node scripts/hypo-patterns.mjs --days 28
//   node scripts/hypo-patterns.mjs --self-test

import { MongoClient } from 'mongodb'
import { MGDL_PER_MMOL } from './lib/hypo-features.mjs'

const MS_PER_MIN = 60_000
const GAP_MS = 15 * MS_PER_MIN
const TZ = process.env.LIBREVIEW_TZ ?? 'Europe/Amsterdam'
const WEEKDAYS = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag']

const mmolOf = (e) => Number(e.sgv) / MGDL_PER_MMOL
const weekdayOf = (ms) => new Intl.DateTimeFormat('nl-NL', { weekday: 'long', timeZone: TZ }).format(new Date(ms))
const hourOf = (ms) =>
  Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: TZ }).format(new Date(ms)))

function round(v, d) {
  if (!Number.isFinite(v)) return null
  const f = 10 ** d
  return Math.round(v * f) / f
}
function median(a) {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function argDays(def) {
  const i = process.argv.indexOf('--days')
  if (i >= 0) {
    const n = Number(process.argv[i + 1])
    if (Number.isFinite(n) && n > 0) return n
  }
  return def
}

function buildPatterns(entries, episodes, days, nowMs) {
  const toMs = nowMs
  const fromMs = nowMs - days * 24 * 60 * MS_PER_MIN
  const win = entries.filter((e) => e.date >= fromMs && e.date <= toMs)
  const eps = episodes
    .map((ep) => ({ ...ep, _ms: Date.parse(ep.nadirAt || ep.peakAt || ep.end) }))
    .filter((ep) => Number.isFinite(ep._ms) && ep._ms >= fromMs && ep._ms <= toMs)

  const hour = Array.from({ length: 24 }, (_, h) => ({ hour: h, entries: 0, below40Min: 0, below45Min: 0, hypoEpisodes: 0, nearEpisodes: 0 }))
  const wday = {}
  for (const d of WEEKDAYS) wday[d] = { weekday: d, entries: 0, below40Min: 0, below45Min: 0, hypoEpisodes: 0, nearEpisodes: 0 }

  for (let i = 0; i < win.length; i += 1) {
    const h = hourOf(win[i].date)
    const d = weekdayOf(win[i].date)
    hour[h].entries += 1
    wday[d].entries += 1
    if (i > 0) {
      const dt = win[i].date - win[i - 1].date
      if (dt > 0 && dt <= GAP_MS) {
        const hp = hourOf(win[i - 1].date)
        const dp = weekdayOf(win[i - 1].date)
        const mm = mmolOf(win[i - 1])
        const min = dt / MS_PER_MIN
        if (mm < 4.0) { hour[hp].below40Min += min; wday[dp].below40Min += min }
        else if (mm < 4.5) { hour[hp].below45Min += min; wday[dp].below45Min += min }
      }
    }
  }

  for (const ep of eps) {
    const h = hourOf(ep._ms)
    const d = weekdayOf(ep._ms)
    if (ep.outcome === 'hypo') { hour[h].hypoEpisodes += 1; wday[d].hypoEpisodes += 1 }
    else if (ep.outcome === 'near_hypo') { hour[h].nearEpisodes += 1; wday[d].nearEpisodes += 1 }
  }
  for (const h of hour) { h.below40Min = round(h.below40Min, 0); h.below45Min = round(h.below45Min, 0) }
  for (const d of WEEKDAYS) { wday[d].below40Min = round(wday[d].below40Min, 0); wday[d].below45Min = round(wday[d].below45Min, 0) }

  // episode-statistiek voor (near-)hypo descents
  const risky = eps.filter((ep) => ep.outcome === 'hypo' || ep.outcome === 'near_hypo')
  const byOutcome = {}
  for (const ep of eps) byOutcome[ep.outcome] = (byOutcome[ep.outcome] || 0) + 1
  const episodeStats = {
    total: eps.length,
    byOutcome,
    riskyCount: risky.length,
    medianPeakMmol: round(median(risky.map((e) => e.peakMmol).filter(Number.isFinite)), 2),
    medianDropFromPeakMmol: round(median(risky.map((e) => e.dropFromPeakMmol).filter(Number.isFinite)), 2),
    medianMinutesPeakToNadir: round(median(risky.map((e) => e.minutesPeakToNadir).filter(Number.isFinite)), 0),
  }

  // highlights: sterkste clusters
  const score = (o) => o.hypoEpisodes * 2 + o.nearEpisodes
  const topHours = [...hour].filter((h) => score(h) > 0).sort((a, b) => score(b) - score(a)).slice(0, 3)
    .map((h) => ({ hour: h.hour, hypoEpisodes: h.hypoEpisodes, nearEpisodes: h.nearEpisodes }))
  const topWeekdays = WEEKDAYS.map((d) => wday[d]).filter((d) => score(d) > 0).sort((a, b) => score(b) - score(a)).slice(0, 3)
    .map((d) => ({ weekday: d.weekday, hypoEpisodes: d.hypoEpisodes, nearEpisodes: d.nearEpisodes }))

  return {
    mode: 'patterns',
    tz: TZ,
    window: { days, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    episodeStats,
    byHourOfDay: hour,
    byWeekday: WEEKDAYS.map((d) => wday[d]),
    highlights: {
      riskiestHours: topHours,
      riskiestWeekdays: topWeekdays,
      note: risky.length < 5 ? 'Weinig episodes: patronen indicatief, worden sterker met meer data.' : 'Voldoende episodes voor eerste patronen.',
    },
  }
}

function selfData(nowMs) {
  // synthetische entries: elke dag rond 13:00 een piek->hypo
  const entries = []
  const episodes = []
  for (let day = 14; day >= 1; day -= 1) {
    const base = nowMs - day * 24 * 60 * MS_PER_MIN
    const lunchPeak = base + 13 * 60 * MS_PER_MIN
    const curve = [5.2, 6.8, 9.0, 10.0, 8.6, 6.8, 5.2, 4.2, 3.6, 4.0, 4.8, 5.4]
    curve.forEach((m, k) => entries.push({ date: lunchPeak + (k - 3) * 5 * MS_PER_MIN, sgv: Math.round(m * MGDL_PER_MMOL) }))
    episodes.push({ peakAt: new Date(lunchPeak).toISOString(), nadirAt: new Date(lunchPeak + 5 * 5 * MS_PER_MIN).toISOString(), outcome: 'hypo', peakMmol: 10.0, dropFromPeakMmol: 6.4, minutesPeakToNadir: 25 })
  }
  entries.sort((a, b) => a.date - b.date)
  return { entries, episodes }
}

async function main() {
  const selfTest = process.argv.includes('--self-test')
  const days = argDays(selfTest ? 21 : 28)
  const nowMs = Date.now()

  let entries
  let episodes
  let client = null
  if (selfTest) {
    ;({ entries, episodes } = selfData(nowMs))
  } else {
    const uri = process.env.MONGODB_URI ?? 'mongodb://nightscout-mongo:27017/nightscout'
    client = new MongoClient(uri)
    await client.connect()
    const db = client.db()
    entries = await db.collection('entries')
      .find({ type: 'sgv', sgv: { $exists: true } }, { projection: { _id: 0, date: 1, sgv: 1 } })
      .sort({ date: 1 }).toArray()
    episodes = await db.collection('reactive_hypo_episodes')
      .find({}, { projection: { _id: 0, peakAt: 1, nadirAt: 1, end: 1, outcome: 1, peakMmol: 1, dropFromPeakMmol: 1, minutesPeakToNadir: 1 } })
      .toArray()
  }

  try {
    const report = buildPatterns(entries, episodes, days, nowMs)
    console.log(JSON.stringify(report, null, 2))
    if (selfTest) {
      const peakHour = report.highlights.riskiestHours[0]
      console.log(`\n${peakHour && report.episodeStats.riskyCount >= 1 ? 'SELF-TEST OK' : 'SELF-TEST FAIL'}`)
    }
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error(`[patterns] mislukt: ${err && err.message ? err.message : err}`)
  process.exit(1)
})
