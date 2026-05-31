# Glucose CGM

Lokale CGM-monitor voor LibreView/LibreLink data met Nightscout en MongoDB. De Nightscout-UI met een eigen nginx-overlay toont live glucose, grafiek, time-in-range, alarmen en voorspellingen op basis van de metingen die Nightscout opslaat.

## In het Kort

- UI: Nightscout-webinterface met een geïnjecteerde nginx-overlay (`nightscout-overlay/`).
- CGM-opslag: Nightscout + MongoDB.
- Lokale sync: LibreView naar Nightscout via Docker.
- Predictie: offline Node-scripts (`scripts/`) op MongoDB.

## Snel Starten

1. Installeer dependencies:

   ```bash
   npm install
   ```

2. Maak lokale env-bestanden aan:

   ```bash
   cp .env.nightscout.example .env.nightscout
   cp .env.libreview.example .env.libreview
   cp .env.influxdb.example .env.influxdb
   ```

3. Vul `.env.libreview` met je LibreView/LibreLink gegevens:

   ```env
   LIBREVIEW_EMAIL=jij@example.com
   LIBREVIEW_PASSWORD=...
   ```

4. Start Nightscout, MongoDB en de LibreView sync:

   ```bash
   npm run nightscout:libre
   ```

Open daarna de UI met overlay op `http://localhost:1337`.

## Belangrijke Commands

```bash
npm run nightscout:up
```

Start alleen Nightscout en MongoDB.

```bash
npm run nightscout:libre
```

Start Nightscout, MongoDB en de LibreView sync-service.

```bash
npm run nightscout:logs
```

Bekijk Nightscout logs.

```bash
npm run libre:logs
```

Bekijk LibreView sync logs.

```bash
npm run influxdb:up
```

Start optioneel alleen InfluxDB voor xDrip/Grafana. Deze database vervangt Nightscout/MongoDB niet.

```bash
npm run influxdb:logs
```

Bekijk InfluxDB logs.

```bash
npm run influxdb:down
```

Stop alleen de optionele InfluxDB-service.

```bash
npm run grafana:up
```

Start optioneel Grafana met een vooraf geconfigureerde InfluxDB datasource en glucose-dashboard.

```bash
curl http://localhost:8787/health
```

Controleer of de lokale sync-service draait en geconfigureerd is.

```bash
curl -X POST http://localhost:8787/sync
```

Start handmatig dezelfde sync die de `Sync Libre` knop gebruikt.

### Sync-service endpoints

De `libreview-sync` service (poort 8787) biedt naast `/health` en `/sync`:

- `GET /prediction/latest` — de nieuwste `prediction_snapshots` record (risico, `predictedMmol` per horizon 10/15/20/30/60/120/180, kansen `<4.5`/`<4.0`).
- `GET /overlay/entries?count=N` — recente entries voor de overlay-grafiek.
- `POST /feedback` — schrijft `user_feedback` (types: `confirmed`, `false_alarm`, `feels_hypo`, `ate_now`, `fingerstick_confirmed`), gekoppeld aan de dichtstbijzijnde entry + actieve snapshot.

De nginx-overlay proxyt deze als `/_prediction/latest`, `/_overlay/entries` en `/_feedback`, zodat de browser ze same-origin kan benaderen. De feedbackknoppen in de hypo-kaart van de overlay gebruiken `POST /_feedback`.

```bash
npm run nightscout:down
```

Stop de Docker-services.

```bash
npm run model:retrain
```

Trained het persoonlijke risicomodel op `prediction_snapshots` in MongoDB en exporteert de actieve drempels naar `scripts/risk-model-state.json`.

```bash
npm run snapshots:live
```

Maakt één live `prediction_snapshots` record op basis van de meest recente Nightscout entry (idempotent per `entryId`).

```bash
npm run patterns:analyze
```

