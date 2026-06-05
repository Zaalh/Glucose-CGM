# Changelog

Alle noemenswaardige wijzigingen aan Glucose CGM. Formaat losjes gebaseerd op
[Keep a Changelog](https://keepachangelog.com/). Datums in YYYY-MM-DD.

## [Unreleased]

> **Live gedeployed (2026-06-04)** op de Nightscout-stack (iMac). `libreview-sync`
> herstart op commit `f280478`; verse `prediction_snapshots` bevatten de nieuwe
> `mealOnset`/`minutesSinceTrough`/`riseFromTroughMmol`-features. Meal-onset draait in
> V2 (shadow); de actieve V1-alarmen blijven ongemoeid tot de M6-gate slaagt.

### Gewijzigd

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
  `.claude/`, `influxdb-data/`, `grafana-data/`) en `.env.*.example` expliciet
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
