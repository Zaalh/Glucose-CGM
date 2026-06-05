# Glucose CGM Guide

## Project

Glucose CGM is een lokale, self-hosted glucosemonitor. De UI is de Nightscout-webinterface met een eigen nginx-overlay; Nightscout is de API-laag en MongoDB de opslag voor CGM-metingen.

Belangrijkste doel:

- LibreView/LibreLink data elke minuut ophalen.
- Elke beschikbare meting opslaan in Nightscout/MongoDB.
- Analyse, grafieken, alarmen en voorspelling baseren op Nightscout/MongoDB.

## Stack

- UI: Nightscout-webinterface + geïnjecteerde nginx-overlay (`nightscout-overlay/rate-overlay.js`).
- CGM opslag: MongoDB via Nightscout.
- Optioneel tijdreeks-archief: InfluxDB 1.8 voor xDrip/Grafana.
- CGM API/UI backend: `nightscout/cgm-remote-monitor`.
- Lokale Libre sync: `scripts/libreview-nightscout-sync.mjs`.
- Predictie: offline Node-scripts in `scripts/`.
- Docker services: `nightscout-mongo`, `nightscout`, `libreview-sync`, `nightscout-ui` (nginx), optioneel `influxdb`.

De oude React/Vite-frontend (`src/`) en de Supabase-laag (`supabase/`) zijn verwijderd; bouw nieuwe features op de Nightscout/MongoDB-flow.

## Commands

```bash
npm run nightscout:up
```

Start Nightscout en MongoDB.

```bash
npm run nightscout:libre
```

Start Nightscout, MongoDB en de LibreView sync-service.

```bash
npm run nightscout:logs
```

Toont Nightscout logs.

```bash
npm run libre:logs
```

Toont LibreView sync logs.

```bash
npm run influxdb:up
npm run influxdb:logs
npm run influxdb:down
npm run grafana:up
```

Start, toont logs of stopt de optionele InfluxDB-service, of start Grafana voor xDrip-dashboarding.

```bash
curl http://localhost:8787/health
```

Controleert of de lokale LibreView sync-service draait en geconfigureerd is.

```bash
curl -X POST http://localhost:8787/sync
```

Start handmatig dezelfde sync die de overlay periodiek aanroept.

```bash
npm run nightscout:down
```

Stopt de Docker services.

```bash
npm run model:retrain
npm run model:retrain:balanced
npm run model:retrain:precision
```

Trained het persoonlijke risicomodel op `prediction_snapshots` en exporteert actieve thresholds naar `scripts/risk-model-state.json`.

```bash
npm run summaries:build
```

Bouwt of ververst `daily_summaries` op basis van `entries`, `pattern_events` en geëvalueerde snapshots.

```bash
npm run episodes:build
npm run hypo:backtest
npm run hypo:tune
```

Reactieve-hypo detector V2 (`hypo.md`): bouwt `reactive_hypo_episodes`, draait de V1-vs-V2 backtest (precision/recall/lead-time), en auto-tunet de V2-parameters met een temporele train/test-split naar `scripts/reactive-hypo-v2-state.json`. Draaien in het Docker-netwerk (Mongo bereikbaar).

```bash
npm run detector:fixtures
npm run episodes:check
```

Lokale sanity-checks zonder database: de V2-detector op fixtures en de episode-builder op een synthetische timeline (`node --check`-vriendelijk).

```bash
npm run hypo:report -- --days 1      # dagrapport
npm run hypo:report -- --days 7      # weekrapport
npm run hypo:report -- --by-weekday  # per-weekdag profiel (28 dagen)
npm run hypo:patterns -- --days 28   # uur-van-de-dag + weekdag + episode-patronen
```

Rapporten over je eigen data: (near-)hypo's, time-in-range, snelste daling, V1 vs V2, en de riskantste uren/weekdagen.

### Automatisch leren (dagelijks)

`scripts/daily-hypo-tune.sh` draait via launchd (`deploy/com.glucosecgm.hypotune.plist`, dagelijks 04:30 op de iMac): episodes verversen → auto-tunen op je eigen episodes → dag/week/weekdag/patroon-rapporten in `hypo-tune-reports/`. De sync laadt de geleerde params (`scripts/reactive-hypo-v2-state.json`) en past ze toe op de V2 shadow.

Installeren:

```bash
cp deploy/com.glucosecgm.hypotune.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.glucosecgm.hypotune.plist
```

**Auto-activatie (M6, kwaliteitsgate):** de tuner zet V2 alleen automatisch live als er genoeg events zijn én V2 op out-of-sample data niet slechter is dan V1 (recall en precision). Dan komt `risk` uit V2 (`likely`→`high`) en wordt V1 als `legacyRisk` bewaard. Tot dan blijft V1 (`rules-v1.1`) de alarmbron. Welk model live is, zie je in `/prediction/latest` (`modelVersion`).

## Environment Files

### `.env.nightscout`

Lokale Nightscout configuratie. Dit bestand wordt niet gecommit.

```env
API_SECRET=change-me-local-nightscout
NIGHTSCOUT_PORT=1337
AUTH_DEFAULT_ROLES=readable
ENABLE=careportal rawbg iob cors
CUSTOM_TITLE=Glucose CGM
THEME=colors
TIME_FORMAT=24
```

`API_SECRET` moet minimaal 12 tekens zijn. Gebruik dezelfde waarde bij Nightscout device authentication.

### `.env.libreview`

Lokale LibreView credentials. Dit bestand wordt niet gecommit.

```env
LIBREVIEW_EMAIL=mail@example.com
LIBREVIEW_PASSWORD=your-libreview-password
LIBREVIEW_TZ=Europe/Amsterdam
LIBREVIEW_INTERVAL_SECONDS=60
LIBREVIEW_GRACE_WINDOW_MINUTES=30
LIBREVIEW_RETRY_ATTEMPTS=3
LIBREVIEW_RETRY_BASE_DELAY_MS=750
```

`LIBREVIEW_TZ` (IANA-zone, default `Europe/Amsterdam`) zet timestamps DST-bewust om, dus zomer- én wintertijd kloppen vanzelf. `LIBREVIEW_TZ_OFFSET` (minuten) is alleen een optionele vaste-offset override; leeg laten = automatisch.
`LIBREVIEW_GRACE_WINDOW_MINUTES` bepaalt hoeveel recente LibreView-historie elke sync opnieuw ophaalt, zodat late meetpunten alsnog opgeslagen kunnen worden.
`LIBREVIEW_RETRY_ATTEMPTS` en `LIBREVIEW_RETRY_BASE_DELAY_MS` bepalen hoeveel korte herpogingen de sync doet bij tijdelijke netwerkfouten, timeouts, rate limits of serverfouten.

### `.env.influxdb`

Optionele InfluxDB 1.8 configuratie. Dit is alleen voor xDrip upload of Grafana; Nightscout/MongoDB blijft de bron voor deze app.

```env
INFLUXDB_DB=xdrip
INFLUXDB_HTTP_AUTH_ENABLED=true
INFLUXDB_ADMIN_USER=root
INFLUXDB_ADMIN_PASSWORD=root
INFLUXDB_USER=root
INFLUXDB_USER_PASSWORD=root
INFLUXDB_PORT=8086
```

## Data Flow

1. LibreView/LibreLink account levert sensorhistorie.
2. `libreview-sync` haalt elke 60 seconden data op, met korte retries bij tijdelijke API-fouten.
3. Metingen worden genormaliseerd naar Nightscout `sgv` entries.
4. Elke entry krijgt een stabiele `identifier`: `glucose-cgm-libreview:<timestamp>`.
5. Bestaande identifiers worden overgeslagen om dubbele records te voorkomen.
6. De sync haalt steeds een recente grace window opnieuw op, zodat late meetpunten alsnog naar Nightscout kunnen.
7. Nightscout schrijft entries naar MongoDB.
8. De `libreview-sync` service schrijft bij nieuwe entries direct `prediction_snapshots` naar MongoDB.
9. De nginx-overlay leest historie uit `/api/v1/entries/sgv.json` plus de sync-endpoints.
10. Analyse, time-in-range, alarmen en voorspelling gebruiken deze Nightscout/MongoDB data.

De sync-service biedt op poort 8787 `POST /sync` om dezelfde LibreView-sync handmatig te starten.

## xDrip + InfluxDB

InfluxDB is optioneel en staat los van de Nightscout/MongoDB-flow. xDrip kan metingen naar InfluxDB schrijven voor tijdreeksopslag of Grafana, maar de overlay en predictie-scripts lezen daar niet uit.