Scant alle entries en vult `pattern_events` (spikes, drops, (near-)hypo's, hypo-na-hyper).

```bash
npm run features:build
```

Berekent afgeleide `entry_features` per CGM-entry.

```bash
npm run vectors:build
```

Bouwt `episode_vectors` uit `pattern_events` + entries: per episode een genormaliseerde curve-vector, een uitlegbare featureVector en de gemeten outcome. Basis voor de live similarity-correctie. Draai dit ná `patterns:analyze`.

```bash
npm run snapshots:backfill
```

Simuleert historische voorspellingen op oude entries (voor training/evaluatie).

```bash
npm run snapshots:evaluate
```

Vult de uitkomsten van `prediction_snapshots` (`actualMinMmol_30m/60m/120m/180m`, (near-)hypo-vlaggen, `true/false_positive/negative`).

```bash
npm run summaries:build
```

Bouwt/actualiseert `daily_summaries` vanuit `entries`, `pattern_events` en geëvalueerde `prediction_snapshots`.

```bash
npm run model:retrain:balanced
npm run model:retrain:precision
```

Alternatieve trainingspolicies naast de standaard recall-first.

## Predictie Status

Afgerond:

- `entry_features` backfill script
- `pattern_events` detectiescript
- regelgebaseerde live risicoscore in de Nightscout UI
- `prediction_snapshots` backfill
- live snapshot command (`npm run snapshots:live`)
- snapshot evaluatiescript (`TP/FP/FN/TN`)
- modeltraining + export naar app-config
- `daily_summaries` script
- policy-gestuurde training (`balanced` / `precision-first`)
- forecast-horizons 10/15/20/30/60/120/180 (rate satureert vanaf >30 min)
- `episode_vectors` + live similarity-correctie op de patrooncorrectie
- `user_feedback` feedbackknoppen in de overlay-hypokaart

Nog open (bewust):

- fine-tuning van thresholds/policies op langere dataperiode (optioneel)
- AI-laag (`ai_observations` / `ai_questions`): uitleg/context/vragen — komt later, neemt nooit de live alarmbeslissing
- `episode_vectors` similarity ook in de UI-redenen tonen

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

`API_SECRET` moet minimaal 12 tekens zijn.

### `.env.libreview`

Lokale LibreView credentials. Dit bestand wordt niet gecommit.

```env
LIBREVIEW_EMAIL=mail@example.com
LIBREVIEW_PASSWORD=your-libreview-password
LIBREVIEW_TZ=Europe/Amsterdam
LIBREVIEW_INTERVAL_SECONDS=60
LIBREVIEW_GRACE_WINDOW_MINUTES=30
LIBREVIEW_RETRY_ATTEMPTS=6
LIBREVIEW_RETRY_BASE_DELAY_MS=1200
LIBREVIEW_RETRY_MAX_DELAY_MS=20000
LIBREVIEW_HTTP_TIMEOUT_MS=15000
LIBREVIEW_RETRY_JITTER_MS=400
```

`LIBREVIEW_TZ` (IANA-zone, default `Europe/Amsterdam`) zet timestamps **DST-bewust** om, dus zomer- én wintertijd kloppen vanzelf. Alleen als je een vaste offset wilt forceren zet je `LIBREVIEW_TZ_OFFSET` (minuten); leeg laten = automatisch.

### `.env.influxdb`

Optionele InfluxDB 1.8 configuratie voor xDrip upload of Grafana. Dit bestand wordt niet gecommit.

```env
INFLUXDB_DB=xdrip
INFLUXDB_HTTP_AUTH_ENABLED=true
INFLUXDB_ADMIN_USER=root
INFLUXDB_ADMIN_PASSWORD=root
INFLUXDB_USER=root
INFLUXDB_USER_PASSWORD=root
INFLUXDB_PORT=8086
```

InfluxDB is hier een extra tijdreeks-archief. De Nightscout UI, overlay en predictie-scripts blijven Nightscout/MongoDB gebruiken als bron van waarheid.

## Data Flow

```text
LibreView/LibreLink
  -> lokale libreview-sync Docker service
  -> Nightscout API
  -> MongoDB
  -> Nightscout-UI + nginx-overlay: grafiek, alarmen en voorspelling
```

Optioneel kan xDrip parallel naar InfluxDB schrijven:

```text
xDrip+
  -> InfluxDB: archief/Grafana
  -> Nightscout API: live UI/predictie in deze repo
```

Gebruik InfluxDB dus niet als enige uploaddoel als je deze app live wilt blijven voeden.

De sync draait elke 60 seconden. Elke meting krijgt een vaste Nightscout `identifier`, waardoor vertraagde minuutmetingen alsnog worden opgeslagen zonder dubbele records.

De sync-service biedt op poort 8787 `POST /sync` om handmatig dezelfde sync te starten.

## xDrip + InfluxDB

Start InfluxDB met `npm run influxdb:up` en controleer lokaal met:

```bash
curl -i http://localhost:8086/ping
```

Configureer xDrip+ InfluxDB upload met:

- URL: `http://<server-ip>:8086`
- Database: `xdrip`
- User: `root`
- Password: `root`

Laat xDrip daarnaast ook naar Nightscout uploaden als de Nightscout UI en predicties in deze repo live-data moeten ontvangen.

## Grafana

Grafana is optioneel en leest de xDrip-data uit InfluxDB. De datasource is via provisioning ingesteld volgens de Grafana InfluxDB-documentatie:

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

Open daarna:

```text
http://localhost:3000/d/xdrip-glucose/xdrip-glucose
```

Op de huidige LAN-server:

```text
http://192.168.178.240:3000/d/xdrip-glucose/xdrip-glucose
```

Grafana is geverifieerd met datasource `xDrip InfluxDB` en dashboard `xDrip Glucose`.

## Documentatie

Zie [CGM.md](./CGM.md) voor de volledige technische handleiding, commandolijst, dataflow en ontwikkelnotities.
