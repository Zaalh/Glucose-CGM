# Predictieplan voor reactieve hypoglykemie

Doel: een persoonlijk vroegwaarschuwingssysteem maken voor reactieve hypoglykemie op basis van CGM-data. Dit project gaat uit van: geen diabetes, geen insulinegebruik, wel hypo's na eten of na een snelle glucosepiek.

Dit is geen diagnose- of behandeladvies. De app moet patronen signaleren en risico's inschatten, zodat je eerder ziet: "dit lijkt op mijn bekende patroon richting hypo".

## Medische context

Reactieve of postprandiale hypoglykemie wordt in medische context vaak beschreven als een lage glucose na een maaltijd, regelmatig in een venster van enkele uren. Jouw CGM-data laat echter zien dat jouw reactie vaak veel sneller is. Daarom moet dit systeem persoonlijk worden afgesteld op jouw curve, niet op een standaardtekstboekvenster. In bronnen over niet-diabetische hypoglykemie wordt benadrukt dat symptomen, lage glucose en herstel na koolhydraten samen belangrijk zijn. CGM is nuttig om patronen zichtbaar te maken, maar individuele lage sensorwaarden kunnen afwijken en moeten bij twijfel met vingerprik of medische beoordeling worden bevestigd.

Belangrijk voor onze voorspelling:

- We voorspellen geen insuline-effect, want er is geen insulinegebruik.
- We zoeken vooral naar maaltijdachtige glucosepieken gevolgd door een te sterke daling.
- De relevante horizon is vooral 10, 15, 20, 30 en 60 minuten, met 120 en 180 minuten als secundaire vensters.
- Een "bijna hypo" is ook belangrijk, bijvoorbeeld onder 4.5 mmol/L, omdat jouw data al laat zien dat dit vaak voorafgaat aan echte hypo's.

## Implementatiestatus (bijgewerkt 2026-05-30)

Dit plan is deels gebouwd. Onderstaand overzicht houdt bij wat af is en wat nog open staat. De rest van dit document blijft de volledige specificatie/roadmap.

### Gebouwd

- **Live dataflow**: LibreView -> `scripts/libreview-nightscout-sync.mjs` (server + loop) -> Nightscout -> MongoDB. Server-endpoints: `/health`, `/sync`, `/prediction/latest`.
- **`prediction_snapshots`**: per nieuwe entry een snapshot (upsert op `entryIdentifier`). Bevat `risk`, `riskScore`, `reasons`, `predictedMmol`, `probabilities` (`lt45`/`lt40`), `modelVersion: 'rules-v1'`. Backfill via `scripts/backfill-prediction-snapshots.mjs`, evaluatie via `scripts/evaluate-predictions.mjs`.
- **`pattern_events`**: episodedetectie via `scripts/analyze-patterns.mjs`; door de sync gebruikt voor patrooncorrectie.
- **`entry_features`**: backfill via `scripts/build-entry-features.mjs`.
- **`model_state`**: training via `scripts/train-risk-model.mjs` (policies: recall-first/balanced/precision-first), export naar `scripts/risk-model-state.json` via `scripts/retrain-and-export-model.mjs`.
- **`daily_summaries`**: aggregatie via `scripts/summarize-days.mjs`.
- **Regelgebaseerde risicoscore (uitlegbaar)**: `evaluateRiskRuleV1` in de sync (`scripts/libreview-nightscout-sync.mjs`). Niveaus low/watch/high/urgent, met drempels uit `model_state` / `scripts/risk-model-state.json`.
- **Live UI**: nginx-overlay `nightscout-overlay/rate-overlay.js` toont rates, forecast-lijn, hypo-risico (peak-drop watch/high/urgent) en forecast-calibratie op poort 1337.

### Recent afgemaakt (2026-05-30)

1. **Snapshot-horizons uitgebreid** naar 60/120/180 min in `buildForecast` (rate satureert vanaf >30 min via `RATE_DECAY_TAU`); `evaluate-predictions.mjs` meet nu ook `actualMinMmol_120m/180m` en (near-)hypo-vlaggen op 60/180 min.
2. **`user_feedback`**: collection + feedbackknoppen (`Klopt`, `Vals alarm`, `Ik voel hypo`, `Ik heb gegeten`, `Vingerprik bevestigd`) in de overlay-hypokaart -> sync-endpoint `POST /feedback` -> MongoDB, gekoppeld aan dichtstbijzijnde entry + actieve snapshot.
3. **`episode_vectors`**: `scripts/build-episode-vectors.mjs` (genormaliseerde curve-vector + uitlegbare featureVector + outcome). Live similarity (`findSimilarEpisodes`) verrijkt de patrooncorrectie en voegt een risicoreden toe ("Lijkt op N eerdere episodes; M gingen onder 4.5"), met fallback op de simpele peak-correctie.
4. **npm-scripts** toegevoegd voor de hele analyse-pipeline: `patterns:analyze`, `features:build`, `vectors:build`, `snapshots:backfill`, `snapshots:evaluate`.

> Status: **live gedeployed** (2026-05-30) op de Nightscout-stack. `episode_vectors` is gevuld (34 episodes uit 520 events), `/feedback` en `/prediction/latest` met alle 7 horizons zijn live geverifieerd. De wijzigingen zijn samengevoegd met `codex/overlay-light-refresh` (de live overlay) en draaien op `main` / `codex/overlay-light-refresh`.

### Open

- **AI-laag activeren** (`ai_observations` + `ai_questions`): voorbereiding is gebouwd
  via `scripts/ai-review.mjs` / `npm run ai:review` met een OpenAI-compatible
  `/v1/chat/completions` endpoint. Staat standaard uit tot `AI_CHAT_BASE_URL`,
  `AI_CHAT_API_KEY` en `AI_CHAT_MODEL` zijn gezet. Mag NOOIT de live alarmbeslissing
  nemen; alleen uitleg, context en vragen.

### Bewust nog niet

- Wearable/activiteit/slaap-databronnen (prioriteit 4-6 hieronder).
- Maaltijdfoto/tekst-AI.
- Vector-index in Atlas; lokale numerieke search volstaat zolang de dataset klein is.

## Eerste observatie uit jouw data

Op de live Nightscout/MongoDB-data, niet de afgeronde PDF:

- 1.823 LibreView-meetpunten.
- Periode: 2026-05-27 22:44 t/m 2026-05-29 16:13 lokale tijd.
- Hyper-episodes boven 10.0 mmol/L: 5.
- Hypo onder 4.0 mmol/L binnen 6 uur na zo'n episode: 3 van 5.
- Hypo onder 4.0 mmol/L binnen 12 uur: 4 van 5.
- Onder 4.5 mmol/L binnen 12 uur: 5 van 5.

Extra timinganalyse vanaf de piek:

- Bij pieken boven 8.5 mmol/L: onder 5.0 binnen mediaan 40 minuten, snelste 16 minuten.
- Bij pieken boven 9.0 mmol/L: onder 5.0 binnen mediaan 32.5 minuten, snelste 16 minuten.
- Bij pieken boven 10.0 mmol/L: onder 5.0 binnen mediaan 25 minuten, snelste 16 minuten.
- Bij recente pieken boven 10.0 mmol/L met echte hypo: onder 4.0 na ongeveer 22 minuten.
- Voorbeelden:
  - 2026-05-29 07:37 piek 11.65 -> onder 5.0 na 17 min, onder 4.5 na 19 min, onder 4.0 na 22 min.
  - 2026-05-29 15:09 piek 10.71 -> onder 5.0 na 16 min, onder 4.5 na 19 min, onder 4.0 na 22 min.