Aanbevolen flow als xDrip de bron is:

```text
xDrip+ -> Nightscout API -> MongoDB -> Nightscout UI + overlay + predictie
xDrip+ -> InfluxDB -> Grafana/archief
```

Start InfluxDB:

```bash
cp .env.influxdb.example .env.influxdb
npm run influxdb:up
curl -i http://localhost:8086/ping
```

xDrip InfluxDB instellingen:

- URL: `http://<server-ip>:8086`
- Database: `xdrip`
- User: `root`
- Password: `root`

## Grafana

Grafana leest de xDrip-data uit InfluxDB. De datasource staat in `grafana/provisioning/datasources/influxdb.yml` en volgt de Grafana InfluxDB datasource-configuratie voor InfluxDB 1.x:

- Type: `influxdb`
- Query language: `InfluxQL`
- URL binnen Docker: `http://influxdb:8086`
- Database: `xdrip`
- User/password: `root` / `root`
- HTTP method: `GET`

Start Grafana:

```bash
npm run grafana:up
```

Open lokaal of op de server:

```text
http://localhost:3000/d/xdrip-glucose/xdrip-glucose
```

Op de huidige LAN-server:

```text
http://192.168.178.240:3000/d/xdrip-glucose/xdrip-glucose
```

De live setup is geverifieerd met InfluxDB `1.8.10`, Grafana `11.5.2`, datasource `xDrip InfluxDB` en dashboard `xDrip Glucose`.

## Important Files

- `docker-compose.nightscout.yml`: Docker services voor MongoDB, Nightscout, LibreView sync en optionele InfluxDB.
- `grafana/provisioning/datasources/influxdb.yml`: Grafana datasource voor InfluxDB 1.x / InfluxQL.
- `grafana/provisioning/dashboards/dashboards.yml`: Grafana dashboard provider.
- `grafana/dashboards/xdrip-glucose.json`: Basisdashboard voor xDrip glucosewaarden.
- `scripts/libreview-nightscout-sync.mjs`: Lokale sync van LibreView naar Nightscout; schrijft `prediction_snapshots` (V1 + V2 shadow) en glucose/rate naar InfluxDB.
- `scripts/lib/hypo-features.mjs`: Pure featurebuilder (`buildHypoFeatures`), gedeeld door live en backtest.
- `scripts/run-spike-filter-check.mjs`: regressiecheck voor Laag 9 (`172 -> 154 -> 172` single-point spike).
- `scripts/lib/reactive-hypo-detector.mjs`: V2 reactieve-hypo detector (`evaluateReactiveHypoRiskV2`), tunebaar via params.
- `scripts/lib/episode-similarity.mjs`: gedeelde episode-similarity (`findSimilarEpisodes` + `patternFromFeatures`); voedt het `pattern`-object (component 6 / `patternScore`) in live-sync, backtest én tuner identiek.
- `scripts/lib/episode-builder.mjs` + `scripts/build-reactive-hypo-episodes.mjs`: bouwt `reactive_hypo_episodes`.
- `scripts/lib/legacy-risk-v1.mjs`: getrouwe V1-port voor de backtest (één-op-één met de sync houden).
- `scripts/evaluate-hypo-detector.mjs`: backtest V1 vs V2 (precision/recall/lead-time).
- `scripts/tune-reactive-hypo-v2.mjs` + `scripts/reactive-hypo-v2-state.json`: auto-tuner en getunede V2-parameters.
- `scripts/build-entry-features.mjs`: Backfill van `entry_features`.
- `scripts/analyze-patterns.mjs`: Detectie van pattern events.
- `scripts/backfill-prediction-snapshots.mjs`: Historische snapshot backfill.
- `scripts/evaluate-predictions.mjs`: Evaluatie van snapshot-uitkomsten.
- `scripts/summarize-days.mjs`: Dagelijkse aggregaties in `daily_summaries`.
- `scripts/train-risk-model.mjs`: Training en calibratie van model_state.
- `scripts/retrain-and-export-model.mjs`: Train + export naar `scripts/risk-model-state.json`.
- `scripts/risk-model-state.json`: Geëxporteerde, actieve risico-drempels.
- `nightscout-overlay/rate-overlay.js`: De live overlay — hoofdmonitor met waarde, grafiek, voorspelling en hypo-kaart.
- `nightscout-overlay/nginx.conf`: Injecteert de overlay en proxyt de sync-endpoints.

