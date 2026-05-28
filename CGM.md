# Glucose CGM Guide

## Project

Glucose CGM is een lokale React/Vite applicatie voor continue glucosemonitoring. De app gebruikt Nightscout als API-laag en MongoDB als opslag voor CGM-metingen.

Belangrijkste doel:

- LibreView/LibreLink data elke minuut ophalen.
- Elke beschikbare meting opslaan in Nightscout/MongoDB.
- Analyse, grafieken, alarmen en voorspelling baseren op Nightscout/MongoDB.

## Stack

- Frontend: React 19, Vite, TypeScript.
- Grafieken: Recharts.
- CGM opslag: MongoDB via Nightscout.
- CGM API/UI backend: `nightscout/cgm-remote-monitor`.
- Lokale Libre sync: `scripts/libreview-nightscout-sync.mjs`.
- Docker services: `nightscout-mongo`, `nightscout`, `libreview-sync`.

Supabase-bestanden staan nog in de repo als oudere/alternatieve basis, maar de actuele lokale flow voor glucosemetingen gebruikt Nightscout en MongoDB.

## Commands

```bash
npm run dev
```

Start de Vite development server.

```bash
npm run build
```

Draait TypeScript checks en bouwt de productieversie. Gebruik dit na codewijzigingen.

```bash
npm run preview
```

Preview van de productiebuild.

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

Start handmatig dezelfde sync die de `Sync Libre` knop in Dashboard en Nightscout gebruikt.

```bash
npm run nightscout:down
```

Stopt de Docker services.

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
LIBREVIEW_TZ_OFFSET=120
LIBREVIEW_INTERVAL_SECONDS=60
```

`LIBREVIEW_TZ_OFFSET=120` is UTC+2 in minuten, geschikt voor Amsterdam zomertijd. Pas dit aan als timestamps verschuiven.

## Data Flow

1. LibreView/LibreLink account levert sensorhistorie.
2. `libreview-sync` haalt elke 60 seconden data op.
3. Metingen worden genormaliseerd naar Nightscout `sgv` entries.
4. Elke entry krijgt een stabiele `identifier`: `glucose-cgm-libreview:<timestamp>`.
5. Bestaande identifiers worden overgeslagen om dubbele records te voorkomen.
6. Nightscout schrijft entries naar MongoDB.
7. De React app leest historie uit `/api/v1/entries/sgv.json`.
8. Analyse, time-in-range, alarmen en voorspelling gebruiken deze Nightscout/MongoDB data.

Dashboard en Nightscout hebben een `Sync Libre` knop. Die roept lokaal `http://localhost:8787/sync` aan, wacht op de LibreView sync, en leest daarna opnieuw uit Nightscout/MongoDB.

## Important Files

- `docker-compose.nightscout.yml`: Docker services voor MongoDB, Nightscout en LibreView sync.
- `scripts/libreview-nightscout-sync.mjs`: Lokale sync van LibreView naar Nightscout.
- `src/lib/nightscout.ts`: Frontend adapter van Nightscout entries naar `GlucoseReading`.
- `src/pages/Nightscout.tsx`: Hoofdmonitor met live waarde, voorspelling, alarmen, TIR en statistiek.
- `src/pages/Dashboard.tsx`: Compacte grafiekweergave.
- `src/lib/prediction.ts`: Glucosevoorspelling.
- `src/lib/alarms.ts`: Alarmdrempels, snooze, geluid en notificaties.

## Prediction

De voorspelling gebruikt weighted linear regression op recente metingen. Recente waarden krijgen meer gewicht. Als er weinig data is, valt de code terug op persoonlijke trendrates uit localStorage of vaste defaults.

Geen quadratic regression gebruiken voor glucosevoorspelling. Bij minuutdata geeft dat te snel overfit en wilde extrapolaties.

## Alarms

Alarmdrempels worden lokaal opgeslagen in localStorage. Standaardwaarden:

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
- Draai `npm run build` na codewijzigingen.
- Gebruik `.env.*.example` voor documentatie en echte `.env.*` bestanden voor lokale secrets.
