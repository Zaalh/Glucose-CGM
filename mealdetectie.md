# Maaltijddetectie

## Doel

De maaltijd-detector herkent vroege maaltijdrespons en de latere reactieve daling op basis van CGM-data. Het doel is niet om een maaltijd klinisch te bewijzen, maar om bruikbare context te geven voor postprandiale hypo-risico's.

De detector bepaalt een `phase`:

- `dip`: tentatieve pre-dip voor een mogelijke maaltijd.
- `rising`: bevestigde stijging vanaf een lokale bodem.
- `plateau`: maaltijdrespons blijft hoog/vlak na eerdere stijging.
- `reactive-drop`: daling na een recente maaltijdpiek.

## Huidige implementatie

Live draait de detector in `nightscout-overlay/rate-overlay.js`. Voor offline tests staat dezelfde kernlogica in `scripts/lib/meal-detector.mjs`.

Omdat de overlay nu een klassiek browser-script is, wordt de shared module nog niet direct geimporteerd. Daarom bestaat er een parity-check:

```sh
npm run meal:parity
```

Die controleert dat overlay en shared module gelijk blijven. Naast snelle substring-canaries op
de kritieke gates draait de check een **gedragspariteit**: de overlay-functies worden uit de broncode
gesneden en in een sandbox naast de shared module gedraaid via sliding replay (minuut-voor-minuut,
episode-geheugen meegedragen) — inclusief de risico-scoring. Drift in een drempel of in de
episode-boekhouding laat de check falen.

## Detectielogica

### Rising

De detector zoekt een lokale bodem in de laatste 60 minuten en meet de stijging vanaf die bodem.

Een stijging telt pas als `rising` wanneer:

- de glucose stijgt ten opzichte van de bodem;
- de stijging groot genoeg is;
- er minimaal twee meetpunten duidelijk boven de bodem liggen (`sustainedRisePoints >= 2`);
- de stijging niet alleen een laatste sensor-spike of trage drift lijkt.

De belangrijkste gates:

- `fastGate`: snelle stijging met recente rate en bevestigde sustained rise.
- `medium`: middelgrote stijging, bevestigd en niet te traag.
- `slow`: grote langzame stijging, bevestigd door meerdere meetpunten.

### Dip

`dip` is een zwak/tentatief signaal. Het wordt alleen gebruikt wanneer er een recente bodem is, het niveau 20-35 minuten daarvoor duidelijk hoger lag, en er nog geen echte rising-status is.

### Reactive-drop

`reactive-drop` vereist:

- een recente piek binnen het postprandiale venster;
- een eerdere bodem voor die piek;
- voldoende stijging naar de piek;
- voldoende daling vanaf de piek;
- actieve daling of geen betrouwbare 10-minuten baseline.

Dit voorkomt dat een losse correctie-daling zonder voorafgaande maaltijdpiek als maaltijd wordt gelabeld.

### Episode memory

De overlay bewaart een maaltijd-episode in `localStorage`. Daardoor kan de detector een `plateau` of `reactive-drop` blijven herkennen wanneer de huidige readings niet meer de volledige pre-peak context bevatten.

## Kalibratie

De overlay leert per browser uit historische CGM-data:

- stijgsnelheden;
- typische rise;
- pre-dip;
- piek-naar-nadir tijd;
- drop-rates;
- typische drop.

Zolang er te weinig samples zijn, gebruikt de detector generieke defaults.

## Vectorlaag

Er is een offline vectorlaag toegevoegd in `scripts/lib/episode-similarity.mjs`:

```js
mealPatternFromState(meal, vectors)
```

Deze functie gebruikt bestaande `episode_vectors` als extra risicosignaal voor een al gedetecteerde maaltijdstatus.

Belangrijk:

- De vectorlaag bepaalt geen `phase`.
- `reactive-drop` mag via vectors `patternRisk: high` krijgen.
- `rising` is bewust zwakker en wordt maximaal `watch`.
- `dip` gebruikt geen vectors.

De output bevat onder andere:

- `similarEpisodeCount`
- `similarHypoCount`
- `similarHypoRatio`
- `weightedDrop`
- `patternRisk`
- `patternKind`

De overlay gebruikt deze vectorlaag nog niet live, omdat de browser geen directe toegang heeft tot Mongo `episode_vectors`.

## Risico-escalatie (niveau-gate)

De `phase` zegt *wat* er gebeurt; `scoreReactiveMealRisk` bepaalt *hoe alarmerend* het maaltijd-vak wordt
(`low` / `watch` / `high` / `urgent`). Voor een `reactive-drop` stuurt dit niet op de kale daalsnelheid maar
op de **verwachte bodem**:

```js
projectReactiveNadir(meal, cal) // = currentMmol - max(0, (typicalDrop + undershoot) - dropFromPeak)
```

De verwachte bodem wordt vergeleken met universele klinische drempels uit `MEAL_DEFAULTS`
(configureerbaar, zodat het systeem voor iedereen bruikbaar is):

- `watchMmol` 4.5
- `alertMmol` 3.9 (Level-1 hypo-alert)
- `seriousMmol` 3.0 (klinisch significant)

