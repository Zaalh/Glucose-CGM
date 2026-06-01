# Changelog

Alle noemenswaardige wijzigingen aan Glucose CGM. Formaat losjes gebaseerd op
[Keep a Changelog](https://keepachangelog.com/). Datums in YYYY-MM-DD.

## [Unreleased]

### Toegevoegd

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
  zodat Grafana de time-series toont zonder een aparte xDrip-upload.
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

- `.gitignore` uitgebreid (`dist/`, `.env*`, `nightscout-mongo-data/`, `.npm-cache/`,
  `.claude/`, `influxdb-data/`, `grafana-data/`) en `.env.*.example` expliciet
  trackbaar gemaakt.
- Pattern-correctiegewicht schaalt nu tot ~30 min (`w = min(1, h/30)`), samengevoegd
  met de horizon-saturatie.

### Gefixt

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
