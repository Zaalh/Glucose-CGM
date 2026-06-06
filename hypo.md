# Plan: betere hypo-detectie voor reactieve hypoglykemie

Dit plan beschrijft hoe we de huidige glucose-data uit LibreView, xDrip,
Nightscout, InfluxDB en Grafana kunnen gebruiken om reactieve hypo's eerder
te herkennen. Het doel is niet alleen achteraf rapporteren, maar vooral:

- vroeg waarschuwen bij snelle daling na een piek;
- hypo en near-hypo beter onderscheiden;
- minder vals alarm geven als de waarde nog veilig en stabiel is;
- leren van eerdere persoonlijke episodes.

Medische nuance: dit systeem is hulpmiddel en rapportage, geen vervanging voor
medisch advies of een officiële medische alarmfunctie. Bij klachten of twijfel
blijft een vingerprik/medisch advies belangrijk.

## Implementatiestatus (bijgewerkt 2026-06-02)

> **Update 2026-06-05 — M6-gate geslaagd, V2 LIVE geactiveerd.** Met ~8 weken data
> (13.652 readings, 33 nadir-gebaseerde hypo-onsets) bleek de auto-tuner een
> degenererende train/test-split te hebben: hij splitste op **kalendertijd**, terwijl
> de datadichtheid extreem ongelijk is (lege LibreView-history-backfill in april ↔
> dichte 1-min-stroom vanaf eind mei). 70% van de wandklok bevatte daardoor 0 events
> (train 0 / test 33) en de gate kon nooit eerlijk draaien. **Fix:** de split is nu
> **reading-index-gebaseerd** (70% van de gesorteerde metingen i.p.v. van de tijd) —
> nog steeds temporeel (één tijdsgrens, geen leakage), maar robuust tegen dichtheid.
> Split nu gezond: train 16 / test 18 onsets. Out-of-sample slaagt V2-tuned op de
> volledige gate: **recall 1.0** (0 gemist) en **precision 0.197** vs V1 0.833 / 0.162,
> lead-time 15 min (≥ V1). De tuner schreef `active: true`; de sync draait V2 nu als
> primaire `risk` met V1 als `legacyRisk` (live geverifieerd). Getunede params:
> `likely≥7, urgent≥8, accelDownBonus=0, worstCaseToLikely=false`. Open: absolute
> precision blijft laag (~1 op 5 alarmen echt — wel beter dan V1); lead-time haalt de
> ≥20-min-ambitie nog niet (de gate eist dat niet). De vroegere "precision ~0.05 /
> databottleneck ~4-5 dagen"-diagnose hieronder is daarmee achterhaald.

> **Update 2026-06-05 laat — post-hypo instabiliteit toegevoegd en live gezet.**
> Live voorbeeld: na een piek rond **12.0 mmol/L** zakte de glucose naar **2.94 mmol/L**
> en veerde daarna tijdelijk op naar ~4.5 mmol/L. Rond 23:48-23:50 leek de waarde even
> stabiel op **4.55**, maar binnen enkele minuten zakte hij alsnog door naar **4.05** en
> bleef de trend wisselend/dalend. Conclusie: bij dit persoonlijke patroon mag het
> hypo-risico niet verdwijnen zodra één of twee CGM-punten net boven 4.5 komen.
> `buildHypoFeatures` levert daarom nu recente-low context (`recentLowMmol`,
> `minutesSinceRecentLow`, `reboundFromRecentLowMmol`, `recentLevel1Hypo`,
> `recentLevel2Hypo`). V2 gebruikt die als extra component (`recentLowScore`) en als
> veiligheids-override: na een recente diepe hypo (<3.0) blijft risico minimaal hoog,
> en bij opnieuw dalen rond laag gebied blijft het urgent. Geverifieerd lokaal én remote
> met `scripts/fixtures/post-hypo-unstable-fall.json`; de live sync is herstart en nieuwe
> snapshots bevatten `recentLowMmol: 2.941`, `recentLevel2Hypo: true`, `risk: urgent`.

De V2-laag uit dit plan is gebouwd, gedeployed op de iMac en getest op echte data.
Stand van zaken per mijlpaal:

- **M1 — rijkere snapshots (af, live):** `prediction_snapshots` bevat nu `features`,
  `predicted`, `pattern` en `lagAdjustedMmol`; de `riskDetails`-persist-bug is gefixt;
  `modelVersion` = `rules-v1.1`. Geen gedragswijziging in de V1-risicologica.
- **M2 — gedeelde detector-lib (af):** `scripts/lib/hypo-features.mjs`
  (`buildHypoFeatures`) en `scripts/lib/reactive-hypo-detector.mjs`
  (`evaluateReactiveHypoRiskV2`, component-scores + scenario's + overrides, tunebaar via
  `context.params`). Inclusief post-hypo instabiliteit: recente nadir, tijd sinds nadir
  en rebound bepalen mee of herstel echt stabiel is. Fixtures in `scripts/fixtures/`.
- **M3 — episode-builder (af):** `scripts/lib/episode-builder.mjs` +
  `scripts/build-reactive-hypo-episodes.mjs` → collectie `reactive_hypo_episodes`
  (198 episodes uit 7501 entries).
- **M4 — backtest + auto-tuner (af):** `scripts/evaluate-hypo-detector.mjs` (V1 vs V2,
  precision/recall/lead-time, early-warning-only, dichtheidsfilter) +
  `scripts/lib/legacy-risk-v1.mjs`. Auto-tuner `scripts/tune-reactive-hypo-v2.mjs`
  (`reactive-hypo-v2-state.json`).

**Methodiek volgt CGM-literatuur** (o.a. PMC10012121 ensemble-CGM-hypo): ±30 min
event-window, "sustained" hypo (≥10 min onder grens), temporele train/test-split met
recall-gebonden grid search, en rapportage in- én out-of-sample.

**Kernbevinding — event-definitie (gecorrigeerd 2026-06-04):** de oorspronkelijke
bottleneck-diagnose ("te weinig sustained hypo's") was een artefact van de event-definitie,
niet van de data. De backtest telde een hypo pas bij ≥10 min aaneengesloten onder de grens
(diabetes-CGM-criterium). Maar deze gebruiker heeft **reactieve/postprandiale hypoglykemie**:
korte scherpe dips ~30–40 min na een maaltijdpiek, vaak maar enkele minuten onder de grens.
De literatuur bevestigt dit (nadir 30–40 min na piek; een *duur*-drempel voor postprandiale
hypo is "niet goed gekarakteriseerd"). Het ≥10-min-filter gooide juist de dips weg die de
gebruiker voelt.

Geverifieerd op de live data (5341 entries, 2026-05-31→06-04, mediaan-gap 1.0 min/dag):

| Drempel | losse dips | ≥3 min | ≥5 min | ≥10 min |
|---|---|---|---|---|
| <3.9 | 16 (~4/dag) | 10 | 9 | 7 |
| <3.0 | 4 | 3 | 2 | 1 |

**Fix:** de event-definitie is nu nadir-gebaseerd (`SUSTAIN_MIN` 10→2 min; alleen
enkel-sample sensorruis wordt nog afgewezen). Daarmee telt de backtest ~16 events i.p.v. 7
en geeft een 70/30-split ~12/4 i.p.v. 5/2 — niet langer degenererend. Dit lijnt de backtest
ook uit met de `episode-builder`, die al nadir-gebaseerd labelt (train/serve-pariteit).

**Secundair — meetvenster:** de resolutie is fijn (1-min, geverifieerd), maar het venster is
nog kort (~4–5 dagen) omdat de LibreView history-backfill nooit lukte (LSL-history/
measurements gaven 400/403/404). Voor lange-termijn-patronen (weekdag, tijd-van-de-dag)
hebben we dus meer kalenderdagen nodig; voor de event-telling/tuning was de definitie de
echte blocker.

- **M5 — shadow-mode (af, live):** V2 draait stil mee in de sync; per snapshot
  `shadowRisk`/`shadowScore`/`shadowConfidence`/`shadowReasons`/`shadowTuned`. Geen alarm.
  De live-sync geeft V2 hetzelfde `pattern`-object door als V1 (component 6 /
  `patternScore` wordt echt gevoed). **Train/serve-pariteit is nu rond:** de similarity
  zit in de gedeelde module `scripts/lib/episode-similarity.mjs` (`findSimilarEpisodes` +
  `patternFromFeatures`), en de backtest (`evaluate-hypo-detector.mjs`) én de auto-tuner
  (`tune-reactive-hypo-v2.mjs`) laden `episode_vectors` en voeden V2 per punt hetzelfde
  pattern als de live-sync. Daarmee tunen we op dezelfde score als we serveren.
  Ook de live-sync bouwt het V2-`pattern` nu via `patternFromFeatures` op exact dezelfde
  featureset die V2 ziet — zo verschilt `minutesSincePeak` niet meer door de tie-break in
  de piekselectie (live `>` = nieuwste piek vs. builder `>=` = oudste). Pariteit is dus
  100%, niet bij benadering. (Het `similar`-object voedt nog wel de forecast-correctie en
  de V1-reden.) **Bekende beperking:** de tuner geeft de volledige vectorset aan train én
  test, dus component 6 heeft een lichte look-ahead; effect is klein (max 2 punten) en de
  M6-gate is sowieso datagelimiteerd. Een tijd-gefilterde vectorset is een latere verfijning.
  De overlay-kaart toont V1 en V2 naast elkaar (`niveau · score`, bij V2 ook `confidence %`
  en `✓` bij getunede params; V1 zonder `%`, want het regelmodel kent geen confidence),
  met de redenen per model in de hover-tooltip.
- **Automatisch leren (af, dagelijks):** `scripts/daily-hypo-tune.sh` via launchd
  (`deploy/com.glucosecgm.hypotune.plist`, 04:30): episodes verversen → auto-tunen op je
  eigen episodes → dag/week/weekdag/patroon-rapporten (`scripts/hypo-report.mjs`,
  `scripts/hypo-patterns.mjs`) in `hypo-tune-reports/`. De sync laadt de geleerde params
  (`scripts/reactive-hypo-v2-state.json`) en past ze toe op V2 shadow.
- **M6 — auto-activatie met kwaliteitsgate (gewapend):** de tuner zet `active: true`
  alleen als er genoeg events zijn én V2 op out-of-sample data niet slechter is dan V1
  (recall en precision). De sync laat dan `risk` uit V2 komen (`likely`→`high`) en bewaart
  V1 als `legacyRisk`. Tot de gate slaagt blijft V1 de alarmbron.