Conclusie: jouw gevoel klopt in deze korte dataset, en de timing is sneller dan het klassieke postprandiale venster. Na een piek boven 10 is het kritieke venster bij jou soms al de eerste 15-30 minuten na de piek.

## Wat we moeten herkennen

### 1. Maaltijdachtige spike

Een episode die waarschijnlijk met eten samenhangt:

- Start bij duidelijke stijging vanaf een relatief normale waarde.
- Stijgsnelheid bijvoorbeeld groter dan 0.04-0.06 mmol/L/min over 15-30 minuten.
- Piek boven 8.5, 9.0 of 10.0 mmol/L.
- Daarna omslag van stijgend naar vlak of dalend.

Deze detectie hoeft niet perfect te weten dat je at. Het is genoeg als de curve lijkt op een postprandiale piek.

### 1b. Dynamische sprongen

De app moet niet alleen kijken naar vaste grenzen zoals 10.0 of 4.0. Grote sprongen zeggen bij jou veel, zowel omhoog als omlaag. Een piek hoeft dus niet boven 10.0 te zijn om gevaarlijk te worden. Een piek rond 8.8 die snel naar 6.0 of lager zakt kan ook een belangrijk signaal zijn.

Belangrijke signalen:

- Snelle stijging: bijvoorbeeld +2.0 mmol/L binnen 15-30 minuten.
- Zeer snelle stijging: bijvoorbeeld +3.0 mmol/L binnen 20-30 minuten.
- Snelle daling: bijvoorbeeld -2.0 mmol/L binnen 15-30 minuten.
- Zeer snelle daling: bijvoorbeeld -3.0 mmol/L binnen 20-30 minuten.
- Val vanaf piek: bijvoorbeeld van 10.0 naar 6.0 in korte tijd.
- Val vanaf lagere piek: bijvoorbeeld van 8.8 naar 6.0 of 5.5 in korte tijd.
- Grote relatieve daling: bijvoorbeeld 25-35% daling vanaf recente piek.
- Richtingsomslag: snel stijgen -> afvlakken -> snel dalen.

Voorbeeldsignaal:

```text
piek rond 10.0
nu al rond 6.0
en dit gebeurde binnen 20-40 minuten
= sterk waarschuwingssignaal, ook als je nog niet hypo bent
```

Dit moet dus opgepikt worden als `fast_drop_risk`, niet pas als `near_hypo`.

Nog een voorbeeld:

```text
piek rond 8.8
nu rond 6.0
drop van 2.8 mmol/L
en de daling loopt nog door
= ook een waarschuwingssignaal, ondanks geen hyper boven 10
```

Daarom werken we met dynamische piekdetectie:

- vaste drempels: 8.5, 9.0, 10.0;
- relatieve drempels: piek ligt duidelijk boven jouw recente baseline;
- drop-drempels: hoeveel je vanaf die piek bent gezakt;
- rate-drempels: hoe snel die daling gaat;
- patroonmatch: lijkt dit op eerdere episodes die bij jou eindigden in near-hypo of hypo?

### 2. Rebound-drop

Na een spike letten we op:

- Daling vanaf de piek.
- Daaltempo over 3, 5, 10, 15, 20, 30 en 60 minuten.
- Absolute delta over 5, 10, 15, 20, 30 en 60 minuten.
- Hoeveel mmol/L er al verloren is sinds de piek.
- Hoe snel de waarde van boven 10 naar 7, 6 of 5.5 gaat.
- Hoe lang de daling aanhoudt.
- Of de waarde onder 7.0, 6.0, 5.0 en 4.5 komt.
- Of de daling versnelt of juist afvlakt.
- Of de daling binnen 10-20 minuten na de piek al richting 5.0 gaat.

### 3. Hypo-na-hyper patroon

Een episode krijgt het label `hypo_after_hyper` als:

- Er een piek boven 10.0 mmol/L was.
- Daarna binnen 10-60 minuten een waarde onder 4.0 komt.

Een mildere variant krijgt `near_hypo_after_hyper` als:

- Er binnen 10-60 minuten een waarde onder 4.5 komt.

Een langzamere variant blijft bestaan voor oudere/langere episodes:

- `delayed_hypo_after_hyper`: onder 4.0 binnen 1-6 uur.
- `delayed_near_hypo_after_hyper`: onder 4.5 binnen 1-6 uur.

## Features voor het voorspelmodel

Per actuele meting berekenen we:

- Huidige glucosewaarde.
- Snelheid over 5, 10, 15, 30, 45 en 60 minuten.
- Snelheid over 3 en 20 minuten voor zeer snelle reacties.
- Delta over 5, 10, 15, 20, 30, 45 en 60 minuten.
- Versnelling: wordt de daling sterker of zwakker?
- Tijd sinds laatste piek boven 8.5, 9.0 en 10.0.
- Hoogte van de laatste piek.
- Daling vanaf de piek in mmol/L.
- Percentage/relatieve daling vanaf de piek.
- Tijd van piek naar onder 8.0, 7.0, 6.0, 5.5, 5.0 en 4.5.
- Gemiddelde daling per minuut sinds de piek.
- Laagste waarde in vergelijkbare eerdere episodes.
- Tijdstip van de dag.
- Eventueel: handmatige maaltijdmarkering, als we die later toevoegen.

Extra dynamische features:

- `delta_10m`, `delta_20m`, `delta_30m`.
- `rate_10m`, `rate_20m`, `rate_30m`.
- `dropFromPeak`: actuele waarde minus laatste piek.
- `minutesSincePeak`.
- `peakToCurrentRate`.
- `crossedDownFrom10To6`: boolean.
- `crossedDownFrom9To6`: boolean.
- `crossedDownFromPeakTo6`: boolean.
- `crossedDownFromPeakTo55`: boolean.
- `adaptivePeakMmol`: hoogste relevante piek, ook als die onder 10 ligt.
- `baselineBeforeRise`: gemiddelde waarde voor de stijging.
- `riseAboveBaseline`: piek minus baseline.
- `dropPercentFromPeak`.
- `largeRiseBeforeDrop`: boolean.
- `turnaroundSpeed`: hoe snel stijging omslaat naar daling.

## Risicoscore versie 1

Begin met een uitlegbare score in plaats van direct machine learning.

Voorbeeld:

- `+3` als er in de afgelopen 6 uur een piek boven 10.0 was.
- `+4` als er in de afgelopen 30 minuten een piek boven 10.0 was en de waarde nu snel daalt.
- `+4` als de waarde van boven 10.0 naar rond 6.0 is gegaan binnen 20-45 minuten.
- `+3` als een piek tussen 8.5 en 10.0 snel naar rond 6.0 of lager zakt.
- `+3` als de daling vanaf een adaptieve piek groter is dan 25-35%.
- `+3` als de waarde meer dan 3.0 mmol/L onder de recente piek zit.
- `+2` als de waarde meer dan 2.0 mmol/L is gedaald binnen 20 minuten.
- `+2` als er eerst een grote stijgsprong was en daarna een grote dalingssprong.
- `+2` als de glucose nu onder 6.0 is en daalt.
- `+3` als de 5- of 10-minuten rate lager is dan -0.08 mmol/L/min.
- `+2` als de 15-minuten rate lager is dan -0.04 mmol/L/min.
- `+2` als de waarde binnen 20 minuten na de piek al onder 5.5 komt.
- `+1` als de 30- of 60-minuten rate ook negatief is.
- `+2` als eerdere vergelijkbare episodes binnen 30 minuten onder 4.5 kwamen.
- `-2` als de daling duidelijk afvlakt.
- `-2` als de waarde stabiel boven 6.5 blijft.

