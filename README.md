# Glucose CGM

Lokale CGM-monitor voor LibreView/LibreLink data met Nightscout en MongoDB. De app toont live glucose, grafieken, time-in-range, alarmen en voorspellingen op basis van de metingen die Nightscout in MongoDB opslaat.

## Snel Starten

1. Installeer dependencies:

   ```bash
   npm install
   ```

2. Maak lokale env-bestanden:

   ```bash
   cp .env.nightscout.example .env.nightscout
   cp .env.libreview.example .env.libreview
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

5. Start de app:

   ```bash
   npm run dev
   ```

Open daarna:

- App: `http://localhost:5173`
- Nightscout: `http://localhost:1337`

## Data Flow

```text
LibreView/LibreLink
  -> lokale libreview-sync Docker service
  -> Nightscout API
  -> MongoDB
  -> React app analyse, grafieken, alarmen en voorspelling
```

De sync draait elke 60 seconden. Elke meting krijgt een vaste Nightscout `identifier`, waardoor vertraagde minuutmetingen alsnog worden opgeslagen zonder dubbele records.

## Belangrijke Commands

```bash
npm run build
```

Typecheck en productiebuild.

```bash
npm run nightscout:up
```

Start alleen Nightscout en MongoDB.

```bash
npm run nightscout:libre
```

Start Nightscout, MongoDB en LibreView sync.

```bash
npm run libre:logs
```

Bekijk sync logs.

```bash
curl -X POST http://localhost:8787/sync
```

Start handmatig dezelfde LibreView sync die de `Sync Libre` knop gebruikt.

```bash
npm run nightscout:down
```

Stop Docker services.

## Documentatie

Zie [CGM.md](./CGM.md) voor de volledige technische handleiding, commandolijst, dataflow en ontwikkelnotities.