**Methodiek volgt CGM-literatuur** (o.a. PMC10012121 ensemble-CGM-hypo): ±30 min
event-window, temporele train/test-split met recall-gebonden grid search, en rapportage
in- én out-of-sample. **Afwijking voor reactieve hypo:** géén ≥10-min-sustained-criterium —
de event-definitie is nadir-gebaseerd (`SUSTAIN_MIN`=2, alleen enkel-sample ruis afgewezen),
want reactieve hypo's zijn korte scherpe dips (~30–40 min na de piek; postprandiale
duur-drempel is in de literatuur niet gekarakteriseerd).

**Kernbevinding — event-definitie:** V2 doet wat het moet op lead-time (~20 min,
vergelijkbaar met de 17.5 min uit onderzoek) maar met te veel vals alarm (precision ~0.05).
De oorspronkelijke "te weinig events"-diagnose kwam door het ≥10-min-filter, dat reactieve
dips wegfilterde. Met de nadir-gebaseerde definitie telt de backtest ~16 events i.p.v. 7 en
degenereert de split niet meer (~12/4 i.p.v. 5/2). De resolutie is fijn (1-min); het
meetvenster (~4–5 dagen, LibreView history-backfill lukte nooit: 400/403/404) is alleen voor
lange-termijn-patronen nog kort. Het systeem verzamelt vanzelf meer dagen; V2 wordt pas
live als de gate slaagt (V2 ≥ V1 op recall én precision out-of-sample).

**Jouw patroon (geverifieerd uit de live data):** ~16 dips onder 3.9 in 4 dagen (~4/dag),
meestal kort — de gebruiker voelt ze allemaal, maar slechts 7 duren ≥10 min. Ze zijn
reactief/postprandiaal: telkens voorafgegaan door een piek (6.9–10.7 mmol/L) zo'n 22–116 min
eerder, met een daling van 4.0–7.8 mmol/L de hypo in (nadir 2.9–3.4). Dit bevestigt dat de
piek→drop-context (component die V2 op `dropFromPeakMmol` / `minutesSincePeak` bouwt) de
juiste voorspeller is, en dat een korte-dip (nadir-gebaseerde) event-definitie nodig is.
Tijd onder 3.9 ≈ 2.7%, onder 3.0 ≈ 0.36%.

**Aanvulling — instabiel herstel na hypo:** het live patroon laat zien dat herstel niet
binair is. Een CGM-reeks kan na een diepe dip kort opveren naar 4.5-5.0 en daarna alsnog
opnieuw dalen. Door CGM-lag en de snelle wisseling is "actuele waarde net boven 4.5" dus
onvoldoende bewijs dat het risico voorbij is. V2 schaalt pas af als er stabiel herstel is:
geen recente diepe nadir, voldoende rebound vanaf de nadir, geen dalende trend en geen
lag-adjusted waarde in/onder het near-low gebied.

## Huidige situatie

De basis is aanwezig:

- Libre sensor levert glucosemetingen.
- LibreView-sync schrijft data naar Nightscout.
- xDrip/Nightscout/InfluxDB/Grafana gebruiken dezelfde meetketen.
- Grafana toont glucose, stijgen/dalen, piek/drop en tegels.
- `scripts/libreview-nightscout-sync.mjs` berekent al een risicoscore.
- Er is al logica voor:
  - actuele waarde onder 4.0 mmol/L;
  - near-hypo onder 4.5 mmol/L;
  - recente piek;
  - daling vanaf piek;
  - snelheid over 5, 10 en 15 minuten;
  - geschatte tijd tot 4.0 en 4.5 mmol/L.

## Waarom het beter moet

Reactieve hypoglykemie draait vaak om het patroon, niet alleen om de actuele
waarde. Een waarde van 6.5 mmol/L kan veilig lijken, maar riskant zijn als die
net van 10.5 mmol/L komt en snel daalt.

Belangrijke beperkingen nu:

- De huidige drempels zijn handmatig gekozen.
- De detector is nog niet gevalideerd tegen jouw echte hypo-momenten.
- CGM-data loopt achter op bloedglucose, vooral bij snelle veranderingen.
- Maaltijd, beweging, slaap, stress en alcohol zitten nog niet in de score.
- Er is nog geen duidelijke evaluatie van vals-positief en vals-negatief alarm.

## Online voorbeelden en lessen

Andere CGM-projecten en documentatie lossen dit probleem meestal niet op met
een enkele grenswaarde. Ze combineren actuele glucose, trend, voorspelling,
context en veiligheidsdrempels.

### Nightscout

Nightscout ondersteunt alarmen voor hoge/lage glucose, ontbrekende data en
forecast-plugins. De documentatie noemt onder andere `ar2` forecast als default
forecast-keuze als er niets anders is ingesteld. Belangrijke les voor ons:

- alarmen horen apart te zijn van de ruwe glucosemeting;
- forecast is nuttig, maar moet uitlegbaar blijven;
- ontbrekende data moet ook een aparte waarschuwing kunnen zijn;
- Nightscout is geschikt als transportlaag naar apps zoals Nightwatch/xDrip.

Ontwerpkeuze voor dit project:

- schrijf `likely` en `urgent` naar Nightscout als status/event;
- schrijf `watch` vooral naar MongoDB/Influx/Grafana, niet als luid alarm;
- gebruik rate limiting zodat Nightscout niet volloopt met herhaalde events.

### xDrip+

xDrip+ heeft low/high alerts en predictive low/high alerts. De xDrip-documentatie
beschrijft dat predictive alerts momentum gebruiken: extrapolatie van de huidige
BG-trend, niet per se alle prediction-settings. Belangrijke les:

- korte-termijn momentum is belangrijk voor "gaat zo laag worden";
- alert-instellingen moeten los staan van grafiekweergave;
- gebruikers hebben controle nodig over gevoeligheid en herhaling.

Ontwerpkeuze voor dit project:

- gebruik `blendedRate` als momentumlaag;
- maak `minutesTo45` en `minutesTo40` expliciet;
- maak drempels later configureerbaar via `.env` of configbestand;
- voorkom alarmspam met cooldown per risiconiveau.

### OpenAPS / oref0

OpenAPS/oref0 gebruikt meerdere voorspelde BG-scenario's in plaats van een
enkele rechte lijn. Documentatie beschrijft onder andere voorspellingen per
5-minuten interval en safety thresholds. Voor mensen met insuline gebruikt het
IOB/COB en insuline-effecten; dat past niet rechtstreeks op reactieve hypo
zonder insulinedata, maar de architectuur is waardevol.

Belangrijke les:

- maak meerdere scenario's, niet een enkele voorspelling;
- beslis op basis van het laagste verwachte punt binnen een horizon;
- safety thresholds moeten conservatief zijn;
- live beslissingen en offline evaluatie moeten dezelfde logica gebruiken.

Ontwerpkeuze voor dit project:

- maak minimaal drie forecast-scenario's:
  - `momentum`: huidige trend doorgetrokken;
  - `decay`: trend zwakt geleidelijk af;
  - `pattern`: correctie op basis van eerdere vergelijkbare episodes;
- gebruik de laagste voorspelde waarde binnen 30 minuten als alarmsignaal;
- bewaar alle scenario's in `prediction_snapshots`.

### Libre trendpijlen

Libre en andere CGM-systemen gebruiken trendpijlen als rate-of-change signaal.
In publicaties over Libre-trendpijlen worden praktische snelheidsbanden genoemd:

- ongeveer `< 0.05 mmol/L/min`: vlak of langzaam;
- ongeveer `0.05 - 0.10 mmol/L/min`: stijgend/dalend;
- ongeveer `> 0.10 mmol/L/min`: snel stijgend/dalend.

Belangrijke les:

- onze drempels `-0.03`, `-0.05`, `-0.08` en `-0.10` mmol/L/min zijn logisch;
- een "platte" pijl betekent niet altijd veilig als glucose dicht bij laag zit;
- bij snelle daling is CGM-lag extra belangrijk.

Ontwerpkeuze voor dit project:

- align trend labels met bekende CGM-pijlbanden;
- toon zowel pijl als numerieke rate;
- behandel `4.6 mmol/L met snelle daling` anders dan `4.6 mmol/L stabiel`.

### Wat we niet blind moeten kopieren

Veel bestaande systemen zijn ontworpen voor type 1 diabetes en insuline-dosing.
Reactieve hypoglykemie zonder insulinepomp vraagt andere nadruk:

- minder focus op IOB/COB als die data ontbreekt;
- meer focus op piek-na-maaltijd en snelle post-piek daling;
- meer persoonlijke patroonherkenning;
- near-hypo klachten serieus nemen, ook als CGM nog niet onder 4.0 zit.

## Jouw patroon: sneller dan standaard

Algemene informatie over reactieve hypoglykemie noemt vaak dalingen binnen
enkele uren na eten. Voor dit project moeten we niet wachten op zo'n lang
venster, omdat jouw patroon sneller kan zijn. De detector moet daarom eerst
kijken naar de snelle post-piek fase.

Belangrijk uitgangspunt:

- jouw persoonlijke snelheid gaat boven algemene literatuurvensters;
- een snelle piek gevolgd door snelle daling moet vroeg alarm geven;
- lange maaltijdvensters zijn extra context, niet de hoofdtrigger;
- `minutesTo45` en `minutesTo40` zijn belangrijker dan "hoeveel uur na eten".

Praktische korte vensters:

- `0-15 min na piek`: vroege draai herkennen;
- `15-45 min na piek`: hoogste aandacht voor snelle reactieve daling;
- `45-90 min na piek`: nog steeds relevant, maar minder urgent zonder snelle rate;
- `90-240 min`: alleen gebruiken voor vertraagde eiwit/vet/gemengde effecten.

Snelle waarschuwing moet al starten als:

- piek `>= 7.5` en daling `>= 1.0 mmol/L` binnen 30 minuten;
- piek `>= 8.5` blijft een sterker signaal, maar mag niet de minimumgrens zijn;
- `rate10m <= -0.05` na een maaltijdachtige piek;
- `rate5m <= -0.08`, ook als de glucosewaarde nog boven 5.0 zit;
- voorspelling onder 4.5 komt binnen 15-20 minuten;
- vergelijkbare eerdere snelle episodes vaak near-hypo/hypo werden.

Voor jouw situatie moeten de defaults dus agressiever vroeg kijken:

```text
HYPO_FAST_PATTERN_PEAK_WINDOW_MINUTES=45
HYPO_FAST_PATTERN_MIN_PEAK_MMOL=7.5
HYPO_FAST_PATTERN_STRONG_PEAK_MMOL=8.5
HYPO_FAST_PATTERN_DROP_MIN_MMOL=1.0
HYPO_FAST_PATTERN_RATE10=-0.05
HYPO_FAST_PATTERN_RATE5=-0.08
HYPO_EARLY_WARN_MINUTES_TO_45=20
HYPO_URGENT_MINUTES_TO_40=15
```

## Automatisch leren van eten en maaltijdreacties

Wens: het systeem moet zoveel mogelijk vanzelf leren wanneer je hebt gegeten,
wat het vermoedelijk effect was, en of dat later een hyper, hypo of combinatie
gaf. Dat kan als patroonherkenning, maar met een grens:

- zonder invoer kan het systeem niet zeker weten wat je precies at;
- het kan wel automatisch maaltijdachtige patronen herkennen;
- het kan leren dat bepaalde curvevormen bij jou horen bij suiker, koolhydraten,
  eiwit, vet of gemengde maaltijden;
- af en toe feedback maakt het veel sterker, maar moet niet verplicht zijn.

### Automatisch maaltijdmoment herkennen

Een `meal_candidate` kan automatisch worden gedetecteerd als:

- glucose binnen korte tijd duidelijk stijgt;
- stijgsnelheid boven een drempel komt;
- er een lokale piek ontstaat;
- daarna een daling volgt;
- het patroon vaker rond vergelijkbare momenten voorkomt.

Voor jouw snelle patroon gebruiken we twee soorten maaltijdvensters:

- `fastMealWindow`: 0-90 minuten, voor snelle piek/daling.
- `delayedMealWindow`: 90-300 minuten, voor eiwit/vet/gemengde effecten.

Eerste databasecheck op jouw Nightscout-data liet zien dat snelle vensters echt
belangrijk zijn:

- veel piek-daling episodes starten al rond `7.5-8.0 mmol/L`;
- ongeveer twee derde van de near-hypo/hypo passages na een piek gebeurt binnen
  45 minuten;
- daarom moet de detector niet wachten op een piek boven `8.5` of op een lang
  postprandiaal venster.

Startregels voor snelle maaltijdreactie:

- `riseFromBaselineMmol >= 1.0`;
- `rate10m >= 0.04`;
- lokale piek binnen 15-75 minuten;
- daarna `rate10m <= -0.04` of drop `>= 1.0 mmol/L`.

### Maaltijdtype schatten uit curvevorm

Het systeem mag een vermoedelijk type labelen, maar dit blijft een inschatting:

- `fast_sugar`: snelle stijging, korte piek, relatief snelle daling.
- `carb_heavy`: duidelijke stijging binnen 30-90 minuten, grotere piek.
- `protein_heavy`: mildere of vertraagde stijging, langer effect 2-5 uur.
- `fat_protein_mixed`: vertraagde brede stijging of tweede golf.
- `unknown_meal`: maaltijdachtig patroon, type onzeker.
- `non_meal_spike`: stress, sensorruis, compressie, beweging of onbekend.

Jouw observatie moet expliciet als hypothese in het model:

- suiker kan bij jou soms minder heftig zijn dan verwacht;
- eiwit kan juist heftig of vertraagd reageren;
- koolhydraten kunnen snelle piek/drop geven;
- daarom moet het model per persoon leren, niet algemene voedingsregels volgen.

### Hyper en hypo samen modelleren

Voor reactieve hypo is de hyper/piek vaak onderdeel van hetzelfde event.
Daarom moet een episode niet alleen `hypo` zijn, maar een postprandiale episode.

Mogelijke outcomes:

- `stable`: geen grote afwijking.
- `hyper_only`: piek hoog, geen hypo.
- `near_hypo_only`: geen grote piek, wel near-hypo.
- `reactive_near_hypo`: piek gevolgd door `< 4.5`.
- `reactive_hypo`: piek gevolgd door `< 4.0`.
- `hyper_then_hypo`: duidelijke hyper gevolgd door hypo.
- `fast_spike_fast_drop`: snelle piek en snelle daling, ook als nadir net veilig is.
- `delayed_hyper`: vertraagde stijging zonder hypo.
- `rebound_hyper`: stijging na hypo/correctie.

### Meal response document

Nieuwe collection:

```text
meal_response_events
```

Voorbeeld:

```json
{
  "version": 1,
  "detectedAt": "2026-06-01T12:00:00.000Z",
  "windowStart": "2026-06-01T11:30:00.000Z",
  "windowEnd": "2026-06-01T13:00:00.000Z",
  "inferredMealAt": "2026-06-01T11:45:00.000Z",
  "inferredMealType": "carb_heavy",
  "confidence": 0.68,
  "baselineMmol": 5.4,
  "peakMmol": 9.1,
  "nadirMmol": 4.2,
  "timeToPeakMinutes": 28,
  "minutesPeakToNadir": 34,
  "dropFromPeakMmol": 4.9,
  "maxFallRate10m": -0.08,
  "outcome": "fast_spike_fast_drop",
  "manualFood": null,
  "manualMacros": null,
  "feedback": []
}
```

### Automatisch leren zonder feedback

Zonder feedback kan het systeem alsnog leren via self-supervised labels:

- deze curve had snelle piek;
- deze curve had snelle post-piek daling;
- deze curve ging later onder 4.5;
- deze curve bleef veilig;
- deze curve had vertraagde tweede golf;
- deze curve lijkt op eerdere eiwitachtige patronen.

Daarna kan het clusteren:

- cluster A: snelle suikerpiek, meestal veilig;
- cluster B: koolhydraatpiek, vaak snelle daling;
- cluster C: eiwit/vet breed effect, late stijging;
- cluster D: hoge piek gevolgd door reactieve hypo;
- cluster E: sensorruis of onduidelijk.

### Live gebruik

Live detector krijgt extra context:

- `activeMealWindow`: ja/nee.
- `fastMealWindow`: ja/nee.
- `delayedMealWindow`: ja/nee.
- `inferredMealType`: geschat type.
- `minutesSinceInferredMeal`.
- `postMealPeakDetected`: ja/nee.
- `mealPatternRisk`: kans op hypo/hyper vanuit eerdere vergelijkbare maaltijden.

Voor snelle patronen moet `mealPatternRisk` direct invloed hebben op `watch` en
`likely`, niet pas als de glucose al laag is.

## Definities

Voor dit project gebruiken we praktische niveaus:

- `low`: geen duidelijk risico.
- `watch`: patroon verdient aandacht.
- `likely`: hypo of near-hypo is waarschijnlijk als trend doorzet.
- `urgent`: actuele hypo of zeer waarschijnlijke hypo op korte termijn.

Praktische glucosegrenzen:

- `< 4.5 mmol/L`: near-hypo / vroeg waarschuwen.
- `< 4.0 mmol/L`: hypo-alarmgrens voor dit dashboard.
- `< 3.9 mmol/L`: gangbare internationale level-1 hypo grens.
- `< 3.0 mmol/L`: ernstiger/klinisch significante hypo grens.

## Nieuwe detectie-aanpak

De hypo-detectie moet uit meerdere lagen bestaan.

## Dataflow

De detector moet expliciet maken welke laag welke verantwoordelijkheid heeft.

```text
Libre sensor
  -> LibreView
  -> libreview-sync
  -> Nightscout entries/devicestatus
  -> MongoDB collections
  -> InfluxDB metrics
  -> Grafana rapportage
  -> Nightwatch/xDrip via Nightscout
```

Belangrijk onderscheid:

- Nightscout/MongoDB is de bron voor ruwe historie, snapshots, feedback en episodes.
- InfluxDB is vooral handig voor tijdreeksen, Grafana-panelen en snelle aggregaties.
- Grafana is rapportage/visualisatie, niet de plek waar medische logica hoort te leven.
- `libreview-nightscout-sync.mjs` is nu de beste plek voor live detectie.
- Een apart evaluatiescript is de beste plek voor backtests en tuning.

## Bestaande bouwstenen in de code

Er is al meer aanwezig dan alleen een simpele drempel:

- `prediction_snapshots`: live snapshots met huidige waarde, risico, voorspelling en redenen.
- `pattern_events`: eerdere patroon-events met piek/eindwaarde en tijd tot onder drempels.
- `episode_vectors`: vectoren voor similarity matching.
- `findSimilarEpisodes(...)`: vergelijkt huidige piek/drop/timing met eerdere episodes.
- `buildForecast(...)`: maakt voorspellingen op meerdere horizons.
- `evaluateRiskRuleV1(...)`: huidige regelscore.

V2 moet deze bouwstenen niet weggooien. V2 moet ze strakker maken, beter opslaan,
en meetbaar testen.

### 1. Actuele veiligheid

Direct risico op basis van de laatste waarde:

- `< 4.0`: urgent.
- `4.0 - 4.5` met dalende trend: likely of urgent.
- `4.0 - 4.5` stabiel/stijgend: watch of likely.

### 2. Trend en snelheid

Gebruik meerdere snelheden:

- `rate5m`: snelste, gevoelig voor ruis.
- `rate10m`: beste korte-termijn signaal.
- `rate15m`: bevestigt aanhoudende daling.
- `blendedRate`: gewogen combinatie van 5/10/15 minuten.

Voorstel drempels:

- `<= -0.03 mmol/L/min`: daling.
- `<= -0.05 mmol/L/min`: snelle daling.
- `<= -0.08 mmol/L/min`: zeer snelle daling.

### 3. Reactieve hypo-context

Een patroon is verdachter als er kort daarvoor een piek was:

- piek `>= 8.5 mmol/L` met snelle daling;
- piek `>= 10.0 mmol/L` binnen 30-60 minuten;
- drop vanaf piek `>= 2.0 mmol/L`;
- drop vanaf piek `>= 25%`;
- piek naar huidige waarde binnen 30-90 minuten.

### 4. Voorspelling

Bereken per meting:

- `minutesTo45`: tijd tot 4.5 bij huidige dalingssnelheid.
- `minutesTo40`: tijd tot 4.0 bij huidige dalingssnelheid.
- `predicted10m`, `predicted20m`, `predicted30m`.

Risico omhoog als:

- voorspeld `< 4.5` binnen 20 minuten;
- voorspeld `< 4.0` binnen 20 minuten;
- voorspelling én historische patroonmatch allebei risicovol zijn.

### 5. CGM-lag correctie

Bij snelle daling kan de echte bloedglucose lager zijn dan de CGM-waarde.
Daarom moet de detector bij snelle daling conservatiever zijn.

