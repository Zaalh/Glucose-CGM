import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MGDL_PER_MMOL = 18.0182

function round(value, decimals = 1) {
  if (!Number.isFinite(value)) return null
  const p = 10 ** decimals
  return Math.round(value * p) / p
}

function percentile(sorted, p) {
  if (!sorted.length) return null
  return round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))], 1)
}

function csvEscape(value) {
  if (value == null) return ''
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

function summarize(rows) {
  const values = rows.map((r) => r.mmol).filter(Number.isFinite)
  const sorted = values.slice().sort((a, b) => a - b)
  const n = values.length
  const mean = n ? values.reduce((s, v) => s + v, 0) / n : null
  const sd = n && mean != null
    ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n)
    : null
  const count = (fn) => values.filter(fn).length
  const pct = (x) => n ? round((x / n) * 100, 1) : null
  const rates = []
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1]
    const cur = rows[i]
    const minutes = (cur.date - prev.date) / 60000
    if (minutes > 0 && minutes <= 35) {
      rates.push({
        from: prev.dateString,
        to: cur.dateString,
        minutes: round(minutes, 1),
        fromMmol: prev.mmol,
        toMmol: cur.mmol,
        deltaMmol: round(cur.mmol - prev.mmol, 3),
        rateMmolPerMin: round((cur.mmol - prev.mmol) / minutes, 4),
      })
    }
  }
  // LET OP: dit is netto verandering tussen twee samples gedeeld door de tijd, GEEN gemeten helling.
  // Bij ~30-min sampling mis je de echte piek/dal ertussenin, dus de werkelijke snelheid kan hoger
  // of lager liggen. Markeer expliciet zodat een externe LLM dit niet als klinische daalsnelheid leest.
  const annotateRate = (r) => (r ? { ...r, resolutionLimited: true } : null)
  const fastestDrop = annotateRate(rates.slice().sort((a, b) => a.rateMmolPerMin - b.rateMmolPerMin)[0] || null)
  const fastestRise = annotateRate(rates.slice().sort((a, b) => b.rateMmolPerMin - a.rateMmolPerMin)[0] || null)
  return {
    rows: n,
    from: rows[0]?.dateString ?? null,
    to: rows.at(-1)?.dateString ?? null,
    mean: round(mean, 1),
    sd: round(sd, 1),
    cvPct: mean ? round((sd / mean) * 100, 1) : null,
    gmiPct: mean ? round(3.31 + 0.02392 * (mean * MGDL_PER_MMOL), 1) : null,
    min: round(sorted[0], 1),
    p10: percentile(sorted, 0.10),
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.50),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.90),
    max: round(sorted.at(-1), 1),
    tirPct: pct(count((v) => v >= 3.9 && v <= 10.0)),
    tbrPct: pct(count((v) => v < 3.9)),
    veryLowPct: pct(count((v) => v < 3.0)),
    tarPct: pct(count((v) => v > 10.0)),
    veryHighPct: pct(count((v) => v > 13.9)),
    fastestDrop,
    fastestRise,
  }
}

const inputPath = process.argv[2] || 'cgm_entries.json'
const outDir = process.argv[3] || 'exports/gemini-cgm'
const raw = JSON.parse(await readFile(inputPath, 'utf8'))
const rows = raw
  .filter((r) => r.type === 'sgv' && Number.isFinite(Number(r.sgv)) && Number.isFinite(Number(r.date)))
  .map((r) => ({
    dateString: r.dateString || new Date(Number(r.date)).toISOString(),
    date: Number(r.date),
    sgvMgdl: Number(r.sgv),
    mmol: round(Number(r.sgv) / MGDL_PER_MMOL, 3),
    direction: r.direction || '',
    device: r.device || '',
    identifier: r.identifier || '',
  }))
  .sort((a, b) => a.date - b.date)

const summary = summarize(rows)
await mkdir(outDir, { recursive: true })

const csvHeader = ['dateString_utc', 'date_ms', 'sgv_mgdl', 'glucose_mmol_l', 'direction', 'device', 'identifier']
const csv = [
  csvHeader.join(','),
  ...rows.map((r) => [
    r.dateString,
    r.date,
    r.sgvMgdl,
    r.mmol,
    r.direction,
    r.device,
    r.identifier,
  ].map(csvEscape).join(',')),
].join('\n')