Risiconiveaus:

- `laag`: score 0-2.
- `let op`: score 3-4.
- `hoog`: score 5-6.
- `urgent`: score 7+ of voorspelde waarde onder 4.0.

De app moet altijd tonen waarom de score hoog is, bijvoorbeeld:

> Hoog hypo-risico: piek 10.7 mmol/L 22 min geleden, daling -0.09 mmol/L/min, vergelijkbare eerdere episodes gingen onder 4.5.

Of:

> Hoog hypo-risico: daling van 10.2 naar 6.1 in 28 min. Dit is bij jou vaak een vroeg signaal voor snelle hypo.

## Predictie versie 1

Combineer twee modellen:

### A. Zeer korte termijn trend

De huidige lineaire voorspelling blijft nuttig, maar moet voor jou scherper worden op 10-30 minuten vooruit.

Gebruik:

- weighted linear regression op de laatste 10-20 minuten.
- extra check op 3-, 5- en 10-minuten rate voor snelle dalingen.
- aparte voorspellingen voor 10, 15, 20 en 30 minuten.
- alarm eerder laten afgaan bij een combinatie van piek boven 10 en snelle negatieve rate.

### B. Patrooncorrectie

Als de actuele situatie lijkt op eerdere post-hyper drops:

- Vergelijk huidige episode met historische episodes.
- Zoek episodes met vergelijkbare piekhoogte, daling vanaf piek en tijd sinds piek.
- Neem de mediane latere daling van die episodes als correctie.

Resultaat:

```text
voorspelling = trendvoorspelling + patrooncorrectie
```

Bij weinig data gebruiken we alleen de risicoscore. Pas na genoeg episodes gebruiken we patrooncorrectie.

Voor jouw huidige data moet de eerste versie al werken op het snelle patroon:

```text
piek > 10.0
+ binnen 5-15 min duidelijke daling
+ actuele waarde richting 5.5 of lager
= hoog risico op hypo binnen 10-30 min
```

Tweede snelle patroon:

```text
piek >= 9.5-10.0
+ actuele waarde rond 6.0
+ drop vanaf piek >= 3.0 mmol/L
+ drop gebeurde snel
= alarm/hoog risico, ook als actuele waarde nog niet laag is
```

Derde snelle patroon, zonder harde hyper:

```text
piek 8.5-9.5
+ actuele waarde rond 6.0 of lager
+ drop vanaf piek >= 2.0-3.0 mmol/L
+ daling loopt nog door
= verhoogd risico, ook zonder piek boven 10
```

Vierde patroon, volledig adaptief:

```text
recente baseline 5.5-6.5
+ piek minimaal 2.0 mmol/L boven baseline
+ daarna snelle daling van minstens 25-35%
+ rate blijft negatief
= risico op reactieve crash
```

## Predictie versie 2

Als er meer data is, kunnen we een klein persoonlijk model trainen:

- Logistic regression of gradient boosting.
- Doel: kans op glucose onder 4.0 binnen 10, 15, 20, 30, 60, 120 of 180 minuten.
- Apart doel voor onder 4.5, omdat dat bij jou een vroeg waarschuwingsniveau lijkt.

Labels:

- `hypo_10m`
- `hypo_15m`
- `hypo_20m`
- `hypo_30m`
- `hypo_60m`
- `hypo_120m`
- `hypo_180m`
- `near_hypo_20m`
- `near_hypo_180m`

Belangrijk: dit model moet alleen lokaal op jouw data draaien. Geen cloud nodig.

## Lerende database

De app moet niet alleen actuele waarden lezen, maar ook eigen analyses terugschrijven. Daarmee ontstaat een persoonlijke leerlaag bovenop Nightscout.

Gebruik MongoDB als primaire bron, omdat Nightscout daar nu al op draait. Maak aparte collections naast `entries`, zodat ruwe CGM-data schoon blijft.

De bestaande `entries` bevatten nu al veel bruikbare informatie:

- `_id`.
- `identifier`.
- `sysTime`, `date`, `dateString`.
- `device`.
- `direction`.
- `sgv`.
- `utcOffset`.
- `glucoseRate` en `glucoseRateMmolPerMin`.

Vooral `glucoseRateMmolPerMin` is belangrijk: daar zitten al vensters in zoals 1, 2, 3, 4, 5, 10, 15, 20, 30, 45, 60, 90 en 120 minuten, met `rate`, `delta`, `actualMinutes` en `baselineDate`. Deze velden moeten de basis zijn voor dynamische sprongdetectie.

Regel: gebruik alles wat al in `entries` staat voordat we iets opnieuw berekenen. Alleen ontbrekende of hogere-orde features schrijven we naar nieuwe collections.

### Collection: `pattern_events`

Slaat herkende episodes op.

Velden:

- `type`: `spike`, `fast_drop`, `hypo`, `near_hypo`, `hypo_after_hyper`, `meal_marker`, `symptom_marker`.
- `startDate`, `endDate`, `peakDate`.
- `startMmol`, `endMmol`, `peakMmol`, `minMmol`.
- `durationMinutes`.
- `sourceEntryIds`: Nightscout ids of identifiers die bij de episode horen.
- `rates`: 3, 5, 10, 15, 20, 30, 60 minuten.
- `features`: snapshot van model-features.
- `labels`: bijvoorbeeld `fast_reactive`, `delayed_reactive`, `false_alarm_context`.
- `createdAt`, `updatedAt`.

Voorbeeld:

```json
{
  "type": "hypo_after_hyper",
  "peakMmol": 10.7,
  "peakDate": "2026-05-29T13:09:00.000Z",
  "minMmol": 3.0,
  "minutesPeakToUnder45": 19,
  "minutesPeakToUnder40": 22,
  "labels": ["fast_reactive"]
}
```

### Collection: `prediction_snapshots`

Elke keer dat de app voorspelt, bewaren we wat hij dacht op dat moment. Dit is essentieel om te leren van fouten.

Velden:

- `createdAt`.
- `entryId` of `entryIdentifier`.
- `currentMmol`.
- `predictedMmol`: per horizon: 10, 15, 20, 30, 60, 120, 180 minuten.
- `risk`: `low`, `watch`, `high`, `urgent`.
- `riskScore`.
- `probabilities`: kans op `<4.5` en `<4.0` per horizon.
- `reasons`: korte lijst met redenen.
- `modelVersion`.
- `featureVector`.
- `matchedPatternIds`.
- `alarmTriggered`: boolean.
- `outcomeEvaluated`: boolean.

Na afloop wordt dezelfde snapshot verrijkt met:

- `actualMinMmol_30m`, `actualMinMmol_60m`, `actualMinMmol_180m`.
- `actualHypoWithin_10m`, `actualHypoWithin_20m`, `actualHypoWithin_30m`, etc.
- `actualNearHypoWithin_10m`, `actualNearHypoWithin_20m`, etc.
- `result`: `true_positive`, `false_positive`, `false_negative`, `true_negative`.
- `leadTimeMinutes`: hoeveel minuten waarschuwing voor de echte hypo.

### Collection: `entry_features`

Per CGM-entry bewaren we afgeleide features die duurder of complexer zijn dan simpele rates.