Voorstel:

- schat een `lagAdjustedMmol`;
- gebruik 4-6 minuten correctie bij snelle daling;
- toon in de uitleg dat dit een CGM-lag waarschuwing is.

Voorbeeld:

```text
lagAdjustedMmol = currentMmol + blendedRate * 5
```

Als `currentMmol = 5.0` en `blendedRate = -0.08`, dan is:

```text
lagAdjustedMmol = 4.6
```

Dat is nog geen hypo, maar wel duidelijker risico.

### 6. Persoonlijke patroonherkenning

De detector moet leren van eerdere episodes.

Per episode opslaan:

- startwaarde;
- piekwaarde;
- tijd sinds piek;
- maximale dalingssnelheid;
- drop vanaf piek;
- laagste waarde binnen 30/60/90 minuten;
- of jij klachten had;
- of het vals alarm was;
- maaltijd/context indien beschikbaar.

Daarna vergelijken:

- lijkt huidige curve op eerdere hypo-curves?
- hoeveel vergelijkbare episodes gingen onder 4.5?
- hoeveel gingen onder 4.0?
- hoe lang duurde dat gemiddeld?

## Feature set voor detector V2

Elke live meting krijgt een vaste set features. Diezelfde features moeten ook
offline in de backtest worden gebruikt, anders testen we iets anders dan live.

### Ruwe glucosefeatures

- `currentMmol`: laatste glucosewaarde.
- `previousMmol`: vorige glucosewaarde.
- `delta5m`: verschil met ongeveer 5 minuten terug.
- `delta10m`: verschil met ongeveer 10 minuten terug.
- `delta15m`: verschil met ongeveer 15 minuten terug.
- `ageSeconds`: leeftijd van de meting.

### Snelheidsfeatures

- `rate5m`: mmol/L/min over 5 minuten.
- `rate10m`: mmol/L/min over 10 minuten.
- `rate15m`: mmol/L/min over 15 minuten.
- `rate30m`: mmol/L/min over 30 minuten.
- `blendedRate`: gewogen rate, live en offline identiek berekend.
- `maxFallRate30m`: snelste daling in de laatste 30 minuten.
- `isAcceleratingDown`: daling wordt sneller.
- `isRecovering`: rate wordt minder negatief of positief.

> **Ruisnuance (gemeten op live data, 4 uur / 229 readings):** de korte vensters
> zijn ruis-gedomineerd. Gemeten spreiding van de rate per venster:
> 1m sd ≈ 0.16, 5m ≈ 0.11, 15m ≈ 0.08, 30m ≈ 0.06, 60m ≈ 0.04 mmol/L/min — het
> 60m-venster is ~4× rustiger dan 1m. De `sgv` wordt als heel getal mg/dL opgeslagen,
> dus de kwantisatie-vloer op 1m is al ~0.055 mmol/L/min; de rest is sensor-jitter.
> Conclusie: gebruik `rate1m`/`rate2m` alleen voor *richtingskentering*, nooit als
> losse helling. `blendedRate` moet de lange vensters zwaarder wegen, en
> `isAcceleratingDown` mag niet op één 1m-stap kunnen omklappen. Zie Laag 9.

### Piek/drop features

- `peakMmol120m`: hoogste waarde in laatste 120 minuten.
- `minutesSincePeak`: minuten sinds die piek.
- `dropFromPeakMmol`: piek min huidige waarde.
- `dropFromPeakPercent`: relatieve daling vanaf piek.
- `peakToCurrentSlope`: gemiddelde daling vanaf piek.
- `postPeakWindow`: `early`, `middle`, `late` of `none`.

### Forecast features

- `predicted10m`.
- `predicted20m`.
- `predicted30m`.
- `minutesTo45`.
- `minutesTo40`.
- `probLt45_20m`.
- `probLt40_20m`.
- `lagAdjustedMmol`.

### Pattern features

- `similarEpisodeCount`.
- `similarHypoCount`.
- `similarNearHypoCount`.
- `similarHypoRatio`.
- `similarMedianNadir`.
- `similarMedianMinutesTo45`.
- `similarMedianMinutesTo40`.
- `patternDropCorrection`.
- `patternConfidence`.

### Context features

In eerste versie mogen deze leeg/null zijn, maar het schema moet er al klaar
voor zijn:

- `mealMinutesAgo`.
- `carbsEstimate`.
- `exerciseMinutesAgo`.
- `sleepContext`.
- `manualFeeling`: bijvoorbeeld `feels_hypo`.
- `fingerstickMmol`.

## Episode model

Een episode is een stuk curve dat begint bij een relevante piek of snelle daling
en eindigt als de curve stabiliseert of herstelt.

### Episode start

Start een episode als een van deze regels waar is:

- piek `>= 8.5 mmol/L` en daarna daling `>= 1.0 mmol/L`;
- `rate10m <= -0.05`;
- `dropFromPeakMmol >= 1.5` binnen 90 minuten;
- huidige waarde `< 4.5`;
- handmatige feedback zoals `feels_hypo`.

### Episode einde

Eindig een episode als:

- glucose 30 minuten stabiel of stijgend is;
- er 120 minuten sinds piek voorbij zijn;
- er een nieuwe aparte piek ontstaat;
- er 45 minuten geen nieuwe data is.

### Episode outcome

Label elke episode achteraf:

- `hypo`: nadir `< 4.0`.
- `near_hypo`: nadir `>= 4.0` en `< 4.5`.
- `safe_drop`: duidelijke daling maar nadir `>= 4.5`.
- `false_alarm`: waarschuwing zonder near-hypo en door feedback bevestigd.
- `unknown`: onvoldoende data.

### Episode document

Voorstel voor MongoDB collection `reactive_hypo_episodes`:

```json
{
  "version": 2,
  "start": "2026-06-01T10:00:00.000Z",
  "end": "2026-06-01T11:30:00.000Z",
  "peakAt": "2026-06-01T10:15:00.000Z",
  "nadirAt": "2026-06-01T11:05:00.000Z",
  "startMmol": 7.2,
  "peakMmol": 10.4,
  "nadirMmol": 3.8,
  "endMmol": 5.1,
  "minutesPeakToNadir": 50,
  "minutesPeakToUnder45": 35,
  "minutesPeakToUnder40": 48,
  "dropFromPeakMmol": 6.6,
  "dropFromPeakPercent": 63.5,
  "maxFallRate30m": -0.09,
  "outcome": "hypo",
  "feedback": ["feels_hypo"],
  "featureVector": {
    "peakMmol": 10.4,
    "dropFromPeakMmol": 3.0,
    "minutesSincePeak": 30,
    "rate10m": -0.07,
    "rate15m": -0.05
  },
  "createdAt": "2026-06-01T12:00:00.000Z",
  "updatedAt": "2026-06-01T12:00:00.000Z"
}
```

## Similarity model

De huidige similarity gebruikt vooral piek, drop en timing. V2 moet dit
uitbreiden, maar niet te ingewikkeld maken.

### Feature-afstanden

Gebruik genormaliseerde afstanden:

- `peakMmol / 4.0`
- `dropFromPeakMmol / 3.0`
- `minutesSincePeak / 35`
- `rate10m / 0.08`
- `rate15m / 0.06`
- `dropFromPeakPercent / 30`

### Weging

Voorstel:

- piek: `15%`
- absolute drop: `25%`
- relatieve drop: `15%`
- minuten sinds piek: `15%`
- rate10m: `20%`
- rate15m: `10%`

### Confidence

Pattern confidence wordt hoger als:

- minstens 5 vergelijkbare episodes bestaan;
- vergelijkbare episodes dicht bij huidige situatie liggen;
- outcomes consistent zijn;
- episodes recent genoeg zijn;
- feedback aanwezig is.

Voorstel:

```text
patternConfidence = min(1, similarCount / 8) * outcomeConsistency * distanceQuality
```

## Detector V2 scoring

V2 moet geen zwarte doos zijn. Elk onderdeel levert punten en redenen op.

### Componenten

- `currentScore`: actuele waarde en near-hypo.
- `rateScore`: snelheid en acceleratie.
- `reactiveScore`: piek/drop context.
- `forecastScore`: voorspelde grenspassage.
- `patternScore`: persoonlijke historie.
- `lagScore`: CGM-lag correctie.
- `dampingScore`: demping voor veilig/stabiel patroon.

### Voorstel score-opbouw

```text
score =
  currentScore
  + rateScore
  + reactiveScore
  + forecastScore
  + patternScore
  + lagScore
  - dampingScore
```

### Risk mapping

- `score < 3`: `low`.
- `3 <= score < 5`: `watch`.
- `5 <= score < 8`: `likely`.
- `score >= 8`: `urgent`.

Hard overrides:

- actuele waarde `< 4.0`: altijd `urgent`.
- actuele waarde `< 4.5` en dalend: minimaal `likely`.
- `minutesTo40 <= 10`: minimaal `urgent`.
- `minutesTo45 <= 15` met post-piek daling: minimaal `likely`.

### Demping

Verlaag risico als:

- huidige waarde `>= 7.0` en geen snelle daling;
- rate positief of stabiel is;
- drop vanaf piek klein is;
- vergelijkbare episodes meestal veilig bleven;
- meting ouder is dan 10 minuten.

Niet dempen als:

- huidige waarde al `< 4.5`;
- rate10m `<= -0.08`;
- `minutesTo40 <= 15`;
- patroonmatch sterk richting hypo wijst.

## Variabiliteit en onzekerheid

Jouw lichaam kan op vergelijkbare voeding of vergelijkbare curves anders
reageren. De detector mag daarom nooit doen alsof er maar een uitkomst is.
Hij moet werken met scenario's, kansen en onzekerheid.

Online lessen die hierbij passen:

- studies over gepersonaliseerde voeding tonen grote verschillen in
  postprandiale glucose-responsen tussen personen;
- nieuwere CGM-studies laten ook binnen dezelfde persoon variatie zien bij
  vergelijkbare of herhaalde maaltijden;
- OpenAPS/oref0 gebruikt meerdere voorspelde BG-lijnen en kijkt naar het
  minimum/worst-case scenario binnen de horizon;
- recente ML-literatuur rond CGM voorspelling benadrukt uncertainty-aware
  voorspellingen, dus niet alleen een puntwaarde maar ook onzekerheidsbanden.

Ontwerpconclusie:

- V2 moet meerdere scenario's tegelijk berekenen;
- het alarm kijkt niet alleen naar de gemiddelde voorspelling;
- bij grote onzekerheid en mogelijk lage worst-case moet eerder `watch` of
  `likely` volgen;
