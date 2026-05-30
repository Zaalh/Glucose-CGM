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
- CGM API/UI backend: `nightscout/cgm-remote-monitor`.
- Lokale Libre sync: `scripts/libreview-nightscout-sync.mjs`.
- Predictie: offline Node-scripts in `scripts/`.
- Docker services: `nightscout-mongo`, `nightscout`, `libreview-sync`, `nightscout-ui` (nginx).

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

## Important Files

- `docker-compose.nightscout.yml`: Docker services voor MongoDB, Nightscout en LibreView sync.
- `scripts/libreview-nightscout-sync.mjs`: Lokale sync van LibreView naar Nightscout.
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