Velden:

- `entryId`, `entryIdentifier`, `date`.
- `mmol`.
- `rawRates`: kopie of selectie uit `glucoseRateMmolPerMin`.
- `baseline_30m`, `baseline_60m`, `baseline_120m`.
- `localPeakMmol`, `localPeakDate`, `minutesSinceLocalPeak`.
- `localTroughMmol`, `localTroughDate`.
- `dropFromPeakMmol`.
- `dropFromPeakPercent`.
- `riseFromBaselineMmol`.
- `turnaroundDetected`.
- `turnaroundMinutes`.
- `mealState`.
- `curveType`.
- `dataQualityScore`.
- `featureVector`.
- `featureVersion`.

Deze collection maakt live voorspelling sneller: de app hoeft niet bij elke render opnieuw de hele historie te scannen.

### Collection: `episode_vectors`

Voor similarity search tussen episodes.

Velden:

- `eventId`.
- `eventType`.
- `startDate`, `peakDate`, `endDate`.
- `curveType`.
- `vectorVersion`.
- `vector`: numerieke embedding van de curve.
- `featureVector`: uitlegbare features naast de vector.
- `outcome`: hypo, near-hypo, stable, unknown.

Vectorinhoud eerste versie zonder LLM:

- genormaliseerde glucosewaarden rond de episode, bijvoorbeeld 60-120 punten.
- rates/deltas per venster.
- piekhoogte, baseline, drop, tijd tot piek, tijd tot drop.
- area boven/onder baseline.

Later kan daar een AI/embedding bij komen, maar de eerste vector moet volledig lokaal en numeriek zijn.

Gebruik:

- Zoek historische episodes die lijken op de huidige curve.
- Kijk wat daarna gebeurde.
- Gebruik dat als patrooncorrectie en risicoreden.

Voorbeeld:

```text
huidige curve lijkt op 5 eerdere episodes
4 daarvan gingen onder 4.5 binnen 30 min
2 daarvan gingen onder 4.0 binnen 30 min
= high risk
```

### Collection: `model_state`

Bewaar de persoonlijke instellingen van het model.

Velden:

- `modelVersion`.
- `active`: boolean.
- `trainedUntil`.
- `thresholds`: score-grenzen en rate-grenzen.
- `weights`: feature-gewichten voor de uitlegbare score.
- `calibration`: correcties op kansschattingen.
- `metrics`: precision, recall, false alarms per day, missed hypos.
- `notes`: korte changelog waarom model aangepast is.

### Collection: `user_feedback`

Alles wat jij terugmeldt moet bewaard worden.

Voorbeelden:

- `ate_now`.
- `symptoms`.
- `fingerstick_confirmed`.
- `false_alarm`.
- `helpful_alarm`.
- `missed_hypo`.
- `carbs_estimate`.
- `meal_type`: `fast_carbs`, `mixed`, `high_fat`, `unknown`.

Deze feedback wordt gekoppeld aan de dichtstbijzijnde CGM-entry en aan actieve prediction snapshots.

### Collection: `daily_summaries`

Dagelijkse aggregaties voor trends en AI-analyse.

Velden:

- `date`.
- `pointsCount`.
- `timeBelow40`, `timeBelow45`, `timeAbove85`, `timeAbove100`.
- `hypoCount`, `nearHypoCount`.
- `spikeCount`.
- `fastDropCount`.
- `suspectedMealCount`.
- `fastCrashCurveCount`.
- `falsePositiveCount`.
- `missedHypoCount`.
- `averageLeadTimeMinutes`.
- `modelVersion`.

Deze summaries zorgen dat de AI later niet steeds alle ruwe punten hoeft te lezen.

## Leerloop

De app krijgt een continue leerloop:

1. Nieuwe CGM-meting komt binnen.
2. Features berekenen.
3. Huidige risico en voorspelling opslaan in `prediction_snapshots`.
4. Als er een spike/drop/hypo ontstaat, episode opslaan of bijwerken in `pattern_events`.
5. Oudere voorspellingen evalueren zodra de horizon verstreken is.
6. Dagelijks of na genoeg nieuwe events modelstatistieken bijwerken.
7. Alleen als het nieuwe model beter is, `model_state.active` omzetten naar de nieuwe versie.

Belangrijk: voorspellingen worden dus niet vluchtig. Elke voorspelling wordt later vergeleken met wat echt gebeurde.

## Persoonlijk leren

Het model moet in drie fases leren.

### Fase 1: Regels plus geheugen

Direct bruikbaar met weinig data.

- Detecteer snelle post-hyper drops.
- Gebruik handmatige gewichten.
- Match actuele curve met eerdere episodes.
- Bewaar elke voorspelling en uitkomst.

### Fase 2: Persoonlijke calibratie

Na ongeveer 20-30 spikes of 10+ hypo/near-hypo events:

- Pas score-grenzen aan op jouw echte false positives en false negatives.
- Leer welke piekhoogtes bij jou gevaarlijk zijn: 8.5, 9.0, 10.0 of hoger.
- Leer welke dalingssnelheid gevaarlijk is.
- Leer of tijdstip van dag uitmaakt.

Voorbeeld:

```text
Als piek > 10.0 en 10-min rate < -0.08:
  historisch 4/5 keer onder 4.5 binnen 30 min
```

### Fase 3: Klein lokaal model

Pas als er genoeg data is:

- Train een kleine logistic-regression-achtige score of gradient boosting model.
- Input blijft uitlegbaar via feature importance.
- Output is kans op `<4.5` en `<4.0` binnen meerdere horizons.
- Model wordt lokaal opgeslagen in `model_state`.

Geen groot black-box model als eerste stap. Betrouwbaarheid en uitlegbaarheid zijn belangrijker.

## Model-evaluatie

Elke dag berekenen:

- Aantal hypo's onder 4.0.
- Aantal near-hypo's onder 4.5.
- Hoeveel hypo's waren vooraf voorspeld.
- Gemiddelde lead time.
- False positives per dag.
- Gemiste snelle hypo's binnen 30 minuten na piek.
- Beste drempels voor jouw data.

Belangrijkste metric:

```text
gemiste hypo's laag houden zonder dat je de hele dag alarmmoe wordt
```

Praktische doelen:

- Liever een paar extra `let op` meldingen dan een gemiste snelle hypo.
- `urgent` alleen als de kans hoog is of de trend al richting onder 4.0 wijst.
- `hoog` mag vroeg zijn, maar moet goede redenen tonen.

## Feedback in de app

Voeg bij elke risicomelding knoppen toe:

- `Klopt`
- `Vals alarm`
- `Ik voel hypo`
- `Ik heb gegeten`
- `Vingerprik bevestigd`

Deze knoppen schrijven naar `user_feedback`.

Na een gemiste hypo kan de app later vragen:

```text
Was dit een hypo die je voelde?
```

Of:

```text
Kwam dit na eten?
```

Zo leert het systeem niet alleen van glucosewaarden, maar ook van jouw ervaring.

## Database-taken

Maak scripts:

- `scripts/analyze-patterns.mjs`: scan alle entries en vul `pattern_events`.
- `scripts/build-entry-features.mjs`: bereken `entry_features` vanuit alle bestaande Nightscout entries.
- `scripts/build-episode-vectors.mjs`: maak vectors voor alle episodes.
- `scripts/evaluate-predictions.mjs`: vul uitkomsten van oude `prediction_snapshots`.
- `scripts/train-risk-model.mjs`: bereken nieuwe gewichten en schrijf `model_state`.
- `scripts/backfill-prediction-snapshots.mjs`: simuleer historische voorspellingen op oude data voor snellere training.
- `scripts/summarize-days.mjs`: vul `daily_summaries`.