Gevolg: een daling die ruim boven 3.9 bodemt (bijv. normale postprandiale klaring 11 → 9) blijft `low` en
escaleert niet; een daling die richting < 3.9 of < 3.0 projecteert wordt `high` / `urgent`. Een snelle val
geeft een kleine extra (adrenerge symptomen kunnen ook boven 3.9 optreden), maar snelheid zonder niveau
escaleert niet meer. De grootte van de val zelf komt uit de per-browser zelf-kalibratie
(`typicalDrop` / `undershoot`).

De badge-basiskleur van een `reactive-drop` volgt dit risico-niveau: rustig grijs (`low`), amber (`watch`)
en rood (`high` / `urgent`) — rood blijft dus voorbehouden aan een daling die werkelijk de hypo-zone in
projecteert.

## Tests

Maaltijd-fixtures staan in:

```text
scripts/meal-fixtures/
```

De suite dekt onder andere:

- rising;
- reactive-drop;
- reactive-drop vanuit episode memory;
- dip;
- ontbrekende 10-minuten baseline;
- correctie-daling zonder maaltijd;
- oude piek buiten venster;
- sensor-spike;
- langzame drift;
- stabiel hoog;
- kleine ruisstijging.

De risico-escalatie heeft een eigen check (`scripts/run-meal-risk-check.mjs`) die de niveau-gate dekt:
verwachte-bodem-berekening, benigne hoge daling → `low`, en dalingen die richting < 4.5 / < 3.9 / < 3.0
projecteren → `watch` / `high` / `urgent`, plus configureerbaarheid van de drempels.

Draaien:

```sh
npm run meal:fixtures
npm run meal:vectors
npm run meal:risk
npm run meal:parity
npm run meal:check
```

`meal:check` is de hoofdcheck en draait syntax, fixtures, vectorcheck, risico-check en parity.

## Deploy-notitie

De live overlay wordt door nginx uit `nightscout-overlay/rate-overlay.js` geserveerd via een bind mount in de
`nightscout-ui` container. Na een wijziging aan dit bestand is alleen `docker compose up -d nightscout-ui`
niet altijd genoeg: Docker kan de bestaande container laten staan, waardoor nginx nog het oude overlay-bestand ziet.

Gebruik daarom bij overlay-wijzigingen:

```sh
docker compose -f docker-compose.nightscout.yml up -d --force-recreate nightscout-ui
```

Controleer daarna op de host:

```sh
wc -c nightscout-overlay/rate-overlay.js
docker compose -f docker-compose.nightscout.yml exec -T nightscout-ui \
  sh -lc 'wc -c /etc/nginx/overlay/rate-overlay.js'
curl -s 'http://localhost:1337/_rate-overlay.js?v=volatility-impact-20260614j' | wc -c
```

De byte-counts moeten overeenkomen. Als de browser geen overlay toont maar de logs wel `GET /_rate-overlay.js`
met `200` tonen, controleer eerst deze byte-counts en force-recreate de `nightscout-ui` container.

## Bekende beperkingen

- De live overlay en `scripts/lib/meal-detector.mjs` bevatten nog dubbele kernlogica.
- De huidige fixtures zijn synthetisch; echte live episodes moeten nog worden toegevoegd.
- `MEAL_BADGE_ALWAYS_VISIBLE` kan tijdelijk aan staan voor UI-positionering. Dan blijft het vak zichtbaar met
  `Geen maaltijd` wanneer er geen echte detectie is. Die idle-weergave gebruikt echte CGM-context: huidige waarde,
  trend/rate, aantal recente punten, leeftijd van de laatste meting, 60m bereik en de belangrijkste blocker.
  Die blocker wordt afgeleid uit dezelfde getrapte rising-poort als `detectMealState` (`mealGateReason()`): bij een
  daling `daling — geen reactieve drop`, anders `nog geen stijging`, `geen sustained rise`, of de dichtstbijzijnde
  poort met de ontbrekende voorwaarde (`mist: ≥0.5 mmol + ≥5m`, `mist: meer momentum`, …); `te weinig recente punten`
  overschrijft alles. Echte `dip`/`rising`/`plateau`/`reactive-drop` statussen blijven leidend.
- Vectorinformatie is nu offline beschikbaar, maar nog niet live in de overlay gekoppeld.
- CGM-data heeft sensorlag, ruis en mogelijke compressie-artefacten; de detector moet daarom als heuristiek worden gezien.

## Plan

1. Houd `npm run meal:check` groen bij elke wijziging.
2. Zet `MEAL_BADGE_ALWAYS_VISIBLE` uit zodra de badge-positionering klaar is.
3. Exporteer echte live episodes als fixtures:
   - echte maaltijd-rising;
   - reactive-drop na maaltijd;
   - false positive uit live gebruik;
   - correctie-daling zonder maaltijd;
   - sensor-spike;
   - langzame drift.
4. Gebruik `mealPatternFromState()` eerst in backtest/sync-context.
5. Publiceer eventueel samengevatte vector-output naar de overlay, bijvoorbeeld als extra veld bij risk/prediction data.
6. Laat `scoreReactiveMealRisk()` vector-patterns gebruiken als scorebijsturing, niet als phase-beslissing.
7. Vervang uiteindelijk dubbele overlay/shared logica door een build- of injectiestap, zodat `scripts/lib/meal-detector.mjs` echt de enige bron wordt.