## Prediction

De voorspelling gebruikt weighted linear regression op recente metingen. Recente waarden krijgen meer gewicht. De overlay en de sync delen deze aanpak; de risico-drempels komen uit `scripts/risk-model-state.json`.

Geen quadratic regression gebruiken voor glucosevoorspelling. Bij minuutdata geeft dat te snel overfit en wilde extrapolaties.

Naast de V1-regel draait een **V2 reactieve-hypo detector** (`scripts/lib/reactive-hypo-detector.mjs`, zie `hypo.md`) die curvevorm, dalingssnelheid, CGM-lag, scenario's en persoonlijke episodes combineert. V2 staat in **shadow-mode**: per snapshot opgeslagen als `shadowRisk`, maar V1 (`rules-v1.1`) blijft de enige alarmbron tot V2 op genoeg 1-min data getuned en geactiveerd is (M6). Live en backtest delen dezelfde featurebuilder/detector, zodat de backtest meet wat live draait.

De featurebuilder (`scripts/lib/hypo-features.mjs`) berekent o.a. `acceleration` (versnelt de daling?), herstelsignalen (`isDecelerating`/`isBottoming`/`recoverySignal`) die vals alarm dempen wanneer een daling al voorbij is, een **variabele CGM-lag** (`effectiveLagMinutes` 7/5/3/0 min, afhankelijk van de dalingssnelheid) en een **meal-onset detector** (`mealOnset`/`riseFromTroughMmol`/`minutesSinceTrough`): herkent dat een maaltijdpiek begint zodat V2 al in de stijgende fase een lage `watch` geeft (~10-15 min eerder dan de daling). Die `watch` werkt als risk-floor, niet als score-bijdrage, dus meal-onset kan nooit zelf tot een alarm leiden. Laag 9 draait dezelfde median-of-3 spike-filter in live-sync, featurebuilder, backtest en tuner; alleen de werk-timeline wordt opgeschoond, ruwe CGM-entries blijven intact en snapshots markeren dit met `spikeFiltered`/`rawCurrentMmol` wanneer het gebeurt. De live-sync geeft V2 hetzelfde `pattern`-object (persoonlijke episode-vergelijking) door als V1, en sinds 2026-06-04 doen de backtest én auto-tuner dat ook via de gedeelde `scripts/lib/episode-similarity.mjs` — train/serve zijn dus gelijkgetrokken (component 6 / `patternScore` wordt overal hetzelfde gevoed). De hypo-kaart in de overlay toont V1 en V2 naast elkaar (`niveau · score`, bij V2 ook `confidence %` en `✓` bij getunede params; V1 heeft geen `%` want het regelmodel berekent geen confidence). Redenen per model staan in de hover-tooltip; de sync-risk mag het kaart-alarm escaleren maar nooit verlagen. `hypo.md` bevat het volledige verbeterd-voorspellingsplan (9 lagen).

## Alarms

De overlay rendert de hypo-kaart op basis van de volgende standaarddrempels:

- Urgent laag: 3.0 mmol/L
- Laag: 3.9 mmol/L
- Hoog: 10.0 mmol/L
- Urgent hoog: 13.9 mmol/L
- Sensor verloren: 15 minuten zonder nieuwe meting

Alarmen ondersteunen actuele en voorspellende triggers.

## Nightscout/Mongo Notes

Nightscout draait lokaal op:

```text
http://localhost:1337
```

MongoDB data staat lokaal in:

```text
nightscout-mongo-data/
```

Deze map staat in `.gitignore`.

Optionele InfluxDB data staat lokaal in:

```text
influxdb-data/
```

Deze map staat ook in `.gitignore`.

Controleer Nightscout status:

```bash
curl http://localhost:1337/api/v1/status.json
```

Controleer laatste entries:

```bash
curl 'http://localhost:1337/api/v1/entries/sgv.json?count=5'
```

## Development Notes

- UI-tekst is Nederlands.
- De app is single-user opgezet.
- Houd nieuwe wijzigingen gericht op de Nightscout/Mongo flow.
- Geen build-stap; check scripts met `node --check scripts/<file>.mjs`.
- Gebruik `.env.*.example` voor documentatie en echte `.env.*` bestanden voor lokale secrets.