- bij wisselende patronen moet de uitleg zeggen dat het patroon variabel is.

### Scenario's

Bereken minimaal deze scenario's:

- `momentum`: huidige `blendedRate` loopt nog 10-30 minuten door.
- `rateDecay`: daling/stijging vlakt geleidelijk af.
- `patternMedian`: mediaan van vergelijkbare eerdere episodes.
- `patternWorstSafe`: pessimistische maar realistische ondergrens, bijvoorbeeld
  20e percentiel van vergelijkbare episodes.
- `rebound`: daling stopt en glucose herstelt.
- `delayedMeal`: latere eiwit/vet/gemengde maaltijdrespons.

Voor jouw snelle patroon is vooral belangrijk:

- `momentum` voor de directe komende 10-20 minuten;
- `patternWorstSafe` voor "deze keer kan hij harder zakken";
- `rateDecay` om vals alarm te dempen als de daling al afvlakt.

### Scenario output

Voor elk scenario opslaan:

```json
{
  "name": "momentum",
  "mmol10": 5.1,
  "mmol20": 4.5,
  "mmol30": 4.1,
  "min30": 4.1,
  "minutesTo45": 20,
  "minutesTo40": null,
  "weight": 0.35
}
```

Samenvatting:

```json
{
  "expectedMin30": 4.4,
  "worstCaseMin30": 3.9,
  "bestCaseMin30": 5.2,
  "uncertaintyWidth": 1.3,
  "probLt45_30m": 0.64,
  "probLt40_30m": 0.31,
  "scenarioAgreement": 0.58
}
```

### Onzekerheid berekenen

Gebruik meerdere bronnen voor onzekerheid:

- brede spreiding in vergelijkbare episodes;
- weinig vergelijkbare episodes;
- oude of ontbrekende CGM-data;
- snelle rate-wisseling;
- sensor-lag bij snelle daling;
- recente maaltijdrespons zonder genoeg historie;
- tegenstrijdige scenario's.

Voorstel:

```text
uncertainty =
  patternSpread
  + missingDataPenalty
  + rateVolatility
  + sensorLagRisk
  + mealUncertainty
  - feedbackConfidence
```

### Beslisregels met onzekerheid

Niet alleen gemiddelde risico gebruiken:

- als `worstCaseMin30 < 4.0`: minimaal `likely`;
- als `worstCaseMin30 < 4.5` en `uncertainty` hoog is: minimaal `watch`;
- als `probLt45_30m >= 0.60`: minimaal `likely`;
- als `probLt40_30m >= 0.40`: minimaal `likely`, bij snelle daling `urgent`;
- als scenario's sterk verdeeld zijn: toon `watch: patroon wisselend`.

Voorbeeld uitleg:

```text
Patroon is wisselend: 5 vergelijkbare episodes gingen laag, 3 bleven veilig.
Worst-case binnen 30 min komt onder 4.5, daarom watch/likely.
```

### Geen overzekerheid

De API mag dus niet alleen `risk` teruggeven, maar ook:

- `confidence`: hoe zeker de detector is over de classificatie;
- `uncertainty`: hoe breed de mogelijke uitkomsten zijn;
- `scenarioAgreement`: hoeveel scenario's dezelfde kant op wijzen;
- `worstCaseMin30`: laagste plausibele waarde binnen 30 minuten;
- `expectedMin30`: gemiddelde/verwachte minimumwaarde.

Hoge onzekerheid betekent niet automatisch urgent. Het betekent:

- bij veilige waarden: meer monitoren;
- bij snelle daling: eerder waarschuwen;
- bij near-hypo: minder dempen;
- bij oude data: voorzichtig zijn met conclusies.

## Detector V2 output

De live API moet genoeg informatie geven voor Grafana en Nightwatch/xDrip.

```json
{
  "modelVersion": "reactive-hypo-v2",
  "createdAt": "2026-06-01T12:00:00.000Z",
  "currentMmol": 5.6,
  "risk": "likely",
  "score": 6.8,
  "confidence": 0.74,
  "uncertainty": 0.46,
  "features": {
    "peakMmol120m": 10.1,
    "minutesSincePeak": 42,
    "dropFromPeakMmol": 4.5,
    "dropFromPeakPercent": 44.5,
    "rate5m": -0.06,
    "rate10m": -0.07,
    "rate15m": -0.05,
    "blendedRate": -0.063,
    "lagAdjustedMmol": 5.3
  },
  "predicted": {
    "mmol10": 5.0,
    "mmol20": 4.4,
    "mmol30": 4.0,
    "minutesTo45": 17,
    "minutesTo40": 25,
    "probLt45_20m": 0.67,
    "probLt40_30m": 0.52
  },
  "scenarios": {
    "expectedMin30": 4.4,
    "worstCaseMin30": 3.9,
    "bestCaseMin30": 5.2,
    "uncertaintyWidth": 1.3,
    "scenarioAgreement": 0.58,
    "items": [
      {
        "name": "momentum",
        "mmol10": 5.0,
        "mmol20": 4.4,
        "mmol30": 4.0,
        "min30": 4.0,
        "weight": 0.35
      },
      {
        "name": "rateDecay",
        "mmol10": 5.1,
        "mmol20": 4.8,
        "mmol30": 4.7,
        "min30": 4.7,
        "weight": 0.25
      },
      {
        "name": "patternWorstSafe",
        "mmol10": 4.9,
        "mmol20": 4.2,
        "mmol30": 3.9,
        "min30": 3.9,
        "weight": 0.25
      }
    ]
  },
  "pattern": {
    "similarEpisodeCount": 7,
    "similarHypoCount": 5,
    "similarHypoRatio": 0.71,
    "patternConfidence": 0.78
  },
  "reasons": [
    "Snelle post-piek daling",
    "Voorspeld onder 4.5 binnen 20 minuten",
    "Worst-case scenario komt onder 4.0 binnen 30 minuten",
    "Lijkt op 7 eerdere episodes; 5 gingen onder 4.5"
  ]
}
```

## Database-aanpassingen

### `prediction_snapshots`

Uitbreiden met:

- `modelVersion`.
- `confidence`.
- `features`.
- `predicted`.
- `pattern`.
- `riskComponents`.
- `reasons`.
- `outcomeEvaluated`.
- `actualOutcome`.
- `leadTimeMinutes`.
- `falsePositive`.

Belangrijk: de huidige code schrijft `riskDetails` wel in het snapshotobject,
maar zet het nog niet mee in de MongoDB `$set`. Dat moet worden hersteld.

### `reactive_hypo_episodes`

Nieuwe canonieke collection voor episode-analyse. Deze mag later de oudere
`pattern_events` en `episode_vectors` vervangen of voeden.

Indexen:

```text
{ start: 1 }
{ outcome: 1, peakMmol: 1 }
{ "featureVector.peakMmol": 1 }
{ "featureVector.dropFromPeakMmol": 1 }
```

### `hypo_feedback`

Nieuwe of bestaande feedback collection:

```json
{
  "createdAt": "2026-06-01T12:00:00.000Z",
  "entryIdentifier": "libre-...",
  "type": "feels_hypo",
  "mmol": 4.7,
  "note": "trillerig",
  "source": "manual"
}
```

## Live versus offline gelijk houden

Een belangrijke regel: live detectie en offline backtest moeten dezelfde
featurebuilder en detector gebruiken.

Aanpak:

- verplaats featurebouw naar `scripts/lib/hypo-features.mjs`;
- verplaats detector naar `scripts/lib/reactive-hypo-detector.mjs`;
- gebruik deze modules vanuit `libreview-nightscout-sync.mjs`;
- gebruik dezelfde modules vanuit `scripts/evaluate-hypo-detector.mjs`.

Dan voorkomen we dat Grafana mooi lijkt, maar de backtest iets anders meet.

## Backtest ontwerp

Het evaluatiescript moet oude data afspelen alsof het live was.

Input:

- Nightscout `entries`;
- feedback;
- bestaande episodes of automatisch gebouwde episodes.

Proces:

1. Sorteer alle entries op tijd.
2. Loop per meetpunt door de historie.
3. Bouw features met alleen data die op dat moment bekend was.
4. Draai detector V2.
5. Kijk 30/60/90 minuten vooruit voor echte outcome.
6. Sla resultaat op als evaluatieregel.

Output:

```json
{
  "periodStart": "2026-05-01T00:00:00.000Z",
  "periodEnd": "2026-06-01T00:00:00.000Z",
  "hypoCount": 12,
  "nearHypoCount": 23,
  "alerts": 31,
  "truePositive": 20,
  "falsePositive": 11,
  "missedHypo": 3,
  "medianLeadTimeMinutes": 16,
  "precision": 0.65,
  "recall": 0.87
}
```

Ook tonen:

- top 10 beste waarschuwingen;
- top 10 vals alarm;
- top 10 gemiste hypo's;
- voorbeelden met features en redenen.

### Uncertainty evalueren

De backtest moet ook meten of onzekerheid nuttig is.

Extra metrics:

- `worstCaseHitRate`: hoe vaak zat echte nadir onder of rond worst-case?
- `expectedCalibration`: klopt de gemiddelde voorspelde kans met echte uitkomst?
- `highUncertaintyMisses`: gemiste hypo's waarbij onzekerheid hoog was.
- `lowConfidenceAlerts`: alarmen waarbij confidence laag was.
- `scenarioDisagreementBeforeHypo`: hoe vaak scenario's verdeeld waren voor hypo.

Belangrijke vragen:

- had `worstCaseMin30` de gemiste hypo wel gezien?
- gaf onzekerheid te veel extra vals alarm?
- zijn snelle episodes vaker onzeker dan langzame episodes?
- moeten snelle post-piek episodes een hogere uncertainty-penalty krijgen?

Acceptatie:

- uncertainty mag `watch` vaker maken, maar niet onnodig veel `urgent`;
- gemiste snelle hypo's moeten dalen;
- uitleg moet duidelijk zeggen wanneer een alarm komt door worst-case/variabiliteit.

## Tuningstrategie

Niet meteen machine learning zwaar maken. Eerst gecontroleerd tunen.

### Fase A: veilige baseline

Doel:

- weinig gemiste hypo's;
- iets meer vals alarm accepteren.

Instelling:

- `watch` vroeg laten afgaan;
- `urgent` streng houden;
- duidelijke uitleg tonen.

### Fase B: persoonlijke tuning

Na minimaal 1-2 weken data:

- drempels aanpassen op jouw echte patronen;
- patternConfidence zwaarder laten wegen;
- vals alarm dempen op basis van veilige episodes.

### Fase C: feedback learning

Feedback laat detector leren:

- `confirmed_hypo`: vergelijkbare patronen zwaarder wegen.
- `false_alarm`: vergelijkbare patronen dempen.
- `feels_hypo`: near-hypo ook serieus nemen, zelfs als CGM nog net hoger staat.
- `fingerstick_confirmed`: hoogste betrouwbaarheid.

## Alarmfilosofie

Voor reactieve hypo is een waarschuwing nuttig als hij:

- vroeg genoeg is om actie te nemen;
- uitlegbaar is;
- niet continu schreeuwt;
- onderscheid maakt tussen "opletten" en "nu handelen".

Daarom:

- `watch`: rustig tonen in Grafana.
- `likely`: duidelijk tonen, eventueel Nightscout treatment/devicestatus.
- `urgent`: geschikt voor actief alarm via xDrip/Nightwatch/Nightscout.

## Nightwatch/xDrip/Nightscout integratie

Nachtwatch en xDrip lezen vooral Nightscout. Daarom moet V2 niet alleen in
Grafana bestaan.

Mogelijke routes:

- schrijf riskstatus naar Nightscout `devicestatus`;
- schrijf opvallende momenten als `treatments` met notitie;
- houd rauwe glucosemetingen onaangetast;
- gebruik duidelijke tekst zoals `Reactive hypo likely: predicted <4.5 in 17m`.

Voorzichtigheid:

- niet elke `watch` als treatment schrijven, dat vervuilt de timeline;
- alleen `likely` en `urgent` als event naar Nightscout sturen;
- rate limiting toepassen, bijvoorbeeld maximaal 1 event per 15 minuten per risiconiveau.

## Grafana ontwerpregels

Grafana moet helpen begrijpen, niet paniek zaaien.

Bovenaan:

- hoofdgrafiek glucose;
- trend/snelheid;
- reactieve hypo watch.

Daaronder tegels:

- actuele waarde;
- trendpijl;
- voorspelling +10/+20/+30;
- tijd tot 4.5;
- tijd tot 4.0;
- risk level;
- risk score;
- korte reden.

Onderaan rapportage:

- episodes per dag/week;
- near-hypo/hypo aantallen;
- gemiste waarschuwingen;
- vals alarm;
- persoonlijke patroonmatches.

## Randgevallen

De detector moet expliciet omgaan met:

- ontbrekende metingen;
- dubbele metingen;
- sensor start/einde;
- compressie-lows;
- snelle stijging na correctie/eten;
- datagat van meer dan 15 minuten;
- CGM-waarde die niet past bij klachten;
- handmatige fingerstick die afwijkt.

Regel:

- bij oude of ontbrekende data geen hard alarm maken;
- bij klachten/feedback altijd serieus labelen, ook als CGM nog niet laag is.

## Uitleg bij ieder alarm

Een waarschuwing moet altijd uitleggen waarom hij afgaat.

Voorbeelden:

- `Snelle post-piek daling: -0.07 mmol/L/min`
- `Voorspeld onder 4.5 binnen 14 minuten`
- `Komt overeen met 5 eerdere episodes, 4 daarvan gingen onder 4.5`
- `CGM-lag correctie: snelle daling kan echte glucose lager maken`

Dit moet zichtbaar zijn in:

- API `/prediction/latest`;
- Nightscout treatment/devicestatus indien handig;
- Grafana tegel "Waarom risico?";
- eventueel Nightwatch of xDrip via Nightscout-data.

## Data-validatie

We moeten meten of de detector echt beter wordt.

Per dag/week rapporteren:

- aantal echte hypo's `< 4.0`;
- aantal near-hypo's `< 4.5`;
- hoeveel waarschuwingen vooraf kwamen;
- gemiddelde waarschuwingstijd;
- vals alarm telling;
- gemiste hypo's;
- snelste daling;
- grootste piek-drop;
- tijd-in-range;
- tijd onder 4.5, 4.0 en 3.9.

Belangrijke metrics:

- `leadTimeMinutes`: hoeveel minuten voor de hypo kwam de waarschuwing?
- `falsePositiveRate`: hoeveel waarschuwingen werden geen hypo?
- `missedHypoCount`: hoeveel hypo's kwamen zonder waarschuwing?
- `precision`: hoeveel waarschuwingen waren terecht?
- `recall`: hoeveel echte hypo's werden gevonden?

## Grafana-uitbreiding

Nieuwe of verbeterde panelen:

- actuele risicostatus;
- reden van alarm;
- voorspelde glucose +10/+20/+30 minuten;
- tijd tot 4.5;
- tijd tot 4.0;
- hypo's per dag/week;
- near-hypo's per dag/week;
- gemiste waarschuwingen;
- vals alarm momenten;
- snelste post-piek dalingen;
- top 10 reactieve hypo patronen.

Belangrijk: de hoofdgrafieken moeten rustig blijven. Extra details horen onderaan.

## Implementatiestappen

### Stap 1: detector V2

Maak een nieuwe functie naast de bestaande regel:

```text
evaluateReactiveHypoRiskV2(input)
```

Output:

```json
{
  "risk": "low|watch|likely|urgent",
  "score": 0,
  "confidence": 0.0,
  "predicted": {
    "mmol10": 0,
    "mmol20": 0,
    "mmol30": 0,
    "minutesTo45": null,
    "minutesTo40": null,
    "lagAdjustedMmol": null
  },
  "features": {},
  "reasons": []
}
```

### Stap 2: feedback vastleggen

Gebruik feedbackknoppen of API endpoint:

- `feels_hypo`
- `confirmed_hypo`
- `false_alarm`
- `meal_related`
- `exercise_related`

### Stap 3: episode builder

Bouw automatisch episodes uit de historie:

- start bij piek of snelle daling;
- eindig als glucose stabiliseert;
- label outcome als `hypo`, `near_hypo`, `safe_drop`, `false_alarm`.

### Stap 4: evaluatie script

Maak een script:

```text
scripts/evaluate-hypo-detector.mjs
```

Het script moet oude data replayen en tonen:

- hoeveel waarschuwingen;
- hoeveel echte hypo's;
- hoeveel gemist;
- gemiddelde waarschuwingstijd;
- voorbeelden van goede/slechte detecties.

### Stap 5: Grafana rapportage

Schrijf extra meetvelden naar InfluxDB:

- `hypo_risk_score`
- `hypo_risk_level`
- `minutes_to_45`
- `minutes_to_40`
- `lag_adjusted_mmol`
- `reactive_drop_score`
- `pattern_match_score`

### Stap 6: tuning op jouw data

Gebruik 1-2 weken echte data om drempels te tunen:

- minder vals alarm als je stabiel hoog zit;
- eerder alarm als je na piek snel daalt;
- extra gevoeligheid bij bekende persoonlijke patronen.

## Concrete bouwvolgorde

Dit is de aanbevolen volgorde. Niet alles tegelijk bouwen; eerst zorgen dat elke
laag controleerbaar is.

### Mijlpaal 1: data opslaan zonder gedrag te veranderen

Doel: V1 blijft werken, maar snapshots worden rijker.

Taken:

- `riskDetails` echt opslaan in `prediction_snapshots`.
- `features` object toevoegen aan snapshots.
- `predicted` object naast oude `predictedMmol` toevoegen.
- `modelVersion` ophogen naar bijvoorbeeld `rules-v1.1`.
- `/prediction/latest` uitbreiden met features, predicted en pattern.

Acceptatie:

- Docker blijft syncen.
- `/prediction/latest` toont actuele waarde, score, reasons, features en voorspelling.
- Grafana hoeft nog niet aangepast.

### Mijlpaal 2: featurebuilder apart maken

Doel: live en backtest gebruiken exact dezelfde featurelogica.

Nieuwe bestanden:

```text
scripts/lib/hypo-features.mjs
scripts/lib/reactive-hypo-detector.mjs
```

Taken:

- verplaats rateberekening of maak herbruikbare helper;
- bouw `buildHypoFeatures(timeline, idx, options)`;
- bouw `evaluateReactiveHypoRiskV2(features, context)`;
- voeg unitachtige testdata toe als JSON fixtures.

Acceptatie:

- `node --check` slaagt;
- sync gebruikt nog steeds V1 of V1.1;
- losse detector kan met fixture-data draaien.

### Mijlpaal 3: episode builder

Doel: automatisch jouw historische reactieve hypo/drop episodes maken.

Nieuw script:

```text
scripts/build-reactive-hypo-episodes.mjs
```

Taken:

- entries uit MongoDB lezen;
- episodes detecteren;
- outcomes labelen;
- featureVector per episode opslaan;
- oude `pattern_events` en `episode_vectors` eventueel blijven gebruiken.

Acceptatie:

- script print aantal episodes per outcome;
- MongoDB bevat `reactive_hypo_episodes`;
- er zijn voorbeeldepisodes met piek, nadir, drop en outcome.

### Mijlpaal 4: backtest

Doel: bewijzen of V2 beter is dan V1.

Nieuw script:

```text
scripts/evaluate-hypo-detector.mjs
```

Taken:

- replay historie;
- V1 en V2 naast elkaar draaien;
- echte outcomes bepalen met lookahead;
- metrics printen;
- voorbeelden van gemiste hypo's en vals alarm tonen.

Acceptatie:

- output toont precision, recall, missedHypo, falsePositive en leadTime;
- minimaal V1 versus V2 vergelijking;
- geen live gedrag veranderd.

### Mijlpaal 5: V2 live aanzetten in shadow mode

Doel: V2 draait mee, maar stuurt nog geen alarms.

Taken:

- V1 blijft bepalend voor huidige `risk`;
- V2 wordt opgeslagen als `shadowRisk`;
- vergelijk V1 en V2 in snapshots;
- Grafana kan verschil tonen.

Acceptatie:

- sync blijft stabiel;
- geen extra Nightscout alarmen;
- na enkele dagen kunnen we verschillen beoordelen.

### Mijlpaal 6: V2 activeren

Doel: V2 wordt primaire risico-inschatting.

Taken:

- `risk` komt uit V2;
- V1 eventueel opslaan als `legacyRisk`;
- Nightscout events alleen voor `likely` en `urgent`;
- cooldown en anti-spam toepassen.

Acceptatie:

- waarschuwingen hebben duidelijke redenen;
- geen alarmspam;
- Grafana toont risico, score, confidence en waarom.

### Mijlpaal 7: tuning en feedback loop