De backfill is belangrijk: daarmee kunnen we doen alsof het model in het verleden live draaide en zien of het jouw snelle hypo's had voorspeld.

## Backtesting

Voor elke historische minuut:

1. Gebruik alleen data tot dat moment.
2. Maak een voorspelling.
3. Kijk daarna wat er echt gebeurde.
4. Sla de uitkomst op.

Zo voorkomen we dat het model stiekem de toekomst kent.

Backtest-uitvoer:

- Confusion matrix per horizon.
- Lijst gemiste hypo's.
- Lijst valse alarmen.
- Beste thresholds voor `watch`, `high`, `urgent`.
- Voorbeelden van vergelijkbare historische patronen.

## Vector search en episode similarity

Omdat jouw patroon dynamisch is, is alleen een paar drempels niet genoeg. Het systeem moet kunnen vragen:

```text
waar heb ik deze curve eerder gezien, en wat gebeurde daarna?
```

Daarvoor gebruiken we episode similarity.

### Eerste versie: numerieke vectors

Geen externe AI nodig.

Maak per episode een vaste vector:

- baseline.
- peak.
- trough.
- rise amount.
- drop amount.
- time to peak.
- time from peak to 6.0, 5.5, 5.0, 4.5, 4.0.
- max rise rate.
- max fall rate.
- deltas 5/10/15/20/30/60 minuten.
- area above baseline.
- area below baseline.
- curve samples genormaliseerd naar vaste lengte.

Similarity:

- cosine similarity voor genormaliseerde vectors.
- Euclidean distance voor simpele featurevectors.
- Dynamic Time Warping later als curves verschoven in tijd lijken.

### Tweede versie: vector index

Als de database groeit:

- MongoDB collection `episode_vectors` met vectorveld.
- Lokale vector search in Node.js als Mongo geen vector index heeft.
- Of later MongoDB Atlas Vector Search / pgvector / sqlite-vss als we overstappen.

Voor nu is lokale vector search voldoende, omdat jouw persoonlijke dataset klein begint.

### Derde versie: AI embeddings

Later kan een LLM/embedding model tekstuele episode-samenvattingen embedden:

```text
snelle stijging vanaf 5.8 naar 8.8, daarna daling naar 5.7 binnen 24 min, near-hypo later
```

Maar dit is aanvullend. De numerieke curvevector blijft leidend.

## Privacy en veiligheid

- Alles blijft lokaal in MongoDB.
- Geen externe modeltraining.
- Ruwe CGM-data blijft onveranderd.
- Analysecollections kunnen opnieuw worden opgebouwd uit `entries`.
- Bij twijfel moet de app zeggen: "sensorwaarde bevestigen bij klachten".

## AI-laag

Later kan er een AI of LLM aan gekoppeld worden. Die AI moet niet de primaire realtime alarmbeslissing nemen. De live waarschuwing moet snel, voorspelbaar en lokaal blijven. De AI krijgt een andere rol: context begrijpen, verklaren, vragen stellen, weekpatronen vinden en het model helpen beter te worden.

Rolverdeling:

```text
CGM entries
  -> feature extractor
  -> pattern_events + prediction_snapshots
  -> deterministisch risicomodel voor live alarm
  -> AI-laag voor uitleg, context, feedback en patroonanalyse
```

De AI mag lezen:

- `entries`: alleen als samengevatte vensters, niet standaard alle ruwe punten.
- `pattern_events`.
- `prediction_snapshots`.
- `model_state`.
- `user_feedback`.
- Dag- en weekstatistieken.

De AI mag schrijven:

- `ai_observations`: hypotheses en samenvattingen.
- `ai_questions`: vragen aan jou, bijvoorbeeld "Was dit na eten?"
- `user_feedback`: alleen na jouw antwoord.
- Geen directe alarmdrempels zonder evaluatie.

### Collection: `ai_observations`

Velden:

- `createdAt`.
- `scope`: `episode`, `day`, `week`, `model_review`.
- `relatedEventIds`.
- `summary`.
- `hypothesis`.
- `confidence`: `low`, `medium`, `high`.
- `needsUserConfirmation`: boolean.
- `acceptedByUser`: boolean of null.

Voorbeeld:

```json
{
  "scope": "episode",
  "summary": "Snelle post-hyper drop na vermoedelijke maaltijd.",
  "hypothesis": "Deze curve lijkt op eerdere snelle reactieve hypo's binnen 20-25 minuten na piek.",
  "confidence": "medium",
  "needsUserConfirmation": true
}
```

### Collection: `ai_questions`

Velden:

- `createdAt`.
- `question`.
- `reason`.
- `relatedEntryId`.
- `relatedEventId`.
- `answeredAt`.
- `answer`.

Voorbeelden:

- "Had je net gegeten?"
- "Was dit snelle koolhydraten?"
- "Voelde je hypo-klachten?"
- "Heb je dit bevestigd met vingerprik?"

## Geavanceerde meal-state machine

De app moet voorbereid zijn zodra hij merkt dat je waarschijnlijk hebt gegeten. Dat betekent: niet wachten tot je al laag bent, maar een interne toestand activeren.

States:

- `idle`: geen bijzonder patroon.
- `possible_meal`: glucose stijgt sneller dan normaal.
- `meal_spike`: duidelijke maaltijdachtige piek.
- `peak_watch`: piek is bereikt of lijkt dichtbij.
- `drop_watch`: daling na piek begint.
- `fast_drop_risk`: daling lijkt op jouw snelle hypo-patroon.
- `near_hypo`: onder 4.5 of snel richting 4.5.
- `hypo`: onder 4.0.
- `recovery`: waarde stijgt weer na hypo.

Overgangen:

```text
idle
  -> possible_meal       bij stijging over 5-15 min
  -> meal_spike          bij piek boven 8.5/9/10
  -> peak_watch          bij afvlakkende stijging
  -> drop_watch          bij eerste negatieve rate na piek
  -> fast_drop_risk      bij snelle daling die lijkt op eerdere crashes
  -> near_hypo           bij <4.5 of voorspeld <4.5
  -> hypo                bij <4.0
  -> recovery            bij stijging na laag
```

Wat "voorbereid zijn" betekent:

- Kortere predictiehorizon activeren: 10, 15, 20, 30 min.
- Vaker evalueren of de sync nieuwe data heeft.
- Strengere alarmregels gebruiken tijdens `peak_watch` en `drop_watch`.
- Vergelijkbare historische episodes zoeken.
- UI alvast tonen: "Maaltijdpiek gezien, let op daling".
- Eventueel zachtere pre-alert voordat het echte alarm nodig is.

Voor jouw snelle patroon is vooral deze overgang belangrijk:

```text
meal_spike -> peak_watch -> drop_watch -> fast_drop_risk
```

Als de piek boven 10 was en de daling binnen 5-10 minuten hard inzet, moet de app al in `fast_drop_risk` komen. Hij moet dan niet wachten tot je onder 5.0 bent.

Een extra directe overgang:

```text
peak_watch/drop_watch -> fast_drop_risk
```

als:

- laatste piek boven 9.5-10.0 was, of een adaptieve piek duidelijk boven baseline;
- actuele waarde rond of onder 6.5 zit;
- drop vanaf piek groter is dan 2.0-3.0 mmol/L, afhankelijk van piekhoogte;
- dit binnen ongeveer 20-45 minuten gebeurde.

