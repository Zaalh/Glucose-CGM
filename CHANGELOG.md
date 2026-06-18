# Changelog

Alle noemenswaardige wijzigingen aan Glucose CGM. Formaat losjes gebaseerd op
[Keep a Changelog](https://keepachangelog.com/). Datums in YYYY-MM-DD.

## [Unreleased]

### Snelheidsvakjes

- **Ontdubbeling van per-minuut-vakjes bij trage feed** (`nightscout-overlay/rate-overlay.js`,
  `dedupeDisplayRows` in `computeRows`). Wanneer de feed traag binnenkomt (telefoon uit bereik,
  ~5 min tussen metingen) snapten meerdere minuut-vensters binnen de ±75s-tolerantie op dezelfde
  fysieke meting en toonden identieke vakjes (de "dubbele metingen"). Nu houdt elke echte meting
  alleen het venster waarvan het label het dichtst bij de werkelijke leeftijd ligt; de overige
  minuten worden eerlijk `geen exact punt`. Elk getoond cijfer is dus een unieke, gemeten waarde —
  bewust niet geïnterpoleerd/geschat. Geldt voor beide standen (verhouding én momentaan). De
  forecast/alarm zijn ongemoeid: die draaien op de rauwe `calculateRows` (`currentForecastRows`),
  de dedupe zit alleen in de weergave-laag.


> **Live gedeployed (2026-06-14)** op commit `2a3481f`. `episode_vectors` herbouwd
> (566 vectoren mét curve), `hypo:backtest` + `hypo:tune` op verse data → **V2 is voor
> het eerst AUTO-GEACTIVEERD**: de M6-gate slaagt op out-of-sample (test recall 1.0 vs
> V1 0.867, **0 gemiste hypo's** vs 6, precision 0.234 vs 0.212). `libreview-sync`
> herstart; verse `prediction_snapshots` tonen `model=reactive-hypo-v2`, `shadowTuned=true`.
> Tuned params: `likely=7`/`urgent=8`, `safeNadirDamping`, `patternRecencyDays=7`.
>
> _Eerder (2026-06-04, commit `f280478`): meal-onset/`riseFromTrough`-features in V2-shadow._

### Maaltijddetectie

- **Niveau-gate voor de reactieve-daling-escalatie** (`scripts/lib/meal-detector.mjs`,
  `nightscout-overlay/rate-overlay.js`). `scoreReactiveMealRisk` stuurt een `reactive-drop` nu op de
  **verwachte bodem** (`projectReactiveNadir` = `currentMmol - max(0, (typicalDrop + undershoot) - dropFromPeak)`)
  t.o.v. universele klinische drempels in `MEAL_DEFAULTS` (`watchMmol` 4.5, `alertMmol` 3.9, `seriousMmol` 3.0,
  configureerbaar). Een daling die ruim boven 3.9 bodemt (bv. normale klaring 11 → 9) blijft `low` en escaleert
  niet meer; een daling richting < 3.9 / < 3.0 wordt `high` / `urgent`. Snelheid zonder niveau escaleert niet
  langer (kleine adrenerge bump blijft). Dit vervangt de oude vaste basis-score + huidig-niveau-bonus die
  benigne dalingen al op `watch`/`urgent` zette.
- **Badge-basiskleur volgt het risico-niveau**: rustig grijs (`low`), amber (`watch`), rood (`high`/`urgent`).
  Rood is daarmee voorbehouden aan een daling die werkelijk de hypo-zone in projecteert.
- **Tests**: nieuwe `scripts/run-meal-risk-check.mjs` (`npm run meal:risk`, in `meal:check`); de parity-check
  (`scripts/check-meal-overlay-parity.mjs`) is uitgebreid van substring-canaries naar gedragspariteit via
  sliding replay (incl. risico-scoring en episode-boekhouding), zodat drift tussen overlay en shared module faalt.

### Prestatie

- **MongoDB-indexen voor `prediction_snapshots` + `user_feedback`** (`scripts/libreview-nightscout-sync.mjs`).
  `getLatestPredictionSnapshot()` deed bij elke overlay-refresh `find({}).sort({createdAt:-1}).limit(1)` —
  een full collection scan + in-memory sort over álle snapshots (~24k, groeit ~1440/dag). De per-cyclus
  snapshot-upsert filterde ongeïndexeerd op `entryIdentifier`, en `user_feedback` werd met
  `createdAt`-`$gte`-ranges gescand. `ensureAuxIndexes()` is uitgebreid en wordt nu óók vanuit
  `writePredictionSnapshots` aangeroepen (bouwt de indexen al bij de eerste sync-cyclus i.p.v. pas bij de
  eerste feedback-request):
  - `prediction_snapshots`: `{ createdAt: -1 }` (hot-path sort), `{ outcomeEvaluated: 1 }` (train/summarize),
    en `{ entryIdentifier: 1 }` **unique + partial** (`$type:'string'`) → snelle upsert + dedup-guard, met
    legacy/PDF-snapshots (`entryIdentifier: null`) buiten de constraint.
  - `user_feedback`: `{ createdAt: -1 }`.
  Dup-check vooraf: bij bestaande dubbele live-identifiers wordt de unique index overgeslagen (alleen een
  waarschuwing, geen non-unique index die de latere unique-upgrade stil zou blokkeren); na dedup + herstart
  wordt hij schoon aangemaakt. Alles idempotent en in `try/catch`. Live geverifieerd: unique index kwam
  schoon op ~24k bestaande snapshots = geen dubbele live-identifiers. Zie CGM.md → "MongoDB-indexen".

### Toegevoegd

- **Maaltijddetectie regressiesuite + deploy-runbook** (`mealdetectie.md`, `scripts/meal-fixtures/`,
  `scripts/run-meal-fixtures.mjs`, `scripts/check-meal-overlay-parity.mjs`). De live rising-gate is strakker
  tegen sensor-spikes/langzame drift en wordt bewaakt tegen drift tussen overlay en shared testmodule. Nieuwe
  deploy-notitie: na overlay-wijzigingen `nightscout-ui` met `--force-recreate` opnieuw maken, anders kan nginx
  het oude bind-mount bestand blijven serveren.
- **Rebound-forecast (shadow-first): voorspelt het herstel ná een reactieve dip** (`scripts/lib/rebound-profile.mjs`,
  `scripts/build-rebound-profile.mjs`, `scripts/evaluate-rebound-forecast.mjs`). Onderzoek op de eigen episodes
  toonde dat de rebound-piek **niet** met de dip-diepte/drop/dalingssnelheid correleert (alle |r|<0,2): counter-regulatie
  brengt je telkens terug naar een persoonlijk **set-point (~7,3 mmol)**. De forecast is daarom een vaste empirische
  herstelcurve (mediaan + p10–p90 band, 0–90 min na de nadir), verankerd op de bevestigde nadir — geen zwaar
  per-episode model.
  - **Out-of-sample geverifieerd** op 12 dagen live 1-min data (temporele split, 67 curves): MAE +15/30/45/60 =
    **0,77 / 1,05 / 1,28 / 1,22 mmol**, verslaat beide baselines (set-point én plat@nadir) op elke horizon, geen overfit.
  - **Train/serve-pariteit**: één gedeelde pure kern voor de generator én de evaluator. Eist complete kern-horizonten
    `[0,15,30,45,60]` per curve, anders wordt elke horizon over een scheve subset berekend (gaf een niet-monotone dip op +60m).
  - **Eerlijke caveats meegeleverd**: ~8% van de rebounds schiet door ≥10 mmol → tonen als band, niet één lijn. De band
    onderdekt nog iets out-of-sample (67% binnen p10–p90 bij n=40 train) → meer episodes nodig vóór een UI-band; dat is
    exact wat `npm run rebound:eval` bewaakt. Nacht-stratum (n<12) wordt onderdrukt.
  - **Raakt niets live aan**: alleen lezen + een profiel-artefact wegschrijven. `npm run rebound:profile` / `rebound:eval`
    (libre-container), beide met `--self-test`. Serve-time `reboundForecast` + UI-band volgen pas later (V2-draaiboek).
- **Visueel maaltijd-badge rechtsboven in de grafiek, met dynamische herkenning** (`nightscout-overlay/rate-overlay.js`).
  De meal-onset-detectie leefde tot nu toe alleen server-side (`scripts/lib/hypo-features.mjs` stap 8 →
  `mealOnset`, door `reactive-hypo-detector.mjs` gebruikt als watch-floor). De overlay detecteert het nu
  client-side (`detectMealOnset`) en toont rechtsboven in `#chartContainer` een badge
  **"🍽️ Maaltijd <snel|normaal|langzaam> · Xm"** (X = minuten sinds de bodem ≈ tijd sinds maaltijd).
  - **Dynamisch i.p.v. één vaste drempel.** Een analyse van de eigen 216 episode-stijgingen liet een
    spreiding van ~16× zien (p5 0,054 → p95 0,237 mmol/L/min). De oude vaste 0,8 mmol/15 min-drempel lag op
    het p5 en miste de traagste ~5% (sluipende drifts die 45-60 min later alsnog een reactieve daling geven),
    en vuurde onnodig laat op steile spikes. Nu een **multi-tijdschaal OR-gate**, maximaal-vroeg afgesteld:
    *snel* (rate10 ≥0,10 + ≥0,5 mmol vanaf bodem, al na ~5 min), *normaal* (≥0,6 mmol in ~10 min),
    *langzaam* (≥0,9 mmol over ≥25 min). 0,5 mmol-vloer + "nog stijgend" weren ruis.
  - **Snelheidsklasse** volgt de eigen kwartielen (>0,16 snel / <0,09 langzaam / ertussen normaal); badge
    krijgt een kleur-accent (snel = rood, langzaam = geel) náást het tekst-label.
  - Geen extra API-call: berekend uit de readings die de overlay al heeft. Cache-buster → `meal-dynamic-20260614e`.
  - **Pre-dip fase + zelfkalibratie (portable).** Data-analyse liet zien dat in 99% van de meetbare episodes een
    pre-dip vooraf gaat aan de stijging; 86% is ≥0,3 mmol en 77% is ≥0,4 mmol (mediaan ~0,9 mmol, p25 ~0,47).
    Dit past bij een cephale/anticipatoire insulinerespons. Het badge kent nu
    een tentatieve voorfase **"🍽 Dip — mogelijk maaltijd"** (blauw) die naar **"🍽️ Maaltijd \<snel|normaal|langzaam\> ·
    Xm · dip ~HH:MM"** schakelt zodra de stijging bevestigt; de "dip ~HH:MM" is de verwachte reactieve dal o.b.v.
    de eigen piek→dal-mediaan. **Alle drempels zijn nu zelfkalibrerend** (`calibrateMealFromHistory` +
    `loadMealCalibration`, localStorage `cgm-meal-calibration-v1`, zelfde patroon als `calibrateFromHistory`):
    snel/langzaam-grenzen (p75/p25 stijgsnelheid), pre-dip-grootte en piek→dal-tijd worden per browser uit de eigen
    historie geleerd, met generieke defaults voor nieuwe gebruikers (samples < 12). Geen drempel meer hardcoded op
    één persoon → drop-in bruikbaar voor anderen. Cache-buster → `meal-predip-20260614f`.
  - **Reactieve-daling risicoscore, dynamisch per gebruiker.** De maaltijd-badge kent nu een derde fase
    **"↘ Reactieve daling \<let op|hoog|urgent\>"** zodra een daling volgt op een recente maaltijdpiek. De score
    combineert de eigen drop-rate-percentielen (p50/p75/p90), pre-dip, stijgsnelheid, piek→dal-patroon en het
    bestaande hypo-risico. Extra kalibratievelden (`dropRates`, `rises`, `drops`, `undershoots`) maken de grenzen
    relatief aan de gebruiker; generieke defaults worden alleen gebruikt totdat genoeg eigen historie beschikbaar is.
    De fallback is conservatief en `reactive-drop` vereist een actieve daling op de korte trend, zodat normale
    post-piek terugkeer bij nieuwe gebruikers niet te snel als hoog risico verschijnt. Cache-buster →
    `meal-risk-dynamic-20260614h`.
  - **Episode-memory + portable kalibratie.** De overlay onthoudt nu een lopende maaltijdpiek in
    `cgm-meal-episode-v1`, zodat een zware stijging tijdens een plateau niet wordt vergeten voordat de reactieve
    daling inzet. De episode vervalt pas bij terugkeer richting baseline of na 180 minuten. In het AI-paneel →
    Instellingen staan nu **Export/Import**-knoppen voor `cgm-meal-calibration-v1`, met schema-validatie,
    numerieke filtering en sample-capping. Cache-buster → `meal-memory-export-20260614i`.
  - **Maaltijd-vak verplaatst + uitgebreid (vierkant kaartje links vóór de klok).** Het badge stond als smal
    horizontaal pilletje rechtsboven in de grafiek; het is nu een **gestapeld vierkant kaartje** (icoon boven,
    detail eronder; afgeronde hoek + schaduw, vorm gelijk aan het hypo-vak) **verankerd aan de linkerrand van de
    klok** (`#currentTime`), in de zwarte ruimte links ervan, verticaal gecentreerd. De positie wordt herberekend
    bij elke render, bij window-resize en in de layout-passes na laden; scroll-proof via document-coördinaten.
    `positionMealBadge` ankert op `clock.left − vakbreedte − 12px` (de bounding-box van `#currentTime` is breder
    dan de zichtbare tijd, dus ankeren op de klok-rechterrand viel in het hypo-vak). De inhoud toont nu **per fase
    zo veel mogelijk**: *reactive-drop* → piek→huidig, Δ mmol, daalsnelheid/min, min na piek, dip ~HH:MM, risico
    (niveau + numerieke score); *rising* → huidige mmol, ↗ stijging, snelheid/min, minuten, dip, risico;
    *plateau* → piek, min na piek, dip, risico; *dip* → pre-dip + huidige mmol. Vak verbreed naar 150px (mobiel
    128px) voor de getallen.
  - **`MEAL_BADGE_ALWAYS_VISIBLE`** (`nightscout-overlay/rate-overlay.js`): kan tijdelijk op `true` om het
    maaltijd-vak altijd zichtbaar te maken voor positie/layout-tests. Bij geen echte detectie toont het vak echte
    idle-context zoals huidige waarde, trend/rate, recente puntcount, 60m bereik en de belangrijkste blocker; echte
    meal-fases blijven leidend en er wordt geen fake reactive-drop getoond. De blocker wordt nu afgeleid uit dezelfde
    getrapte rising-poort als `detectMealState` (`mealGateReason()`): i.p.v. losse vaste drempels toont het vak de
    dichtstbijzijnde poort met de ontbrekende voorwaarde (`mist: ≥0.5 mmol + ≥5m`, …) of `daling — geen reactieve
    drop`, zodat de uitleg niet meer uit de pas loopt met de echte detectiebeslissing.
  - **Glucose-volatiliteit in Stats/AI.** De 24u stats tonen nu een **Volatiliteit score** op basis van de snelste
    recente sample-beweging. De AI-tab krijgt een sectie **Glucose-volatiliteit · snelle sprongen** met snelste
    stijging/daling en de grootste recente piek→dal sprongen uit de episode-database. Formulering blijft
    patroon-gebaseerd en wijst op CGM-lag/vingerprikbevestiging bij snelle dalingen. Cache-buster →
    `volatility-impact-20260614j`.
- **Offline Gemini-export tool** (`scripts/export-gemini-cgm.mjs`, `npm run export:gemini`). Een pure Node-
  exporter (geen DB) die `cgm_entries.json` omzet naar `exports/gemini-cgm/`: `gemini-cgm-export.json`
  (metadata + exacte samenvatting + alle rijen), `gemini-cgm-readings.csv` (mg/dL + mmol/L) en
  `GEMINI_PROMPT.md` (kant-en-klare prompt met de berekende cijfers, zodat een externe LLM niet hoeft te
  gokken). Berekent mean/SD/CV/GMI, percentielen, TIR/TBR/TAR en de snelste sample-tot-sample stijging/daling.
  De export documenteert expliciet dat de bron grove ~30-min PDF-historie is (niet live 1-min MongoDB) en
  waarschuwt tegen verzonnen episodes/diagnoses. `exports/` is git-ignored (regenereerbare output).
  De prompt is afgestemd op het profiel (reactieve hypoglykemie zonder diabetes): de below-range/hypo-cijfers
  (TBR <3.9, very-low <3.0) staan primair, GMI/TIR/TAR alleen als descriptieve context, met de waarschuwing
  dat TBR een ondergrens is door de 30-min resolutie. De grootste sample-tot-sample stijging/daling is gemarkeerd
  als `resolutionLimited` (netto verschil tussen twee 30-min punten, geen gemeten CGM-helling).
- **Resolutie-bewuste export + live MongoDB-dump.** De exporter detecteert nu de mediane sample-interval en
  past de framing automatisch aan. Bij grove ~30-min historie blijft de conservatieve framing
  (`resolutionLimited: true`). Bij ~1-min live data vervalt de "TBR is ondergrens"-caveat en rapporteert de
  export de **steilste volgehouden helling over een ~15-min venster** (`windowMin: 15`, `resolutionLimited: false`)
  op een **median-of-3 despikede reeks** (zelfde spike-filter als het live systeem) — nodig omdat ~9% van de ruwe
  1-min stappen niet-fysiologisch is (sensor-spikes) en een losse-sample-rate daardoor onbruikbaar is. Nieuw
  `scripts/dump-entries-mongo.mjs` (`npm run dump:entries`) dumpt de live `entries`-collectie (default laatste
  21 dagen) naar een exporter-compatibel `exports/live-entries.json`; `npm run export:gemini:live` doet dump +
  high-res export in één stap. Draait ín de Docker-container (mongo heeft geen host-poort), dus op de iMac
  (geverifieerd op 22.7k 1-min rijen: steilste 15-min daling ~0.40 mmol/L/min, een reactieve-hypo crash 9.7→3.3).

### Gewijzigd

- **Cijfer-correcties in Statistiek/History/Inzichten + forecast losgekoppeld van de weergave-toggle.**
  Grondige doorrekening van alle getallen in de Stats/AI-overlay en de momentum/verhouding-vakjes;
  vier punten gecorrigeerd:
  - **Forecast & hypo-risk-rate ontkoppeld van de momentaan/verhouding-toggle** (`nightscout-overlay/rate-overlay.js`).
    De forecast-blend (`getForecastRateMmol`) en `getPrimaryRate`/`averageRateText` wogen op `actualMinutes`;
    in **momentaan**-modus is dat voor élk vakje ~1 min, waardoor alle vensters in de eerste band vielen en de
    forecast degenereerde tot een ~2-uurs vlak gemiddelde (een daling van −0.15 mmol/min werd als −0.02 getoond).
    De forecast/risk-basis is nu **altijd** verhouding-stijl (trailing average) via een nieuwe `currentForecastRows`,
    los van wat het grid toont. Een wéérgave-voorkeur verandert dus nooit meer de hypo-risk-rate. Default
    (verhouding) gedrag is byte-voor-byte identiek; alleen momentaan stopt met degenereren.
  - **Eén gedeelde dekkings-noemer** (`expectedSamples()`): `getAiStats`/`getAiHistory`/`getAiDayReview`/
    `getGlucoseEventsFeed` hardcodeerden 1440 metingen/dag terwijl `getSourceHealth` de noemer uit het werkelijke
    mediane meetinterval afleidde. Nu rapporteren alle paden dezelfde dekking%, ook als de cadans van 1/min afwijkt.
  - **`lows`-telling in `getAiStats`** loopt nu via `buildThresholdLows()` i.p.v. een inline-lus: splitst correct bij
    datagaten >30 min en sluit een lopende low aan het venster-einde af (de oude lus deed beide niet).
  - **High→low-dedup**: één low kan niet langer door meerdere highs geclaimd worden (greedy, vroegste ongebruikte
    low per high) in `buildHighToLowContext`, de Inzichten-kaart en de dag-review.

- **Reactieve-hypo statistieken: tijdzone, herstel-mediaan en severity volgens ADA-niveaus.**
  Drie correcties uit een doorlichting van de hypo-cijfers, getriggerd door afwijkende tijden in de Inzichten-kaarten:
  - **Tijdzone in server-gerenderde Inzichten-kaarten** (`scripts/libreview-nightscout-sync.mjs`). De kaarten
    "recente lows/dips" en "Recentheid episodes" gebruikten `toLocaleString('nl-NL')` zónder `timeZone`, wat de
    tijdzone van het server-proces pakt (= UTC in de Docker-container). Server-tijden weken daardoor 2u af van de
    client-panelen (Statistiek/Explore/Lows renderen client-side in CEST). Nieuwe helper `fmtLocalNL()` forceert
    `LIBREVIEW_TZ` (`Europe/Amsterdam`), consistent met `dayKeyInTz`/`localDayRange`. Voorbeeld: een low van
    2,83 mmol toonde `13:29` in Inzichten vs `15:29` overal elders → nu overal `15:29`.
  - **Herstel-mediaan zonder null-vervuiling** (`summarizeReactiveEpisodes` + `getEvaluation`). Episodes die binnen de
    horizon niet herstelden hebben `recoveryMinutes = null`; via `Number(null) === 0` glipten die door het
    `Number.isFinite`-filter en telden als "0 min herstel", wat het herstel kunstmatig snel maakte. Nu uitgesloten vóór
    de mediaan; `getEvaluation` gebruikt voortaan dezelfde `median()`-helper (gemiddelde van twee middelste) i.p.v. de
    bovenste-van-twee. (In de huidige 14d-data had maar 1/75 episode `null`, dus de getoonde "1m herstel" blijkt reëel —
    snelle dips veren echt binnen ~1 meting terug — niet langer beïnvloed door de bug.)
  - **Episode-severity volgt ADA/EASD/IHSG-niveaus** (`scripts/lib/episode-builder.mjs`). `episodeSeverity` zette élke
    `single_point_low`/`possible_compression_low` op `uncertain`. Een korte, scherpe dip naar <3,0 mmol/L (Level 2,
    "klinisch significant ongeacht duur") werd daardoor onterecht weggezet. Nu: `possible_compression_low` blijft
    `uncertain` (mechanisch sensor-artefact), `single_point_low` blijft `uncertain` alleen bij nadir ≥3,0 (Level 1), en
    een nadir <3,0 valt door naar de normale severity (`severe`). Past bij het zeldzame, snelle reactieve-hypo profiel.
    Vereist een episodes-rebuild (de loop doet dit elke `EPISODES_BUILD_INTERVAL_MINUTES`). Zie `hypo.md` → *Episode severity*.

### Toegevoegd

- **Drempel-lows naast reactieve daal-episodes ("een low is een low")** — de Stats & AI-overlay
  telde lows alleen via de reactieve piek→daling episode-builder (eist een piek ≥7.5 mmol + daling
  ≥1.0 mmol vóór de low, en houdt één nadir per daling). Daardoor toonde "Low episodes" er bv. 1
  terwijl de Libre-app en de gekleurde puntjes op de Nightscout-lijn 3 dips <3.9 lieten zien: lows
  zonder voorafgaande spike, of meerdere dips binnen dezelfde daling, vielen weg. Nu telt het
  dashboard óók elke aaneengesloten run onder 3.9 als losse low, **náást** de reactieve episodes —
  beide blijven zichtbaar.
  - Nieuwe pure helper `buildThresholdLows(rows)` in `scripts/libreview-nightscout-sync.mjs`
    (nadir/duur/puntaantal/burden per run; datagat >30 min splitst een run). Staat los van
    `scripts/lib/episode-builder.mjs`, die ML/backtest voedt en **ongemoeid** blijft.
  - Dag-feed (`GET /_ai-review/day`) krijgt veld `thresholdLows`; de dag-samenvatting toont nu eerlijk
    beide: `… · N lows <3.9 · M daal-episodes · …`.
  - Overlay: twee kaarten ("Lows <3.9" drempel + "Daal-episodes" reactief), een sectie
    "Lows < 3.9 vandaag (alle)", en dezelfde sectie in de meerdaagse dagdetail. De reactieve
    secties heten nu expliciet "Reactieve lows … (piek→daling)" zodat de twee niet meer dezelfde
    naam delen. De drempel-lows zijn **uitklapbaar** (tik = inline metrics-detail: nadir, duur
    <3.9, aantal metingen, hypo-belasting, start/eind) — gerenderd uit de feed-velden zelf, dus
    zonder extra endpoint of `reactive_hypo_episodes`-anchor.
- **Stats & AI-overlay uitgebreid met app-stijl analyses** — de bestaande tabs zijn verrijkt
  zodat de overlay dezelfde informatie toont als een gepolijste CGM-app, zonder nieuwe
  native shell:
  - *Inzichten*: Home-samenvatting bovenaan — TIR-donut (24u, conic-ring laag/bereik/hoog),
    kaarten Gem. 24u / TIR 24u / CV 7d, en een "Inzicht van vandaag"-tekstblok.
  - *Statistiek*: 7/14/30/90-periodeknoppen, Δ-badges t.o.v. de **vorige gelijke periode**
    (TIR/TBR/gemiddelde/CV; backend `trend` vergelijkt nu `[from-days, from)`),
    een echte **AGP** met percentielbanden p10–p90 / p25–p75 + medianlijn p50 (nieuwe
    per-uur percentielen in de stats-endpoint), en een **24-uurs TIR-heatmap-balk**.
  - *History*: **Glucose Events**-feed per dag — dag-tegels (TIR/AVG/PIEK/CV), high-episodes
    als uitklapbare diepteanalyse, en een intraday tijdlijn (eerste meting, lokale piek,
    high-episode + herstel, stabiel venster). Nieuwe pure builder
    `scripts/lib/glucose-events.mjs` (gedeeld door endpoint + test `glucose-events:check`)
    en endpoint `GET /ai-review/glucose-events?date=`.
  - *Explore* (nieuwe tab): blader door recente high/low-episodes → tik voor de
    diepteanalyse (metrics incl. stijg-/daal-/herstelsnelheid in mmol/L/min, pattern-dots
    per dag, severity-banden, vergelijkbare episodes) via `GET /ai-review/explore-episodes`.
- **Aanloop-features in de episode-similarity** — `findSimilarEpisodes` matcht nu naast
  piek + daling + timing ook op de *aanloop* naar de piek: `riseRate15m` (gladde gem.
  stijgsnelheid over 15 min vóór de piek) en `riseFromBaseline` (spike t.o.v. baseline
  `[-40,-15]` min). Onderzoek wijst de stijgsnelheid aan als sterke voorspeller van
  reactieve hypo (steile, hoog-GI spike → crash); voorheen telden twee episodes met
  dezelfde piek+daling maar een totaal andere aanloop als "gelijk". De velden worden
  identiek live (`hypo-features.mjs`) én offline (`build-episode-vectors.mjs`) berekend
  (train/serve-pariteit). De afstand is nu een RMS over de actieve dimensies
  (`sqrt(sum/dims)`) i.p.v. `sqrt(sum)`, zodat een extra dimensie de drempel niet
  opblaast; `SIM_MAX_DIST` = 0.866 (= 1.5/√3) reproduceert exact het oude 3-dimensie-gedrag.
  Oudere `episode_vectors` zonder de nieuwe velden vallen niet weg (gegate dimensies).
  **Gedeployed 2026-06-14:** vectoren herbouwd en `hypo:backtest`/`hypo:tune` gedraaid; de
  tuner koos `patternRecencyDays=7` en V2 haalde de activatiegate. `SIM_MAX_DIST=0.866`
  bleef ongewijzigd (nog niet als tuner-parameter; zie Gefixt voor de openstaande her-ijking).
- **Automatische episode-build in de sync-loop** — de `libreview-sync` `--loop`-modus
  herbouwt `reactive_hypo_episodes` nu vanzelf elke `EPISODES_BUILD_INTERVAL_MINUTES`
  (default 15, in de compose-`environment`; 0 = uit). Voorheen liep de collectie achter
  tot iemand handmatig `episodes:build` draaide (kon uren staleness opleveren). De CLI
  `build-reactive-hypo-episodes.mjs` is herschreven naar een exporteerbare
  `buildReactiveHypoEpisodes()`, zodat CLI en loop dezelfde builder delen (CLI blijft
  werken via een `import.meta`-guard).
- **High→low context met alle vier de tijdstippen** — de high→low-regels (Statistiek-tab
  én dagdetail) tonen nu expliciet high-piek, high-einde, start-daling (low-piek) en
  low-nadir, plus de deelintervallen (high-duur, high→daling-gap, dalingsduur). Voorheen
  mengde één regel referentiepunten (getoond high-piek→low-nadir, maar gemeten
  high-einde→low-piek), waardoor er tijd leek te missen. Beide views delen nu
  `renderHighToLowItem`; het dag-endpoint levert daarvoor `highEndAt`/`highDurationMinutes`.

- **Episode-review in de overlay zonder eigen curve** — de low/high-detailweergave
  tekent géén SVG mini-curve meer: Nightscout toont de glucosegrafiek al, dus
  `getAiEpisodeDetail` levert geen `readings` meer terug. In plaats daarvan is de
  episode-kaart een **gefocuste review**: context, trigger, cohort-vergelijking,
  navigatie tussen episodes en notitie. Nieuw daarin, deterministisch:
  - **Pattern-analyse** (`buildPattern`): hoeveel episodes van hetzelfde type in
    hetzelfde dagdeel-venster (nacht/ochtend/middag/avond) over 30d (low) / 14d (high),
    met tijdsbereik (`fromHM`–`toHM`) en verdeling per dagdeel. Tijdzone via `LIBREVIEW_TZ`.
  - **Vergelijkbare episodes** (`similar`): top-5 dichtstbijzijnde dips/highs op
    nadir/piek; in de overlay **klikbaar** → laadt die episode in dezelfde kaart.
  - **nginx write-hardening:** `POST` op `/_ai-review/events` en `/_ai-review/reminders`
    mag alleen vanaf private ranges + Tailscale (`100.64.0.0/10`) + localhost
    (`limit_except GET`); `GET` (lezen) blijft open op het LAN. Defense-in-depth.
  - **Indexen + retentie:** `ensureAuxIndexes` legt idempotent indexen aan op
    `cgm_events` (`eventAt`) en `helper_reminders` (`key`, `createdAt`); transiente
    reminder-ack/snooze-state ouder dan 30d wordt opgeruimd (gebruikersnotities in
    `cgm_events` blijven staan).

- **SmartXdrip-productlagen compleet (deterministisch, gratis)** — alle resterende
  review-/productlagen uit `llm.md` §14–20 zijn gebouwd, puur Mongo-reads (geen LLM/quota):
  - **Source-health** (`/ai-review/source-health`) + altijd-zichtbare banner met status
    goed/let op/slecht (leeftijd laatste meting, dekking 24u/14d, langste gat, `reasons[]`).
  - **Helper-reminders** (`/ai-review/reminders` GET genereert, POST snooze/ack via
    `helper_reminders`) als niet-medische chips in de banner — géén alarm/sound/vibration.
  - **Notes/event-logging** (`cgm_events` + `/ai-review/events`) met quick-log presets
    (maaltijd/snack/voelde-hypo/vingerprik/beweging/actie); events koppelen aan de
    dichtstbijzijnde meting (±15 min). Grootste hefboom voor reactieve-hypo trigger-duiding.
  - **History-tab** (`/ai-review/history`) met dag-voor-dag dagcards; klik → dagdetail met
    dagreview + klikbare low-episodes.
  - **Pattern cards** in Inzichten (`/ai-review/patterns`): week-vs-week, kwetsbaar venster,
    high→low, datakwaliteit, artefact-check + recente notities.
  - **Evaluatie-metrics** (`/ai-review/evaluation`): episodes per severity, hypo-burden,
    mediane recovery, % matige kwaliteit/vingerprik/postprandiaal, feedback-telling — getoond
    onderaan de Statistiek-tab.
  - **Settings** (localStorage): statistiek- en History-venster (7/14/30/90d); doelbereik als
    referentie. Raakt de veiligheidskritische detector niet.
  - **Niet-klinische UI-labels** (`AI_LABELS`/`aiLabel`): interne velden → begrijpelijke taal.
  - **Safety-hardening**: chat-/rapport-prompts formuleren voorzichtiger bij lage datadekking
    en verwijzen door bij ernstige symptomen (`ai-review-core.mjs`).

- **Low/High Episode-detail (SmartXdrip-stijl, gratis)** — nieuw endpoint
  `GET /ai-review/episode-detail?type=low|high&peakAt=<iso>` (`getAiEpisodeDetail`) geeft
  deterministische metrics, datakwaliteit-flags, nabije feedback en `notableReasons[]`.
  High-metrics worden live uit `entries` berekend (trapezoïdale `integrateBeyond`: duur/area
  boven 10 en 13.9, herstel, `followedByLow`). De overlay maakt low- (Statistiek-tab) en
  high-episodes (dagreview) klikbaar — puur Mongo-reads, **geen LLM/quota**. Geproxyd via
  nginx als `/_ai-review/episode-detail`. Zie llm.md §19.3/19.4 en §20.5. _(De aanvankelijke
  SVG mini-curve is later verwijderd; zie de bovenste entry — Nightscout toont de curve al.)_

- **AI-review met overlay-knop (Ollama Cloud)** — de optionele AI-laag is nu bedienbaar
  vanuit de overlay. Nieuwe gedeelde kern `scripts/lib/ai-review-core.mjs` (`runAiReview`,
  JSON-mode + schema-in-prompt + retry omdat Ollama Cloud geen strikt schema afdwingt),
  gebruikt door zowel de CLI (`npm run ai:review`) als de sync-server. Server-endpoints
  `POST /ai-review/run` (lock + min-interval), `GET /ai-review/latest`,
  `GET /ai-review/models`, geproxyd via nginx als `/_ai-review/*`. Overlay krijgt een
  AI-knop + paneel met model-dropdown (⭐ aanbevolen-groep), run-knop en weergave van
  observaties/vragen. **Feedback-lus:** de review neemt recente `user_feedback` mee zodat
  observaties persoonlijk/cumulatief worden. Optionele periodieke loop via
  `AI_REVIEW_INTERVAL_MINUTES` (default uit). Config in gitignored `.env.ai` (via
  `env_file required:false` in de `libreview-sync` service). De AI neemt **nooit**
  alarm-/actiebeslissingen. Ontwerp + roadmap in `llm.md`.
- **Multi-provider AI-router** (`scripts/lib/ai-router.mjs`) met fallback-volgorde via
  `AI_ROUTER_PROVIDERS` + per-provider `AI_<NAAM>_*`; legacy `AI_CHAT_*` blijft werken.

### Gefixt

- **Dubbele daal-episodes met identieke piek (`reactive_hypo_episodes`)** — de overlay toonde
  bv. drie "dips vandaag" met exact dezelfde `peakAt` (02:02:09) en piek, maar oplopend-diepere
  nadirs. Oorzaak: de upsert-sleutel was `peakAt|nadirAt`. De piek is het stabiele anker van een
  daling, maar de nadir verschuift dieper/later zolang de daling nog loopt. Elke herhaalde
  build-run (live elke ~60s) berekende voor dezelfde piek een andere nadir → nieuwe sleutel →
  een extra document i.p.v. een update. Eén echte daling werd zo opgesplitst over meerdere docs,
  waardoor de werkelijke diepte versplinterde (het 02:02-geval was eigenlijk één **hypo** met
  nadir 3.885 mmol, verstopt als drie `safe_drop`-dips). Fix: `episodeKey` ankert nu op `peakAt`
  alleen (`scripts/build-reactive-hypo-episodes.mjs`) — binnen één run is een piek uniek per
  episode (de builder springt na elke nadir door), en latere runs updaten hetzelfde document.
  - Nieuw eenmalig migratiescript `scripts/dedup-reactive-hypo-episodes.mjs` (`npm run episodes:dedup`,
    dry-run by default, `--apply` om te schrijven): collapse't dubbele peakAt-groepen (diepste nadir
    blijft, feedback wordt gemerged) **én** normaliseert álle oude `peakAt|nadirAt`-sleutels naar het
    nieuwe formaat, zodat `dedup → build` idempotent is.
  - **Gevalideerd op de live-DB (2026-06-14):** 284 → 272 episodes, 0 resterende duplicaten, stabiel
    na ≥1 sync-cyclus. Operationele les: een datamigratie op een collectie die de live `libreview-sync`-
    loop óók schrijft is zinloos tot de container herstart is (Node hot-reload't de bind-mount niet) —
    eerst `compose restart libreview-sync`, dán opruimen.
- **Outcome-evaluatie was stil dood sinds de libreview-overstap — `snapshots:evaluate` deed
  niets** — `evaluate-predictions.mjs` koppelt elke `prediction_snapshot` aan zijn `entry` om
  achteraf de werkelijke uitkomst (laagste mmol binnen 30/60/120/180 min → true/false
  positive/negative) te bepalen. De join ging op `snap.entryId` (ObjectId), maar dat veld
  bestaat alléén op de oude PDF-import-snapshots. De **live libreview-pijplijn**
  (`libreview-nightscout-sync.mjs`) schrijft snapshots met uitsluitend `entryIdentifier`
  (string) en géén `entryId` — net zoals de hele overlay/sync snapshots↔entries al op
  `identifier` joint. Gevolg: sinds de bron eind mei van PDF naar LibreView omsloeg, deed
  élke `snapshots:evaluate`-run stil `updated: 0` (de `if (!entry) continue` sloeg alles over
  zónder te tellen). 19.9k snapshots bleven `outcomeEvaluated:false`; `train-risk-model`
  (leest `outcomeEvaluated:true`) en de FP/missed-tellingen in `summarize-days` liepen
  daardoor op verouderde data. Dit is dezelfde klasse als de curve-vector-skew hieronder:
  een join/feature die bij serving stil verdween. Fix: de evaluator joint nu op `entryId`
  én valt terug op `entryIdentifier ↔ entries.identifier`, en telt voortaan een `unlinked`
  zodat een toekomstige mismatch niet opnieuw onzichtbaar wegloopt. **Gevalideerd op echte
  data (2026-06-14):** 19.916 snapshots geëvalueerd, `unlinked: 0`; backlog viel terug van
  ~19.9k naar 4 (alleen de meest recente, waarvan het 30-min-uitkomstvenster nog niet
  voorbij is). Tegelijk de twee bijbehorende batch-collections bijgewerkt die sinds 29 mei
  achterliepen: `entry_features` (4.052 → 23.999) via `features:build` en `daily_summaries`
  (48 → 64 dagen) via `summaries:build`.
- **Curve-vector werd nooit geladen — curve-match was stil dood** — `build-episode-vectors.mjs`
  slaat per episode een genormaliseerde curve op in het top-level veld `vector`, en
  `findCurveMatches` (component 6 / `patternScore` +2) leest dat veld. Beide
  `loadEpisodeVectors`-projecties (live in `libreview-nightscout-sync.mjs` én offline in
  `evaluate-hypo-detector.mjs`) lieten `vector` echter weg, waardoor `findCurveMatches`
  **altijd `null`** teruggaf: `curveMatchCount`/`curveHypoRatio`/`curveSimilarity` stonden
  permanent op 0/null en de curve-bijdrage aan de patroonscore deed live én in de backtest
  niets. Dit is een vorm van training-serving skew: de curve-feature was bij serving stil
  afwezig. Projectie aangevuld met `vector: 1`; een sanity-check bevestigt dat de curve-match
  nu vuurt (0 → 8 matches op identieke vormen). **Gevalideerd op echte data (2026-06-14):**
  na herbouw draaide de backtest over 21 727 punten / 87 hypo-onsets; de tuner (grid 288,
  train 42 / test 45 onsets) activeerde V2 — out-of-sample **test recall 1.0 (0 gemist) vs
  V1 0.867 (6 gemist)**, precision 0.234 vs 0.212, mediane lead 22.8 min. Openstaand:
  `SIM_SCALES`/`SIM_MAX_DIST` zijn nog hand-gekozen i.p.v. door de tuner geleerd.
- **Dubbele, uiteenlopende similarity-match in de sync geconsolideerd** — de sync deed per
  meetpunt twee aparte matches: een losse `findSimilarEpisodes` (alleen piek+daling+timing,
  op de lokale piek) voor de V1-forecast/reden, én `patternFromFeatures` (volledige
  featureset incl. `riseRate15m`/`riseFromBaseline`, op de feature-piek) voor V2. Sinds de
  aanloop-features liepen die op verschillende buren — en op een andere `minutesSincePeak`
  door de piek-tie-break. Nu voedt de gedeelde `patternFromFeatures` beide: V1-forecast
  gebruikt de geëxposeerde `pattern.correction` en de "Lijkt op N episodes"-reden komt uit
  dezelfde match. Eén bron, geen divergentie meer.

### Gewijzigd

- **Overlay-knop hernoemd `AI` → `Stats & AI`** — het paneel is grotendeels
  deterministische statistiek (Statistiek/History/Inzichten, alleen Mongo-reads);
  alleen Rapporten/Chat/Review gebruiken een LLM. De nieuwe naam dekt de lading beter.
- **Freshness-melding meet build-achterstand i.p.v. tijd sinds laatste daling** — de
  Statistiek-tab en de patterns-`freshness`-card waarschuwden ("draai episodes:build")
  zodra de nieuwste meting >3u nieuwer was dan de laatste episode-piek — wat juist de
  gezonde toestand is (stabiel in range, geen recente hypo/dip). Nu komt er een
  `episodesBuiltAt` (max `updatedAt` op de episodes) en wordt alleen gewaarschuwd als de
  build de nieuwste metingen >60 min niet verwerkt heeft. Het dubbele freshness-blok in
  de Statistiek-tab (`renderRecentEpisodes` + `renderStatsFreshness`) is teruggebracht
  tot één.

- **Precision-analyse en kandidaat-dempingen voor V2 (nog niet live geactiveerd)** —
  toegevoegd: read-only `scripts/analyze-hypo-quality.mjs` voor reproduceerbare
  kwaliteitsanalyse op de huidige data (datadekking, vector-health, V1/V2 metrics,
  pattern-bijdrage en false-positive redenen). Laatste 7-daagse analyse: V2 tuned
  blijft veiliger dan V1 (recall 0.968 vs 0.839, gemist 1 vs 5) en iets preciezer
  (precision 0.133 vs 0.126), maar false positives blijven hoog. Nieuwe tunable params
  staan default uit: `safeUncertaintyDamping` en `recentLowRecoveryDamping`. Gerichte
  7-daagse vergelijking rond de live params: baseline precision 0.133 / FP 273;
  `safeUncertaintyDamping` 0.137 / FP 264; `recentLowRecoveryDamping` 0.135 / FP 270;
  beide 0.138 / FP 263, met recall gelijk (0.968). Een brede dry-run koos
  `safeUncertaintyDamping: true` maar niet `recentLowRecoveryDamping`. De live state is
  niet overschreven; kandidaat voor live is voorlopig alleen `safeUncertaintyDamping`
  na expliciete gate/activatie.
- **Tuner refinement-modus voor FP-knoppen** — `tune-reactive-hypo-v2.mjs` houdt de
  normale grid beperkt tot de bestaande hoofddrempels en biedt `--refine-damping` voor
  vier gerichte varianten rond de beste basisparams. Zo testen we nieuwe demping zonder
  de volledige grid onnodig breed te maken.
- **Precision-knop `safeNadirDamping` (tunebaar, gevalideerd, live)** — nieuwe V2-param:
  als de actuele waarde ≥ 4.5 is én zelfs het pessimistische scenario (`worstCaseMin30`)
  boven 4.5 blijft, escaleert drop-from-peak-context niet langer naar high/urgent maar
  naar `watch` (alle hard-low veiligheidskleppen blijven). Toegevoegd aan de tuner-grid;
  de tuner koos hem op de vaste out-of-sample split en de M6-gate slaagde: tuned V2 ging
  van recall 0.824→**0.941** (mist 1 i.p.v. 3) en precision 0.083→**0.145** (boven V1
  0.130). Default uit; alleen actief via getunede params. Reden dat dit eerder "niet
  werkte": een losse in-sample live backtest is te ruisig (data drift tussen runs);
  beoordeel FP-knoppen op de bevroren tuner-split.
- **Patroon-collecties dagelijks herbouwd + idempotentie-fix** — `daily-hypo-tune.sh`
  ververst nu ook `pattern_events` (`analyze-patterns.mjs`) en `episode_vectors`
  (`build-episode-vectors.mjs`) vóór de tuner, zodat de V2-patroonherkenning meeleert
  met nieuwe episodes (voorheen bleef de vectorset statisch op 34). Daarbij bleek
  `analyze-patterns.mjs` **niet idempotent**: het deed kale inserts, dus elke run
  dupliceerde alle events en trok de live `findSimilarEpisodes`-tellingen scheef. Nu
  leegt het de collectie eerst en herbouwt volledig uit `entries`.
- **V2 component-breakdown auditbaar in snapshots** — de sync persisteert nu
  `v2Components` (per-component scores incl. `patternScore`, `reactiveScore`,
  `recentLowScore`, `dampingScore`, …) en `v2Uncertainty` per `prediction_snapshot`,
  en `/prediction/latest` geeft ze terug. Zo is achteraf zichtbaar hoeveel de
  patroonherkenning (en elke andere component) aan de V2-score bijdroeg; voorheen
  stond alleen `riskDetails` (V1) en de pattern-tellingen in het snapshot.
- **Post-hypo instabiliteit voor V2** — `buildHypoFeatures` levert nu
  `recentLowMmol`, `minutesSinceRecentLow`, `reboundFromRecentLowMmol`,
  `recentLevel1Hypo` en `recentLevel2Hypo`. `evaluateReactiveHypoRiskV2` gebruikt die
  als `recentLowScore` en veiligheids-override: na een recente diepe hypo (<3.0) blijft
  risico hoog, en bij opnieuw dalen rond laag gebied blijft het urgent. Dit voorkomt dat
  het alarm verdwijnt doordat de CGM kort boven 4.5 komt terwijl herstel nog instabiel
  is. Nieuwe regressiefixture: `scripts/fixtures/post-hypo-unstable-fall.json`. Lokaal
  en op de Docker-machine geverifieerd met `npm run detector:fixtures`; live sync
  herstart en nieuwe snapshots bevatten de recent-low features.
- **Data-quality gate voor V1 + V2 (Laag 10)** — `hypo-features.mjs` levert nu
  `features.dataQuality` met flags voor oude metingen, grote gaten, dubbele
  timestamps, out-of-order timestamps, sparse recente data en toekomsttimestamps.
  V1 en V2 lezen dezelfde quality-info: actuele lage glucose blijft altijd leidend,
  maar rate-/forecast-/context-escalaties worden conservatiever bij `watch` of
  `degraded` datakwaliteit. Regressie: `npm run data-quality:check`.
- **Spike-filter voor ruwe glucose-invoer (Laag 9)** — gedeelde
  `cleanGlucoseTimeline` / `isSinglePointSpike` in `hypo-features.mjs` filtert
  single-point artefacten met median-of-3 op de werk-timeline. De live sync gebruikt
  dezelfde schoongemaakte timeline voor `calculateRates`, `calcRateFromTimeline` en
  V2 `buildHypoFeatures`; ruwe `entries.sgv` blijft ongemoeid. Regressie:
  `npm run spike-filter:check`.
- **Overlay toont V2 episode-similarity expliciet** — de hypo-kaart gebruikt nu ook het
  `pattern`-object uit `/prediction/latest` en toont hoeveel vergelijkbare episodes V2
  ziet, hoeveel daarvan onder 4.5 gingen en het percentage. Dit maakt de persoonlijke
  episode-vergelijking zichtbaar in plaats van alleen technisch aanwezig in de snapshot.
- **Dagdeel-context voor V2 (Laag 4)** — `buildHypoFeatures` levert nu `timeOfDay`
  (`nacht`/`ochtend`/`middag`/`middag2`/`avond`, Europe/Amsterdam). De detector is 's
  nachts iets conservatiever tegen vals alarm en geeft bij middag/middag2 alleen een
  kleine bonus als er al een echte post-piek daling is.
- **Nadir-schatting uit vergelijkbare episodes (Laag 3)** — `patternFromFeatures` geeft
  nu `patternNadirMmol` door op basis van de gewogen historische drop. V2 gebruikt dit
  als aanvullend forecast-bewijs wanneer er genoeg vergelijkbare episodes zijn.
- **Curvevorm-match voor V2 (Laag 5)** — `buildHypoFeatures` bouwt een genormaliseerde
  partial curve vanaf 20 min vóór de piek tot nu. `patternFromFeatures` vergelijkt die
  met het bijpassende prefix van historische `episode_vectors` en geeft
  `curveMatchCount`/`curveHypoRatio` door; V2 gebruikt dit alleen als extra
  patroonbewijs bij genoeg matches. De overlay toont de curve-match ook in de
  patroonregel.
- **Weekdag-patroon voor V2 (Laag 7)** — `buildHypoFeatures` levert nu `weekday`.
  `patternFromFeatures` vergelijkt de huidige weekdag met historische
  `episode_vectors` en geeft een `weekdayRiskHigh`-signaal door als die dag duidelijk
  riskanter was. V2 gebruikt dit als kleine bonus, alleen bovenop echte post-piek
  context.
- **Train/serve-pariteit voor V2 (component 6 / patternScore)** — de episode-similarity
  is verhuisd naar de gedeelde module `scripts/lib/episode-similarity.mjs`
  (`findSimilarEpisodes` + nieuwe `patternFromFeatures`). De backtest
  (`scripts/evaluate-hypo-detector.mjs`) en de auto-tuner
  (`scripts/tune-reactive-hypo-v2.mjs`) laden nu `episode_vectors` en voeden V2 per punt
  hetzelfde `pattern`-object als de live-sync. Voorheen kreeg V2 in de backtest/tuner
  géén pattern, waardoor we op een andere score tunede dan we serveren. Dit was de
  blokkerende stap vóór M6-activatie (zie `hypo.md`).
  - De live-sync bouwt het V2-`pattern` nu óók via `patternFromFeatures` op dezelfde
    featureset die V2 ziet, zodat `minutesSincePeak` niet meer afwijkt door de tie-break
    in de piekselectie (live hield de nieuwste piek aan, de builder de oudste). Pariteit
    is daarmee exact i.p.v. ~99%.
  - Bekende beperking: de tuner geeft de volledige vectorset aan train én test (lichte
    look-ahead in component 6); klein effect, latere verfijning.

### Toegevoegd

- **AI-laag voorbereid (`ai_observations` / `ai_questions`)** — nieuw
  `scripts/ai-review.mjs` + `npm run ai:review`. Het script gebruikt een
  OpenAI-compatible `/v1/chat/completions` endpoint via `AI_CHAT_BASE_URL`,
  `AI_CHAT_API_KEY` en `AI_CHAT_MODEL`, vat recente `prediction_snapshots` samen en
  schrijft alleen naar `ai_observations` en `ai_questions`. Zonder configuratie slaat
  het veilig over; het zit niet in de live sync-loop en neemt nooit alarmbeslissingen.
- **Meal-onset detector (Laag 8, `hypo.md`)** — vroege heads-up al in de stijgende
  fase i.p.v. pas bij de daling (~10-15 min extra voorlooptijd). Nieuw in
  `scripts/lib/hypo-features.mjs`: `mealOnset` (sterke stijging vanaf een bodem ≥ 15 min
  geleden), `riseFromTroughMmol`, `minutesSinceTrough`. In
  `scripts/lib/reactive-hypo-detector.mjs` zet component 8 een lage `watch` als
  **risk-floor** (geen score-bijdrage, dus nooit zelf een `likely`/`urgent`-alarm —
  `watch` zit niet in de V2-alarmset). Regressie:
  `scripts/fixtures/meal-onset-rising.json`. Loopt automatisch mee in live-sync én
  backtest omdat beide dezelfde featurebuilder gebruiken.

- **Slimmere detector-features (verbeterd voorspellingsplan, `hypo.md`)** — in
  `scripts/lib/hypo-features.mjs`:
  - `acceleration` (mmol/min²): meet of de daling versnelt of afvlakt.
  - `isDecelerating` / `isBottoming` / `recoverySignal`: herstelsignalen waarmee de
    detector vals alarm dempt wanneer een daling al voorbij/aan het omkeren is (de
    grootste bron van vals alarm). De veiligheidsklep blijft: bij `< 4.5` of snelle
    daling wordt nooit gedempt.
  - **Variabele CGM-lag** (`effectiveLagMinutes`): 7/5/3/0 min afhankelijk van de
    dalingssnelheid i.p.v. een vaste 5 min — snelle daling = meer sensorlag.
  - `hypo.md` bevat het volledige plan met 8 voorgestelde lagen (nadir-schatting,
    curvevorm-match, dagdeel-context, weekdag-patroon, meal-onset detector).
- **V1- én V2-regel in de hypo-kaart** — de overlay toont V1 en V2 naast elkaar op één
  regel (V1 links, V2 rechts): per model `niveau · score`. Bij V2 staat ook de
  `confidence` (`%`) en een `✓` als getunede params actief zijn (`shadowTuned`); V1 toont
  géén `%` omdat het regelmodel geen confidence berekent — die dimensie is juist V2's
  meerwaarde. De redenen van elk model staan in de **hover-tooltip** op de betreffende
  regel (geen tekstblok op de kaart). De rate (`/min`) staat nu naast de glucosewaarde
  zodat dit geen extra kaarthoogte kost; de losse `V1`/`V2`-badge naast de titel is
  vervallen (V1 staat al als regel). De sync-risk mag het kaart-alarm bovendien
  **escaleren** (nooit verlagen), zodat een geactiveerde V2 ook het zichtbare alarm
  strenger kan maken terwijl de huidige-waarde-veiligheid blijft staan.
- **V2 krijgt dezelfde persoonlijke episode-vergelijking als V1** — de live-sync gaf het
  `pattern`-object (similarEpisodeCount/HypoCount/HypoRatio) wel aan V1 door maar niet aan
  V2, terwijl V2's component 6 (`patternScore` + confidence/uncertainty) er al op wachtte.
  Nu krijgt `evaluateReactiveHypoRiskV2` het pattern mee, zodat V2's shadow-oordeel jouw
  eerdere vergelijkbare episodes meeweegt. *Bekende beperking:* de auto-tuner
  (`tune-reactive-hypo-v2.mjs`) en de backtest (`evaluate-hypo-detector.mjs`) geven dit
  pattern nog niet mee; zolang V2 in shadow draait is dat onschadelijk, maar vóór activatie
  moeten beide paden gelijk worden getrokken (train/serve-pariteit).
- **Automatisch leren van je eigen patroon (dagelijks)** — `scripts/daily-hypo-tune.sh`
  draait via launchd (`deploy/com.glucosecgm.hypotune.plist`, dagelijks 04:30 op de iMac):
  episodes verversen → auto-tunen → rapporten. De sync laadt de geleerde params
  (`scripts/reactive-hypo-v2-state.json`, gitignored) en past ze toe op de V2 shadow
  (`shadowTuned`-vlag).
- **Auto-activatie met kwaliteitsgate (M6)** — de tuner zet `active: true` alleen als er
  genoeg events zijn én V2 op out-of-sample data niet slechter is dan V1 (recall en
  precision niet lager). De sync laat dan `risk` uit V2 komen (`likely`→`high` voor het
  alarm-vocab) en bewaart V1 als `legacyRisk`/`legacyScore`. Tot de gate slaagt blijft V1.
- **Rapporten (per dag / week / weekdag / patroon)** — `scripts/hypo-report.mjs`
  (`--days N`, `--by-weekday`) en `scripts/hypo-patterns.mjs` (uur-van-de-dag + weekdag +
  episode-statistiek + highlights van de riskantste uren/dagen, tijdzone-bewust).
  npm: `hypo:report`, `hypo:patterns`. Gedateerde output in `hypo-tune-reports/`.
- **Reactieve-hypo detector V2** (`hypo.md`, M1–M5) — een uitlegbare laag bovenop de
  V1-regel, gedeeld tussen live en backtest:
  - `scripts/lib/hypo-features.mjs` (`buildHypoFeatures`): pure featureset uit een
    timeline (rates, piek/drop, `lagAdjustedMmol`, forecast-velden).
  - `scripts/lib/reactive-hypo-detector.mjs` (`evaluateReactiveHypoRiskV2`):
    component-scores, scenario's (momentum/decay/worst-case), harde +
    onzekerheids-overrides, confidence/uncertainty, tunebaar via `context.params`.
  - `scripts/lib/episode-builder.mjs` + `scripts/build-reactive-hypo-episodes.mjs`:
    bouwt de collectie `reactive_hypo_episodes` (piek→nadir descents met outcome).
  - `scripts/evaluate-hypo-detector.mjs`: backtest die V1 vs V2 op de historie
    afspeelt (precision/recall/lead-time, early-warning-only, dichtheidsfilter,
    sustained-hypo definitie); `scripts/lib/legacy-risk-v1.mjs` is de getrouwe V1-port.
  - `scripts/tune-reactive-hypo-v2.mjs`: auto-tuner met temporele train/test-split en
    recall-gebonden grid search → `scripts/reactive-hypo-v2-state.json` (schrijft niets
    bij te weinig events). Methodiek volgt CGM-literatuur (±30 min event-window).
  - npm: `episodes:build`, `hypo:backtest`, `hypo:tune`, `detector:fixtures`,
    `episodes:check`. Fixtures in `scripts/fixtures/`.
- **M5 shadow-mode**: V2 draait stil mee in de sync en wordt per snapshot opgeslagen als
  `shadowRisk`/`shadowScore`/`shadowConfidence`/`shadowReasons`/`shadowModelVersion`.
  V1 (`rules-v1.1`) blijft de enige alarmbron; shadow stuurt niets aan en `/prediction/latest`
  geeft de shadow-velden terug. Doel: V1/V2-paren verzamelen voor latere tuning (M6).
- **M1 rijkere snapshots**: `prediction_snapshots` bevat nu `features`, `predicted`,
  `pattern` en `lagAdjustedMmol`; `modelVersion` → `rules-v1.1`.
- **Influx glucose-write vanuit de sync** (`writeInfluxGlucoseEntries`): elke sync-cyclus
  schrijft glucose/rate naar InfluxDB (`INFLUX_URL`, `INFLUXDB_DB`/`USER`/`PASSWORD`),
  zodat Grafana de time-series toont zonder een aparte xDrip-upload. De compose-file
  geeft de sync nu `.env.influxdb` + `INFLUX_URL=http://influxdb:8086` mee.
- **Optionele xDrip InfluxDB-laag**: `influxdb:1.8` Docker service achter profile
  `influxdb`, `.env.influxdb.example`, persistente `influxdb-data/`, en npm-scripts
  `influxdb:up`, `influxdb:logs`, `influxdb:down`.
- **Optionele Grafana-laag**: `grafana/grafana:11.5.2` Docker service achter profile
  `grafana`, InfluxDB datasource provisioning (`InfluxQL`, database `xdrip`,
  user/password `root`/`root`) en basisdashboard `xDrip Glucose`.
- **Nightscout env-template**: `.env.nightscout.example`, zodat de README quickstart
  niet naar een ontbrekend bestand verwijst.
- **Forecast-horizons 60/120/180 min** naast 10/15/20/30 in `buildForecast`. Vanaf
  >30 min satureert de bijdrage van de rate (`RATE_DECAY_TAU`), zodat lange horizons
  niet altijd in de clamp lopen.
- **`episode_vectors`**: `scripts/build-episode-vectors.mjs` bouwt per episode een
  genormaliseerde curve-vector, een uitlegbare featureVector en de gemeten outcome.
- **Live episode-similarity** (`findSimilarEpisodes`) verrijkt de patrooncorrectie en
  voegt een risicoreden toe ("Lijkt op N eerdere episodes; M gingen onder 4.5"), met
  fallback op de simpele peak-correctie. Alleen actief bij een echte post-piek daling
  (`dropFromPeakMmol >= 2` en `minutesSincePeak <= 60`).
- **`user_feedback`**: `POST /feedback` endpoint + nginx-proxy `/_feedback` + vijf
  feedbackknoppen (`Klopt`, `Vals alarm`, `Ik voel hypo`, `Ik heb gegeten`,
  `Vingerprik ok`) in de hypo-kaart van de overlay.
- **Snapshot-evaluatie** meet nu ook `actualMinMmol_120m/180m` en (near-)hypo-vlaggen
  op 60/180 min.
- **npm-scripts** voor de analyse-pipeline: `patterns:analyze`, `features:build`,
  `vectors:build`, `snapshots:backfill`, `snapshots:evaluate`.
- Documentatie: README-secties voor de nieuwe scripts en endpoints; CHANGELOG;
  implementatiestatus in `predict.md`.

### Gewijzigd

- **Overlay**: de 5 feedbackknoppen (Klopt / Vals alarm / Ik voel hypo / Ik heb gegeten /
  Vingerprik ok) zijn uit de hypo-kaart verwijderd (`/_feedback` blijft bestaan, ongebruikt).
- **Snapshot-features** worden nu via de gedeelde `buildHypoFeatures` opgebouwd i.p.v. een
  losse hand-gemaakte map, zodat `prediction_snapshots.features` exact dezelfde velden
  bevat als de V2-detector (incl. `acceleration`, `effectiveLagMinutes`, herstelsignalen).
- `.gitignore` uitgebreid (`dist/`, `.env*`, `nightscout-mongo-data/`, `.npm-cache/`,
  `influxdb-data/`, `grafana-data/`) en `.env.*.example` expliciet
  trackbaar gemaakt.
- Pattern-correctiegewicht schaalt nu tot ~30 min (`w = min(1, h/30)`), samengevoegd
  met de horizon-saturatie.

### Gefixt

- **Overlay calc-mode**: een tik op de calc-knop zet de weergave nu terug naar live en
  wist een geselecteerd grafiekpunt — eerder leken de rate-kaarten bevroren op een oud
  punt terwijl het hypo-blok wél live bleef updaten.
- **`riskDetails` werd niet opgeslagen**: stond wel in het snapshotobject maar ontbrak
  in de MongoDB `$set`, waardoor `blendedRate`/`minutesTo40/45` per snapshot verloren
  gingen. Nu hersteld en meegenomen in `/prediction/latest`.
- **Auto-tuner overfit-guard**: bij een degenererende train/test-split (te weinig
  hypo-events) schrijft `tune-reactive-hypo-v2.mjs` geen state, i.p.v. een misleidend
  "getuned" bestand dat in feite de defaults zijn.
- **TDZ-crash**: de sync-module heeft een top-level `await runForever()` die nooit
  terugkeert; module-scope `const` (`FEEDBACK_TYPES`, `SIM_*`) die daarna stond bleef
  in de temporal dead zone. Verplaatst naar het constantenblok bovenaan, waardoor
  `/feedback` en de similarity-correctie runtime werken.
- Episode-similarity: `maxFallRate` uit de afstandsmaat gehaald (offline 1-min diffs
  vs. live gladde 5/10/15-min rates — niet vergelijkbaar).

### Samengevoegd

- `feat/predict-pipeline-finish` en `codex/overlay-light-refresh` (mobiele rendering,
  polling, hypo-alert zichtbaarheid, 2-decimalen BG + precieze 5-min delta,
  `/overlay/entries` endpoint) tot één live versie.