Doel: detector persoonlijk maken.

Taken:

- feedback endpoint uitbreiden;
- feedback koppelen aan episodes;
- false alarms dempen;
- confirmed hypo patronen zwaarder wegen;
- wekelijks evaluatierapport maken.

Acceptatie:

- detector kan aantoonbaar leren van jouw feedback;
- backtest verbetert na tuning;
- rapportage toont effect van tuning.

## Verbeterd voorspellingsplan (2026-06-02)

Dit is het uitgebreide plan voor slimmere hypo-voorspelling op basis van jouw
echte patroon (198 episodes in de data: 71 hypo, 43 near\_hypo, 84 safe\_drop,
mediaan piek ~9-10 mmol, drop ~4-6 mmol, piek→nadir ~30-35 min) en wat xDrip,
OpenAPS en CGM-onderzoek laten zien.

### Wat xDrip doet en waarom het voor jou niet genoeg is

xDrip's predictive alert gebruikt één ding: **momentum** — de huidige rate
doorgetrokken als een rechte lijn. Dat is snel en transparant, maar mist:

- de piek-context (7.5 dalend ≠ 7.5 stabiel);
- versnelling (dalingssnelheid neemt toe);
- jouw persoonlijke patroon (bij jou gaat 71% van de hypo-episodes van piek
  naar nadir in 30-40 min, dat is sneller dan xDrip's lineaire projectie verwacht);
- het verschil tussen een veilige terugval en een reactieve hypo.

xDrip's AR2 forecast (autoregressive van de tweede orde) gebruikt de laatste
twee BG-waarden om een parabool te schatten. Dat is beter dan een rechte lijn,
maar overschat het herstel als je op een snelle post-piek daling zit.

### De kern van jouw patroon

Op basis van de episode-data:

1. **Trigger is altijd een piek ≥ 7.5 mmol**: onder die drempel geen reactieve hypo.
2. **De kritieke fase is 15-45 min na de piek**: in 67% van de gevallen bereik je
   de nadir binnen 45 minuten na de piek.
3. **Dalingssnelheid is de sterkste voorspeller**: rate10m ≤ -0.05 mmol/min na
   een piek ≥ 7.5 is bijna altijd gevaarlijk.
4. **Drop ≥ 25% van de piek** onderscheidt reactieve hypo van veilige terugval.
5. **Nacht verschilt van dag**: compressie-lows, sensorlag en geen maaltijden
   vragen een andere gevoeligheid.

### Verbeteringen: 9 concrete lagen

#### Laag 1 — Nadir-voorspelling in plaats van lineaire extrapolatie

Nu: rate × tijd = voorspelde glucose (rechte lijn).
Beter: een **curve-fit op de descent** die laat zien waar de daling afvlakt.

Bijna alle reactieve hypo's volgen een sigmoidale curve: snel naar beneden,
dan afvlakking/herstel. De nadir is niet aan het einde van de rechte lijn maar
in de buik van de S. Bereken per episode:

```
nadirEstimate = peakMmol - medianDropInSimilarEpisodes * dropProgressFactor
```

waarbij `dropProgressFactor` afhankelijk is van hoe ver langs de curve je
al bent (`minutesSincePeak / typicalNadirMinutes`).

Implementeer als extra scenario in `reactive-hypo-detector.mjs`:
`patternNadir` — een percentiel-gebaseerde nadir-schatting uit de top-N
vergelijkbare episodes.

#### Laag 2 — Versnellingsdetectie (rate-of-rate)

Nu: `isAcceleratingDown` = rate5m < rate10m - 0.005.
Beter: een expliciete **dalingsversnelling** (mmol/min²) die aangeeft of
de daling toeneemt of afzwakt:

```
acceleration = (rate5m - rate15m) / 10   # mmol/min per min
```

Positief = versnellende daling (extra gevaarlijk). Negatief = daling vlakt af
(herstelindicatie, demping rechtvaardigd).

In `hypo-features.mjs` toevoegen: `acceleration`, `isDecelerating`.
In de detector: bij `acceleration < -0.005` extra score; bij `isDecelerating`
de worst-case override dempen.

#### Laag 3 — Post-piek fase met curvevorm

Nu: één `postPeakWindow` (early/middle/late).
Beter: een **curvevorm-score** die aangeeft hoe jouw huidige curve lijkt op
historische descents. Gebruik de resample-logica die al in `episode-builder.mjs`
zit (genormaliseerde curve van 24 punten), maar dan live:

- Neem de laatste 45 minuten glucose.
- Resample naar 12 punten.
- Vergelijk met de top-N episodes uit `reactive_hypo_episodes`.
- Score = gewogen fractie van vergelijkbare episodes die hypo werden.

Dit is sterker dan de huidige `findSimilarEpisodes` omdat de hele curvevorm
meewegt, niet alleen piek/drop/timing.

Implementeer als `curveMatchScore` in `hypo-features.mjs` (lazy — alleen
berekend als er een daling is) en als `curvePatternScore` in de detector.

#### Laag 4 — Dagdeel-context (nacht/ochtend/middag/avond)

Jouw nacht-hypo's (compressie, sensorruis) gedragen zich anders dan post-lunch
hypo's. Voeg een `timeOfDay` feature toe:

```
'nacht'   = 00:00-06:00
'ochtend' = 06:00-10:00
'middag'  = 10:00-15:00
'middag2' = 15:00-19:00
'avond'   = 19:00-00:00
```

In de detector: bij `nacht` de worst-case override dempen (minder agressief),
bij `middag`/`middag2` (post-lunch) de reactieve-context score verhogen.
Leert vanzelf via de tuner zodra er genoeg per-dagdeel data is.

#### Laag 5 — Weekdag-patroon gebruiken

De patroon-rapportage (`hypo-patterns.mjs`) laat al zien welke weekdagen
riskanter zijn. Dit terugkoppelen aan de detector:

- Lees `latest.weekday.json` bij startup van de sync.
- Voeg `weekdayRisk` feature toe: hoog als de huidige weekdag historisch
  riskanter was (≥ 1.5× het gemiddelde aantal hypo's per dag).
- Kleine bonusscore in de detector als `weekdayRisk` hoog is.

#### Laag 6 — Hersteldetectie (niet alleen "daalt")

Nu mist de detector wanneer een daling stopt. Voeg toe:

```
recoverySignal = rate5m > 0 AND rate10m < 0   # draai vlak na daling
isBottoming    = |rate5m| < 0.01              # haast stilgevallen
```

Bij `isBottoming` of `recoverySignal` de worst-case scenario's dempen en
een `watch` niet upgraden naar `likely`. Dit vermindert de vals-alarm-golf
die op dit moment de precision drukt.

#### Laag 7 — Sensorlag-correctie verfijnen

Nu: `lagAdjustedMmol = currentMmol + blendedRate × 5`.
Beter: bij bewezen snelle daling (rate10m ≤ -0.07) **meer** lag aannemen
(6-7 min), bij langzame daling minder (3-4 min), bij stijging 0:

```
effectiveLag = rate10m <= -0.07 ? 7
             : rate10m <= -0.04 ? 5
             : rate10m <= 0     ? 3
             : 0
lagAdjustedMmol = currentMmol + blendedRate × effectiveLag
```

Dit refineert de CGM-lag-correctie die al in `hypo-features.mjs` zit.

#### Laag 8 — Vroege maaltijdreactie (meal-onset detector) — **GEBOUWD**

> **Status: af.** `hypo-features.mjs` levert nu `mealOnset` / `riseFromTroughMmol` /
> `minutesSinceTrough`; `reactive-hypo-detector.mjs` heeft component 8 die als
> **risk-floor** een lage `watch` zet zodra een maaltijdpiek begint (curve-conditie,
> zie hieronder). Bewust géén score-bijdrage: meal-onset kan nooit zelf tot een alarm
> (`likely`/`urgent`) leiden — dat blijft voorbehouden aan de dalende fase, en `watch`
> zit niet in de V2-alarmset. Regressie: `scripts/fixtures/meal-onset-rising.json`.
> De historische conditie ("≥ 40% van vergelijkbare stijgingen → reactieve hypo")
> is nog niet meegenomen; dat vergt rise-similarity (nu alleen drop-context-vectors)
> en is een latere verfijning.

De sterkste voorspelling is niet "er daalt iets" maar "er is een piek
begonnen die op een reactieve hypo-curve lijkt". Voeg toe aan
`hypo-features.mjs`:

```
mealOnsetScore:  stijging ≥ 0.8 mmol in laatste 15 min
                 + lokale bodem ≥ 15 min geleden
                 = maaltijdrespons is begonnen
```

Dan al in de stijgende fase een lage `watch` geven als:
- stijging snel genoeg (rate10m ≥ 0.04)
- piek al ≥ 7.5
- historisch: ≥ 40% van vergelijkbare stijgingen eindigde in reactieve hypo

Dit geeft je 10-15 min extra voorlooptijd ten opzichte van nu (nu begint de
detector pas te reageren als de daling begonnen is).

#### Laag 9 — Input-cleaning: single-point spike-filter vóór de rate-berekening — **GEBOUWD**

> **Status: af.** `hypo-features.mjs` levert nu `cleanGlucoseTimeline` /
> `isSinglePointSpike` met een median-of-3 filter (`SPIKE_FILTER_THRESHOLD_MGDL=8`).
> De live sync gebruikt dezelfde werk-timeline voor `calculateRates`,
> `calcRateFromTimeline` en `buildHypoFeatures`; ruwe `entries.sgv` blijft ongemoeid.
> Regressie: `npm run spike-filter:check`.

Alle lagen hierboven nemen schone invoer aan. Maar de ruwe LibreLink-stream bevat
**single-point artefacten** die de korte rates laten ontploffen. Gemeten op live data:

```
22:04:36   172 → 154   (−18 mg/dL in 1 min)
22:05:36   154 → 172   (+18 mg/dL in 1 min)
```

Eén losse meting (154) tussen twee correcte waarden (172) — fysiologisch onmogelijk
om in 1 min ~1 mmol/L te dalen en in de minuut erna exact terug te veren. Dat ene
punt levert al een `rate1m` van ±0.98 mmol/L/min op. Slechts ~5 van de 239 sprongen
waren ≥ 8 mg/dL, maar die paar punten domineren de spreiding (1m sd 0.17 vs
kwantisatie-vloer 0.055). Onbehandeld kan zo'n dropout een vals alarm of een valse
`isAcceleratingDown` triggeren.

**Filter (historische punten — niet-causaal, buren bestaan):**

```
Voor punt p met buur-voor a en buur-na c, alle ~1 min uit elkaar:
  med     = median(a, p, c)
  isSpike = |p - med| > SPIKE_THRESHOLD_MGDL (≈ 8 mg/dL)
            EN |a - c| < SPIKE_THRESHOLD_MGDL          # buren zijn het eens
  → p telt niet mee als baseline/eindpunt voor rates/features;
    gebruik in de werk-timeline med (of lineaire interpolatie a→c) i.p.v. p.
```

**Filter (huidige punt — causaal, geen toekomst):** voor de laatste meting bestaat
nog geen buur-na. Regel "bevestigen vóór vertrouwen": als de nieuwste waarde een
verdachte sprong is t.o.v. het recente niveau (`|p − baseline| > SPIKE_THRESHOLD`)
terwijl de rate dáárvoor vlak was, **upgrade dan niet** naar een nieuw/zwaarder alarm
en zet `isAcceleratingDown` niet op één stap; wacht de volgende reading (≈ 1 min) af
die het bevestigt of verwerpt. Zo reageren we niet op een dropout én missen we geen
echte snelle daling (die blijft de minuut erna staan).

**Hard principe:** nooit `entries.sgv` overschrijven — de ruwe meting blijft de bron
van waarheid. Het filter werkt alleen op de **werk-timeline** die rates en features
voedt. In live zijn dat minimaal drie paden:

- `addRateFields` / `calculateRates` in `libreview-nightscout-sync.mjs`
  (`glucoseRateMmolPerMin`, overlay/Influx/diagnostiek, incl. `rate1m`);
- `calcRateFromTimeline` in `libreview-nightscout-sync.mjs` (V1/snapshot-forecast);
- `buildHypoFeatures` / `calcRate` in `hypo-features.mjs` (V2 live, backtest en tuner).

De filter moet dus vóór al deze rate-berekeningen op dezelfde werk-timeline worden
toegepast; anders kan de overlay schoner/vuiler zijn dan V1/V2.

**Train/serve-pariteit (verplicht):** exact hetzelfde filter, dezelfde drempel en
dezelfde median-logica moeten live, backtest en tuner gebruiken. Praktisch betekent
dit: één gedeelde Node/ESM-helper voor de live sync en `hypo-features.mjs`. Legacy
Mongo-shell backfill-scripts kunnen die ESM-helper niet direct importeren; voor echte
backfill-pariteit zijn er twee veilige opties:

1. backfill naar Node migreren en dezelfde helper gebruiken; of
2. legacy backfill ongemoeid laten en Laag 9 expliciet beperken tot live snapshots +
   V2 backtest/tuner, totdat die scripts gemigreerd zijn.

Geen derde, afwijkende median-implementatie in Mongo-shell kopiëren tenzij er een
regressietest is die live/offline/backfill exact vergelijkt.

**Acceptatie:** het artefact 172→154→172 produceert na filtering geen `|rate1m| > 0.5`
in de algemene rate-output, veroorzaakt geen valse `rate5m`/`rate10m`-drop, trekt
`maxFallRate30m` niet kunstmatig omlaag en flipt `isAcceleratingDown` niet. De V2
fixtures en backtest blijven op recall gelijk en precision gelijk of beter (we
verwachten minder vals alarm, geen extra gemiste hypo's).

#### Laag 10 — Data-quality gate vóór V1 en V2 — **GEBOUWD**

> **Status: af.** `hypo-features.mjs` levert nu `features.dataQuality` via
> `assessTimelineQuality`. De live sync geeft dezelfde quality-info aan V1 en V2.
> Actuele lage glucose blijft altijd leidend; alleen rate-/forecast-/context-escalatie
> wordt conservatiever als de data `watch` of `degraded` is. Regressie:
> `npm run data-quality:check`.

De gate kijkt naar de kwaliteit van de recente tijdreeks, niet naar de medische
betekenis van de waarde zelf. Flags:

- `stale`: laatste LibreView-meting is ouder dan de ingestelde grens;
- `largeGap`: groot gat in recente timestamps;
- `duplicateTimestamp`: twee meetpunten met exact dezelfde timestamp;
- `outOfOrder`: timestamps lopen niet strikt op;
- `sparseRecentData`: te weinig punten over een langere recente span;
- `futureTimestamp`: timestamp ligt duidelijk in de toekomst.

De output bevat `level` (`good`/`watch`/`degraded`), `score`, `reasons`,
`recentCount`, `recentSpanMinutes`, `largestGapSeconds`, `medianIntervalSeconds`,
`expectedIntervalSeconds` en `ageSeconds`.

**Gedrag:** V1 en V2 mogen bij slechte datakwaliteit nog steeds waarschuwen, maar
geen harde escalatie baseren op alleen een twijfelachtige rate of context. Een
actuele waarde onder 4.5/4.0 mmol/L wordt niet weggedempt door deze gate.

### Bouwen in deze volgorde

| Stap | Onderdeel | Impact | Werk | Status |
|---|---|---|---|---|
| 1 | `acceleration` + `isDecelerating` in features | dempt vals alarm | klein | ✅ af |
| 2 | `recoverySignal` + `isBottoming` → demping | dempt vals alarm | klein | ✅ af |
| 3 | Nadir-schatting via vergelijkbare episodes | preciezere worst-case | middel | ✅ af |
| 4 | `timeOfDay` context in features + detector | nacht/dagdeel-bewust | klein | ✅ af |
| 5 | Curvegemiddelde-vergelijking (curvevorm-score) | sterkste signaal | groot | ✅ af |
| 6 | Variabele sensorlag | realistischer CGM-lag | klein | ✅ af |
| 7 | Weekdag-patroon terugkoppelen | patroon-bewust | middel | ✅ af |
| 8 | Meal-onset vroege detector | 10-15 min eerder | groot | ✅ af |
| 9 | Spike-filter op ruwe glucose (input-cleaning) | dempt vals alarm + ruis | klein | ✅ af |
| 10 | Data-quality gate voor V1 + V2 | dempt escalatie bij rommelige timestamps | klein | ✅ af |

Stap 1-2 en 6 zijn kleine wijzigingen in `hypo-features.mjs` en de detector,
geen database-werk. Stap 3 en 5 vereisen curve-vergelijking live; bouwen na
stap 1-2 zodat de precision al omhoog is. Stap 9 is foundationeel — alle andere
lagen nemen schone invoer aan. Stap 10 beschermt V1 en V2 tegen rommelige
LibreView-timestamps zonder echte lage waarden te onderdrukken.

### Acceptatiecriterium

De verbeterde detector is beter als de backtest laat zien:
- precision ≥ V1 op out-of-sample data (vals alarm niet erger);
- recall ≥ V1 (geen extra gemiste hypo's);
- mediane lead-time ≥ 20 min (nu V2 default: ~20 min; V1: ~13 min);
- bij nacht-uren: precision strenger (minder nacht-vals-alarm).

### Relatie tot xDrip/Nightscout

Na verbetering:
- Schrijf `likely` en `urgent` als Nightscout `devicestatus` zodat xDrip/
  Nightwatch ze via de Nightscout API kan ophalen.
- xDrip's eigen predictive alert blijft staan als tweede, onafhankelijk
  vangnet — nooit uitzetten.
- De overlay-kaart toont V1 en V2 als twee regels naast elkaar (`niveau · score`,
  bij V2 ook `confidence %`), met de redenen per model in de hover-tooltip, zodat je
  altijd ziet wat beide modellen vinden en waaróm.

## Configuratievoorstel

Maak drempels configureerbaar, maar houd defaults veilig.

```text
HYPO_NEAR_MMOL=4.5
HYPO_LOW_MMOL=4.0
HYPO_SEVERE_MMOL=3.0
HYPO_FAST_FALL_RATE=-0.05
HYPO_VERY_FAST_FALL_RATE=-0.08
HYPO_EXTREME_FALL_RATE=-0.10
HYPO_LOOKAHEAD_MINUTES=30
HYPO_FAST_PATTERN_PEAK_WINDOW_MINUTES=45
HYPO_FAST_PATTERN_MIN_PEAK_MMOL=7.5
HYPO_FAST_PATTERN_STRONG_PEAK_MMOL=8.5
HYPO_FAST_PATTERN_DROP_MIN_MMOL=1.0
HYPO_FAST_PATTERN_RATE10=-0.05
HYPO_FAST_PATTERN_RATE5=-0.08
HYPO_EARLY_WARN_MINUTES_TO_45=20
HYPO_URGENT_MINUTES_TO_40=15
HYPO_FAST_MEAL_WINDOW_MINUTES=90
HYPO_DELAYED_MEAL_WINDOW_MINUTES=300
HYPO_PATTERN_MIN_MATCHES=5
HYPO_NIGHTSCOUT_EVENT_MIN_RISK=likely
HYPO_EVENT_COOLDOWN_MINUTES=15
HYPO_CGM_LAG_MINUTES=5
```

## Open vragen voor later

Deze hoeven de eerste implementatie niet te blokkeren:

- Wil je `watch` alleen in Grafana zien of ook in Nightwatch?
- Wil je een handmatige knop voor `feels_hypo` in een simpele webpagina?
- Wil je maaltijdmomenten handmatig invullen?
- Wil je vingerprikmetingen als correctiebron opslaan?
- Moet nacht/slaap gevoeliger of juist rustiger zijn?

## Acceptatiecriteria

De detector is pas "goed" als hij dit kan:

- hypo's onder 4.0 meestal 10-20 minuten vooraf signaleren;
- near-hypo's onder 4.5 vroeg markeren zonder paniek;
- snelle post-piek dalingen binnen 0-45 minuten herkennen;
- snelle patronen niet wegdempen omdat algemene literatuur langere vensters noemt;
- hypers en hypo's als hetzelfde maaltijd-event kunnen koppelen;
- automatisch maaltijdachtige patronen vinden zonder verplichte invoer;
- duidelijke reden geven per waarschuwing;
- minder vals alarm bij normale dalingen;
- historische rapportage geven;
- handmatig feedback verwerken;
- na tuning aantoonbaar beter zijn dan alleen de actuele glucosewaarde.

## Korte conclusie

De huidige detectie is een goede V1. Voor reactieve hypoglykemie willen we naar
een V2 die curvevorm, dalingssnelheid, CGM-lag, persoonlijke patronen en feedback
combineert. Daarmee wordt het systeem niet alleen een dashboard, maar een vroege
waarschuwingslaag bovenop Libre/xDrip/Nightscout.