Dit is precies het "van 10 naar 6" signaal, maar ook het "van 8.8 naar 6" signaal: nog geen hypo, maar wel een sterke aanwijzing dat het systeem alert moet zijn.

## Adaptieve drempels

Vaste drempels zijn nuttig, maar mogen nooit het enige criterium zijn. Het systeem moet leren wat voor jou groot, snel en gevaarlijk is.

Startwaarden:

- `absoluteHighPeak`: 10.0 mmol/L.
- `moderatePeak`: 8.5 mmol/L.
- `baselineRiseSignal`: +2.0 mmol/L boven recente baseline.
- `largeDrop`: -2.0 mmol/L binnen 20-30 minuten.
- `veryLargeDrop`: -3.0 mmol/L binnen 20-45 minuten.
- `dropPercentSignal`: 25-35% daling vanaf piek.
- `fastNegativeRate`: lager dan -0.08 mmol/L/min.

Deze waarden worden later persoonlijk bijgesteld op basis van:

- Welke signalen voorafgingen aan echte hypo's.
- Welke signalen vaak vals alarm waren.
- Welke piekhoogtes bij jou gevaarlijk zijn.
- Welke dropsnelheden bij jou gevaarlijk zijn.
- Hoe snel de daling na de piek begon.

Voorbeeld van leren:

```text
Als piek 8.7-9.2 en drop >= 2.4 binnen 25 min:
  historisch vaak near-hypo
  drempel verhogen naar high risk

Als piek 10.0 maar daling vlakt snel af boven 7.0:
  historisch vaak geen hypo
  drempel verlagen naar watch
```

## Wat kan dit systeem uiteindelijk allemaal?

### Realtime waarschuwingen

- Vroege waarschuwing bij snelle post-meal drop.
- Apart alarm voor `near_hypo` onder 4.5.
- Urgent alarm als onder 4.0 waarschijnlijk wordt.
- Alarmen met reden, niet alleen een getal.
- Snooze die slim blijft: snooze dempt geluid, maar blijft visueel risico tonen.

### Persoonlijke patroonherkenning

- Herkennen welke piekhoogtes bij jou gevaarlijk zijn.
- Leren of 8.5, 9.0 of 10.0 de beste startdrempel is.
- Leren welke dalingssnelheid bij jou meestal fout gaat.
- Onderscheid maken tussen snelle en vertraagde reactieve hypo's.
- Herkennen of bepaalde tijdstippen riskanter zijn.

### Maaltijdcontext

- Automatisch vermoedelijke maaltijd detecteren.
- Handmatig "ik eet nu" toevoegen.
- Later maaltijdtype leren: snelle koolhydraten, gemengd, vet/proteine.
- Leren of bepaalde maaltijdtypes een latere of snellere crash geven.
- Vragen stellen als context ontbreekt.

### Zelfevaluatie

- Elke voorspelling achteraf beoordelen.
- Missers opslaan.
- Valse alarmen opslaan.
- Lead time meten.
- Modelversies vergelijken.
- Alleen verbeteringen activeren die backtests beter maken.

### AI-assistent

- Dagrapport maken.
- Weekrapport maken.
- Uitleggen waarom een alarm kwam.
- Vragen welke context ontbrak.
- Voorbereid overzicht maken voor arts of dietist.
- Hypotheses maken zoals: "snelle piek + snelle daling na lunch geeft hoogste risico".

### Simulatie

- Historische dag opnieuw afspelen.
- Nieuwe drempels testen zonder live risico.
- Vergelijken: oude modelversie vs nieuwe modelversie.
- Uitzoeken hoeveel minuten eerder een alarm had kunnen komen.

## Extra databronnen voor maximale voorspelling

De beste voorspelling komt niet uit glucose alleen. Online onderzoek naar postprandiale glucose- en hypoglykemievoorspelling gebruikt vaak recente CGM-geschiedenis, maaltijdinformatie, activiteit en soms wearable-data. Voor jouw situatie is dit de prioriteit.

### Prioriteit 1: CGM zelf

Altijd beschikbaar en het belangrijkst.

- Ruwe glucosewaarde.
- Sensortrend.
- 1-minuut of 5-minuten interval.
- Deltas over 3, 5, 10, 15, 20, 30, 45, 60 minuten.
- Rates over dezelfde vensters.
- Versnelling.
- Curvevorm: stijging, piek, plateau, omslag, daling, herstel.
- Tijd sinds laatste piek.
- Tijd sinds laatste hypo.
- Time in range per dag.
- Variabiliteit per dag.
- Sensorleeftijd en datagaps.

### Prioriteit 2: Afgeleide maaltijddata

Voor reactieve hypo's is eten waarschijnlijk de belangrijkste context, maar de standaard moet zero-input zijn: jij hoeft niets in te vullen. Maaltijddata wordt primair automatisch afgeleid uit de CGM-curve.

Automatisch afleidbaar:

- vermoedelijke maaltijdstart.
- vermoedelijke piektijd.
- snelheid van stijging na vermoedelijke maaltijd.
- piekhoogte boven baseline.
- tijd tot piek.
- duur van plateau.
- snelheid van daling na piek.
- late tweede piek, mogelijk vet/proteine-effect of gemengde maaltijd.
- snelle hoge piek, mogelijk snelle koolhydraten.
- brede trage piek, mogelijk gemengde/vettere maaltijd.
- kleine piek met snelle crash, mogelijk zeer gevoelige respons.

Optionele invoer, niet vereist:

- `ik eet nu`.
- maaltijdtype: `snelle carbs`, `normaal`, `vet/proteine`, `onbekend`.
- geschatte grootte: `klein`, `normaal`, `groot`.

Nog betere optionele invoer:

- geschatte koolhydraten.
- suiker/snelle koolhydraten ja/nee.
- eiwit/vet indicatie.
- vezels indicatie.
- cafeine/alcohol.
- tijd sinds vorige maaltijd.

Afgeleide maaltijdfeatures:

- unannounced meal detection uit CGM-curve.
- piekhoogte na vermoedelijke maaltijd.
- tijd tot piek.
- tijd tot daling.
- oppervlakte boven baseline.
- post-meal drop onder baseline.
- piekbreedte.
- aantal pieken binnen 3 uur.
- verhouding snelle stijging / langzame daling.
- verhouding stijging / crash.

### Prioriteit 3: Symptomen en bevestiging

Omdat CGM en klachten niet altijd perfect samenvallen, moet jouw ervaring worden meegenomen.

- `ik voel hypo`.
- klachtenniveau: mild, medium, heftig.
- symptomen: trillen, zweten, hartkloppingen, duizelig, honger, brain fog, paniek/onrust.
- vingerprik bevestigd ja/nee.
- snelle koolhydraten genomen ja/nee.
- herstel na eten/drinken ja/nee.

Dit helpt onderscheid maken tussen:

- echte lage glucose;
- sensor-lag of sensorfout;
- postprandiaal syndroom met klachten zonder echte lage waarde;
- snelle daling die klachten geeft voordat de absolute waarde laag is.

### Prioriteit 4: Activiteit en beweging

Beweging kan glucose sneller laten dalen of herstel veranderen.

Bronnen:

- Apple Health, Google Fit, Garmin, Oura, Fitbit of handmatig.

Velden:

