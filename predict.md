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

### 2. Rebound-drop

Na een spike letten we op:

- Daling vanaf de piek.
- Daaltempo over 3, 5, 10, 15, 20, 30 en 60 minuten.
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
- Versnelling: wordt de daling sterker of zwakker?
- Tijd sinds laatste piek boven 8.5, 9.0 en 10.0.
- Hoogte van de laatste piek.
- Daling vanaf de piek in mmol/L.
- Gemiddelde daling per minuut sinds de piek.
- Laagste waarde in vergelijkbare eerdere episodes.
- Tijdstip van de dag.
- Eventueel: handmatige maaltijdmarkering, als we die later toevoegen.

## Risicoscore versie 1

Begin met een uitlegbare score in plaats van direct machine learning.

Voorbeeld:

- `+3` als er in de afgelopen 6 uur een piek boven 10.0 was.
- `+4` als er in de afgelopen 30 minuten een piek boven 10.0 was en de waarde nu snel daalt.
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
- `scripts/evaluate-predictions.mjs`: vul uitkomsten van oude `prediction_snapshots`.
- `scripts/train-risk-model.mjs`: bereken nieuwe gewichten en schrijf `model_state`.
- `scripts/backfill-prediction-snapshots.mjs`: simuleer historische voorspellingen op oude data voor snellere training.

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

## Privacy en veiligheid

- Alles blijft lokaal in MongoDB.
- Geen externe modeltraining.
- Ruwe CGM-data blijft onveranderd.
- Analysecollections kunnen opnieuw worden opgebouwd uit `entries`.
- Bij twijfel moet de app zeggen: "sensorwaarde bevestigen bij klachten".

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

Sterk aanbevolen om later optioneel toe te voegen:

- Knop: `Ik eet nu`.
- Optioneel: geschatte koolhydraten.
- Optioneel: soort maaltijd: snel, normaal, vet/proteine.
- Knop: `symptomen`.
- Knop: `vingerprik bevestigd`.

Zelfs simpele maaltijdmarkeringen maken het model veel beter, omdat we dan niet hoeven te raden of een spike door eten kwam.

## Implementatiestappen

1. Maak `src/lib/patterns.ts`.
2. Voeg functies toe:
   - `calculateRates(readings)`
   - `detectSpikes(readings)`
   - `detectPostHyperDrops(readings)`
   - `scoreReactiveHypoRisk(readings, currentReading)`
   - `predictReactiveHypo(readings, currentReading)`
3. Maak unit tests met kleine synthetische curves.
4. Draai analyse op Nightscout/MongoDB-data en print episodes.
5. Toon risicokaart in `Nightscout.tsx`.
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
