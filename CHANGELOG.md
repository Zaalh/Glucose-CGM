# Changelog

Alle noemenswaardige wijzigingen aan Glucose CGM. Formaat losjes gebaseerd op
[Keep a Changelog](https://keepachangelog.com/). Datums in YYYY-MM-DD.

## [Unreleased]

### Toegevoegd

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
  `.claude/`).
- Pattern-correctiegewicht schaalt nu tot ~30 min (`w = min(1, h/30)`), samengevoegd
  met de horizon-saturatie.

### Gefixt

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