- stappen laatste 15, 30, 60, 120 minuten.
- workout ja/nee.
- intensiteit.
- hartslag.
- hartslagvariabiliteit als beschikbaar.
- wandelen direct na eten.
- rust/slaap.

### Prioriteit 5: Slaap, stress en herstel

Niet alles is maaltijd. Stress, slechte slaap en ziekte kunnen curvevorm veranderen.

- slaapduur.
- slaapkwaliteit.
- rusthartslag.
- HRV.
- stressscore.
- ziekte/koorts.
- menstruatiecyclus indien relevant.
- medicatie/supplementen.

### Prioriteit 6: Context

- tijdstip van de dag.
- dag van de week.
- thuis/werk/reis.
- ochtend/lunch/avond/nacht.
- vorige hypo binnen 6-12 uur.
- meerdere spikes achter elkaar.

## Sensorbetrouwbaarheid en datakwaliteit

Een voorspelmodel moet ook weten wanneer data minder betrouwbaar is.

Te bewaren:

- ontbrekende minuten.
- dubbele entries.
- sensorwissel.
- extreem abrupte enkelpunt-sprongen die mogelijk sensorruis zijn.
- compressie-lows tijdens slaap of druk op sensor.
- verschil tussen CGM en vingerprik als beschikbaar.

Regel:

```text
laag vertrouwen in sensor = voorzichtig tonen, minder hard alarmeren tenzij trend en context sterk zijn
```

## Featuregroepen

Het model krijgt features in groepen, zodat we later kunnen zien welke groep echt helpt.

### Glucose-shape features

- baseline voor stijging.
- piekhoogte.
- tijd tot piek.
- delta vanaf baseline.
- drop vanaf piek.
- droppercentage.
- area under curve boven baseline.
- area below baseline na piek.
- steepest rise.
- steepest fall.
- turnaround speed.

### Meal-context features

- vermoedelijke maaltijd uit curve.
- afgeleid curve-type: `fast_carbs_like`, `mixed_meal_like`, `fat_protein_like`, `small_sensitive_response`, `uncertain_meal`.
- tijd sinds maaltijd.
- maaltijdgrootte.
- carbs/suiker indicatie.
- vet/proteine indicatie.
- maaltijd gemarkeerd, alleen als optionele extra.

### Body-context features

- stappen.
- hartslag.
- beweging na maaltijd.
- slaap.
- stress/HRV.
- klachten.

### History features

- aantal hypo's afgelopen 24 uur.
- vorige snelle drop.
- vergelijkbare episode count.
- historische kans op near-hypo bij soortgelijke curve.
- modelconfidence.

## Hoe anderen dit ongeveer doen

Patronen uit literatuur en CGM/ML-systemen:

- Postprandiale voorspelling gebruikt vaak een venster met recente glucosewaarden, bijvoorbeeld 30-60 minuten of langer voor maaltijdcontext.
- Voor hypo na maaltijd is een speciaal postprandiaal model nuttiger dan een algemeen nachtelijk/lineair model, omdat de dalingen sneller en grilliger kunnen zijn.
- Meal detection is een eigen taak: systemen proberen een maaltijd te herkennen uit snelle stijging en curvevorm als de maaltijd niet handmatig gelogd is.
- Modellen worden beter met maaltijdinformatie, carbs/macronutrienten en activiteit, maar recente CGM-trend blijft meestal de sterkste realtime input.
- CGM bij reactieve hypoglykemie wordt juist gebruikt omdat losse vingerprikken vaak het moment missen en symptomen vertraagd of eerder kunnen komen.

Vertaling naar ons systeem:

- CGM-curvevorm is de realtime basis.
- Meal-state machine detecteert vermoedelijk eten zonder handmatige input.
- Handmatige maaltijd/symptoomknoppen zijn optioneel en mogen nooit nodig zijn.
- Activity/wearable-data komt als extra context, niet als vereiste.
- AI/LLM analyseert episodes en stelt vragen, maar de live waarschuwing blijft snel en lokaal.

## Data-roadmap

### Nu

- CGM entries.
- Pattern events.
- Prediction snapshots.
- Zero-input maaltijdherkenning.
- Afgeleide maaltijdtypes uit curvevorm.

### Daarna

- Optionele feedbackknoppen.
- Symptomen en bevestiging als jij dat ooit wilt.
- Backtesting en dagelijkse modelmetrics.

### Later

- Apple Health/Google Fit stappen en hartslag.
- Slaap en HRV.
- Foto of tekst van maaltijd door AI laten samenvatten naar simpele features.
- Weekrapporten.
- Arts/export-overzicht.

## AI met maaltijdfoto of tekst

Later kan de AI helpen om maaltijdinformatie minder irritant te maken, maar dit is optioneel. De basis moet zonder invoer werken.

Voorbeelden:

- Jij typt: "boterham jam en koffie".
- AI maakt features: snelle carbs ja, vet/proteine laag, maaltijdgrootte klein/normaal.
- Jij maakt foto.
- AI schat grof: carbs/suiker indicatie, maaltijdtype, onzekerheid.

Belangrijk:

- AI schattingen zijn onzeker.
- De app moet ze als context gebruiken, niet als waarheid.
- Jij moet makkelijk kunnen corrigeren.

## Zero-input maaltijdherkenning

Omdat jij niets wilt invoeren, moet maaltijdherkenning automatisch gebeuren. Dit heet vaak unannounced meal detection.

De app zoekt naar maaltijdachtige patronen:

```text
stabiele baseline
+ duidelijke stijging
+ stijging houdt meerdere minuten aan
+ piek of plateau
= vermoedelijke maaltijd
```

Mogelijke categorieen zonder handmatige invoer:

- `fast_carbs_like`: snelle stijging, hoge of smalle piek, snelle daling.
- `mixed_meal_like`: middelmatige stijging, bredere piek, geleidelijke daling.
- `fat_protein_like`: tragere stijging, langer plateau, soms tweede piek.
- `small_sensitive_response`: kleine of matige piek, maar daarna opvallend snelle daling.
- `uncertain_meal`: patroon lijkt op eten, maar confidence is laag.

Dit zijn curve-types, geen harde voedingswaarheden. De app moet dus zeggen:

```text
lijkt op snelle-koolhydraat curve
```

niet:

```text
je hebt suiker gegeten
```

### Afgeleide maaltijdtype-features

Voor elk vermoedelijk maaltijd-event:

- `riseStartDate`.
- `peakDate`.
- `peakMmol`.
- `baselineMmol`.
- `riseMmol`.
- `riseRateMax`.
- `timeToPeakMinutes`.
- `peakWidthMinutes`.
- `areaAboveBaseline_2h`.
- `areaAboveBaseline_3h`.
- `dropAfterPeakMmol`.
- `dropAfterPeakRateMax`.
- `timePeakToUnder6`.
- `timePeakToUnder55`.
- `timePeakToUnder45`.
- `secondPeakDetected`.
- `curveType`.
- `curveTypeConfidence`.

### Meal-type inference regels versie 1

Startregels:

- Snelle-koolhydraat-achtig:
  - snelle stijging;
  - korte tijd tot piek;
  - smalle piek;
  - daarna snelle daling.
- Gemengd-achtig:
  - gemiddelde stijging;
  - piek houdt langer aan;
  - daling minder abrupt.
- Vet/proteine-achtig:
  - trage stijging;
  - brede plateau;
  - tweede piek of langdurig verhoogde waarde.
- Kleine-gevoelige respons:
  - piek hoeft niet hoog te zijn;
  - drop vanaf piek is relatief groot;
  - near-hypo risico kan toch hoog zijn.