const json = {
  exportedAt: new Date().toISOString(),
  source: inputPath,
  units: {
    sgvMgdl: 'mg/dL',
    mmol: 'mmol/L',
    conversion: `mmol/L = mg/dL / ${MGDL_PER_MMOL}`,
  },
  caveats: [
    'Deze export is gebaseerd op het lokale cgm_entries.json bestand, niet op live MongoDB.',
    'De bron lijkt uit PDF-uurmin/max historie te komen; resolutie is meestal 30 minuten, niet ruwe 1-min LibreView data.',
    'Gebruik alleen deze cijfers; verzin geen extra episodes, diagnoses of vergelijkingswaarden.',
    'Profiel: reactieve hypoglykemie zonder diabetes/insuline. GMI/TIR/TAR zijn diabetes-management-maatstaven en hier alleen descriptief; de medisch relevante metrics zijn de below-range/hypo-cijfers (TBR <3.9, very-low <3.0).',
    'Door de 30-min resolutie worden korte hypo-dips gemist: TBR is een ONDERGRENS, de werkelijke below-range tijd kan hoger liggen.',
    'fastestDrop/fastestRise zijn netto verandering tussen twee 30-min samples (resolutionLimited), GEEN gemeten CGM-helling; gebruik ze niet als klinische daalsnelheid.',
  ],
  summary,
  rows,
}

const prompt = `# CGM database-uitdraai voor Gemini

Gebruik uitsluitend onderstaande bestanden en cijfers. Niet gokken en geen medische diagnose geven.

Bron: \`${inputPath}\`
Exporttijd: ${json.exportedAt}
Eenheden: Nightscout \`sgv\` in mg/dL; \`glucose_mmol_l = sgv / ${MGDL_PER_MMOL}\`.

## Context van het profiel

Reactieve hypoglykemie zónder diabetes/insuline. De **primaire vraag is de below-range/hypo-kant**, niet
diabetes-controle. GMI/TIR/TAR staan hieronder alleen als descriptieve context; gebruik ze niet als doel
of yardstick. De data is grove ~30-min historie, dus korte hypo-dips kunnen gemist zijn: TBR is een
**ondergrens**.

## Primair — below-range / hypo (mmol/L)

- TBR <3.9: ${summary.tbrPct}%  (ondergrens door 30-min resolutie)
- Very low <3.0: ${summary.veryLowPct}%
- Min: ${summary.min} mmol/L

## Descriptieve context (diabetes-maatstaven, niet de yardstick hier)

- GMI: ${summary.gmiPct}%
- TIR 3.9-10.0: ${summary.tirPct}%
- TAR >10.0: ${summary.tarPct}%  |  Very high >13.9: ${summary.veryHighPct}%

## Algemeen & variabiliteit

- Aantal metingen: ${summary.rows}  |  Periode UTC: ${summary.from} t/m ${summary.to}
- Gemiddelde: ${summary.mean} mmol/L  |  SD: ${summary.sd} mmol/L  |  CV: ${summary.cvPct}%
- Min/mediaan/max: ${summary.min} / ${summary.median} / ${summary.max} mmol/L  |  IQR p25-p75: ${summary.p25}-${summary.p75} mmol/L

## Grootste netto-verandering tussen twee samples — RESOLUTIE-GELIMITEERD, geen echte helling

Dit is netto verschil tussen twee 30-min punten gedeeld door de tijd. Je mist de echte piek/dal ertussenin;
gebruik dit NIET als klinische daalsnelheid.

- Grootste netto daling: ${summary.fastestDrop ? `${summary.fastestDrop.deltaMmol} mmol over ${summary.fastestDrop.minutes} min (${summary.fastestDrop.fromMmol} -> ${summary.fastestDrop.toMmol}, ${summary.fastestDrop.from} t/m ${summary.fastestDrop.to})` : 'n.v.t.'}
- Grootste netto stijging: ${summary.fastestRise ? `${summary.fastestRise.deltaMmol} mmol over ${summary.fastestRise.minutes} min (${summary.fastestRise.fromMmol} -> ${summary.fastestRise.toMmol}, ${summary.fastestRise.from} t/m ${summary.fastestRise.to})` : 'n.v.t.'}

## Bestanden

- \`gemini-cgm-export.json\`: volledige export met metadata, samenvatting en alle rijen.
- \`gemini-cgm-readings.csv\`: rekenvriendelijke tabel met timestamp, mg/dL en mmol/L.

## Instructie voor analyse

Reken vanuit de CSV/JSON. Als je uitspraken doet over hypo's, TIR, CV, snelheid of pieken/dalen, noem de exacte rij/tijdstippen en formule. Let op: dit is offline PDF-historie met grove resolutie; voor live 1-min databasecijfers is een MongoDB-export nodig.
`

await writeFile(path.join(outDir, 'gemini-cgm-readings.csv'), `${csv}\n`)
await writeFile(path.join(outDir, 'gemini-cgm-export.json'), `${JSON.stringify(json, null, 2)}\n`)
await writeFile(path.join(outDir, 'GEMINI_PROMPT.md'), prompt)

console.log(`Wrote ${rows.length} rows to ${outDir}`)
console.log(JSON.stringify(summary, null, 2))