Deze regels worden later vervangen of aangevuld met clustering op jouw eigen data.

### Clustering zonder labels

Omdat er geen maaltijdlabels zijn, moet het systeem unsupervised leren.

Aanpak:

1. Detecteer vermoedelijke maaltijd-events.
2. Bereken curvefeatures per event.
3. Cluster episodes op curvevorm.
4. Meet per cluster hoe vaak near-hypo/hypo volgt.
5. Geef clusters praktische namen.

Voorbeeld:

```text
Cluster A:
  snelle stijging, smalle piek, crash binnen 30 min
  hypo/near-hypo risico hoog
  naam: fast_crash_curve

Cluster B:
  lagere piek rond 8.5-9.0, toch snelle daling
  risico medium/hoog
  naam: moderate_peak_crash_curve

Cluster C:
  brede piek, geen crash
  risico laag
  naam: broad_stable_curve
```

De AI mag later helpen om deze clusters begrijpelijk te beschrijven, maar het model moet de clusters uit de data halen.

## Zero-input leerstrategie

Zonder handmatige invoer leert de app vooral uit uitkomsten:

- Welke curvevormen worden gevolgd door hypo?
- Welke piekhoogtes zijn gevaarlijk?
- Welke dropgroottes zijn gevaarlijk?
- Welke tijdstippen geven vaker crashes?
- Welke combinatie van stijging en daling lijkt op jouw snelle episodes?

Het systeem hoeft niet zeker te weten wat je at. Het hoeft alleen te weten:

```text
dit soort curve eindigt bij jou vaak in hypo
```

Dat is genoeg voor voorspelling.

## Minimale geavanceerde versie

De eerste serieuze versie moet minimaal dit kunnen:

1. Live meal-state bepalen.
2. Snelle post-hyper drop herkennen.
3. Voorspelling voor 10, 15, 20 en 30 minuten maken.
4. Prediction snapshot opslaan.
5. Snapshot later evalueren.
6. Events opslaan in `pattern_events`.
7. Feedbackknoppen opslaan.
8. Dagelijkse model-metrics berekenen.
9. Risico uitleggen in normale taal.

Daarna pas:

10. AI-vragen en AI-samenvattingen.
11. Persoonlijk getraind model.
12. Meal-type leren.
13. Weekrapporten en arts/export-weergave.

## App-ontwerp

Voeg een kleine "Hypo-risico" kaart toe:

- Risico: laag, let op, hoog, urgent.
- Kansvenster: 10, 15, 20, 30, 60, 120 of 180 minuten.
- Redenen: maximaal 2 korte regels.
- Laatste spike: piek, tijd geleden, huidige daling.

Voorbeeld:

```text
Hypo-risico: hoog
Mogelijk onder 4.5 binnen 15-30 min
Piek 10.7 om 15:09, snelle daling vanaf piek
Dit lijkt op eerdere snelle post-hyper drops
```

## Data-uitbreiding

Handmatige input mag helpen, maar het systeem mag er niet van afhankelijk zijn. De standaardmodus is zero-input: jij hoeft niets in te vullen.

Optionele input voor later:

- Knop: `Ik eet nu`.
- Optioneel: geschatte koolhydraten.
- Optioneel: soort maaltijd: snel, normaal, vet/proteine.
- Knop: `symptomen`.
- Knop: `vingerprik bevestigd`.

Zelfs simpele maaltijdmarkeringen maken het model sneller beter, maar ze zijn niet vereist. Zonder input moet de app zelf vermoedelijke maaltijdmomenten en maaltijdtypes afleiden uit de curve.

## Implementatiestappen

> Historische planstap — inmiddels uitgevoerd in `scripts/` (pattern-/risk-logica) en de
> nginx-overlay (`nightscout-overlay/rate-overlay.js`), niet in een React-module.

1. Rate-/patroon-/risicofuncties:
   - `calculateRates(readings)`
   - `detectSpikes(readings)`
   - `detectPostHyperDrops(readings)`
   - `scoreReactiveHypoRisk(readings, currentReading)`
   - `predictReactiveHypo(readings, currentReading)`
2. Analyse op Nightscout/MongoDB-data, episodes detecteren.
3. Risicokaart tonen in de nginx-overlay.
6. Gebruik risicoscore ook in alarmen, naast de bestaande 20-minuten voorspelling.
7. Voeg later maaltijdmarkeringen toe.

## Schrijfstrategie

Niet elke render van de frontend mag zomaar naar MongoDB schrijven. De leerlaag moet centraal en voorspelbaar draaien.

Aanpak:

- De LibreView sync blijft ruwe metingen naar Nightscout schrijven.
- Na elke nieuwe meting draait een lokale analysefunctie.
- Die analysefunctie schrijft maximaal 1 prediction snapshot per nieuwe CGM-entry.
- Episodes in `pattern_events` worden geupsert op basis van tijdvenster en type.
- Feedback vanuit de app schrijft direct naar `user_feedback`.
- Modeltraining draait periodiek, bijvoorbeeld elk uur of dagelijks.

Deduplicatie:

- `prediction_snapshots` krijgt een unieke key op `entryIdentifier + modelVersion`.
- `pattern_events` krijgt een stabiele `eventKey`, bijvoorbeeld `type:startDate:peakDate`.
- `user_feedback` krijgt eigen ids, want meerdere feedbackmomenten bij dezelfde meting zijn nuttig.

Retention:

- Ruwe entries nooit automatisch verwijderen.
- Prediction snapshots minimaal 90 dagen bewaren.
- Geaggregeerde model metrics onbeperkt bewaren.
- Als de database te groot wordt, oude snapshots samenvatten naar dagstatistieken.

## Live beslislogica

Bij elke nieuwe meting:

```text
1. Lees laatste 6 uur CGM-data.
2. Bereken rates en piek/drop context.
3. Haal actieve model_state op.
4. Maak voorspelling voor 10, 15, 20, 30, 60 min.
5. Sla prediction_snapshot op.
6. Update pattern_events als er een spike/drop/hypo loopt.
7. Toon alarm alleen als score/horizon boven drempel is en niet gesnoozed.
```

Voor snelle reactieve hypo's krijgt 10-30 minuten prioriteit. De 120-180 minuten horizon is informatief, maar mag niet de snelle waarschuwingen vertragen.

## Validatie

We meten per dag:

- Hoe vaak voorspelde de app een hypo die niet kwam?
- Hoe vaak kwam er een hypo zonder waarschuwing?
- Gemiddelde waarschuwingstijd voor hypo.
- Gemiddelde waarschuwingstijd voor snelle hypo's binnen 30 minuten na piek.
- Aantal waarschuwingen per dag.
- Verschil tussen onder 4.5 voorspellen en onder 4.0 voorspellen.

Succescriteria eerste versie:

- Minstens 10-20 minuten eerder waarschuwing bij snelle post-hyper dalingen.
- Niet constant alarm slaan na elke maaltijd.
- Redenen zijn begrijpelijk genoeg om te vertrouwen of te negeren.

## Bronnen

- Endotext/NCBI Bookshelf: Non-Diabetic Hypoglycemia.
- Endocrine Society: Hypoglycemia clinical guidance and educational material.
- Studies over CGM bij reactieve hypoglykemie en postprandiale hypo-voorspelling laten zien dat CGM nuttig is voor patronen, maar postprandiale hypo voorspellen moeilijker is dan algemene trendvoorspelling.
