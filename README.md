# Glucose CGM

Lokale CGM-monitor voor LibreView/LibreLink of Dexcom Share/Follow data met Nightscout en MongoDB. De Nightscout-UI met een eigen nginx-overlay toont live glucose, grafiek, time-in-range, alarmen en voorspellingen op basis van de metingen die Nightscout opslaat.

## In het Kort

- UI: Nightscout-webinterface met een geïnjecteerde nginx-overlay (`nightscout-overlay/`).
- CGM-opslag: Nightscout + MongoDB.
- Lokale sync: LibreView of Dexcom Share naar Nightscout via Docker.
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
   cp .env.dexcom.example .env.dexcom
   cp .env.influxdb.example .env.influxdb
   ```

3. Vul de credentials voor de sensorbron(nen) die je gebruikt:

   ```env
   LIBREVIEW_EMAIL=jij@example.com
   LIBREVIEW_PASSWORD=...
   DEXCOM_USERNAME=+316...
   DEXCOM_PASSWORD=...
   ```

4. Start Nightscout, MongoDB en de gewenste sync-bron:

   ```bash
   npm run nightscout:libre
   # of
   npm run nightscout:dexcom
   ```

Open daarna de UI met overlay op `http://localhost:1337`.

Bij wijzigingen aan `nightscout-overlay/rate-overlay.js`: recreate de nginx-overlay container expliciet, anders kan
de bestaande container nog het oude bind-mount bestand serveren:

```bash
docker compose -f docker-compose.nightscout.yml up -d --force-recreate nightscout-ui
```

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
npm run nightscout:dexcom
```

Start Nightscout, MongoDB en dezelfde sync-service in Dexcom Share/Follow modus.

```bash
npm run nightscout:logs
```

Bekijk Nightscout logs.

```bash
npm run libre:logs
```

Bekijk sync logs. Dit is dezelfde service voor Libre en Dexcom.

```bash
npm run dexcom:test
```

Test alleen Dexcom Share/Follow login en metingen; schrijft niets naar Nightscout.

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

- `GET /prediction/latest` — de nieuwste `prediction_snapshots` record. Bevat o.a. `modelVersion` (welk model de alarmbron is: `rules-v1.1` = V1, `reactive-hypo-v2` = V2 actief), `risk`/`riskScore`/`reasons`, `predictedMmol` per horizon 10/15/20/30/60/120/180, kansen `<4.5`/`<4.0`, `features` (incl. `acceleration`, `effectiveLagMinutes`, herstelsignalen, `spikeFiltered`, `dataQuality`), `rawCurrentMmol` wanneer een ruwe CGM-spike is gladgestreken, `predicted`, `pattern`, de V2 shadow-velden `shadowRisk`/`shadowScore`/`shadowConfidence`/`shadowReasons`/`shadowTuned`, en — als V2 actief is — `legacyRisk`/`legacyScore` (de V1-waarde ter vergelijking).
- `GET /overlay/entries?count=N` — recente entries voor de overlay-grafiek.
- `POST /feedback` — schrijft `user_feedback` (types: `confirmed`, `false_alarm`, `feels_hypo`, `ate_now`, `fingerstick_confirmed`). Endpoint blijft bestaan; de hypo-kaart heeft sinds kort geen feedbackknoppen meer.

De nginx-overlay proxyt deze als `/_prediction/latest`, `/_overlay/entries` en `/_feedback`, zodat de browser ze same-origin kan benaderen. De hypo-kaart toont V1 en V2 naast elkaar (`niveau · score`, bij V2 ook `confidence %` en `✓` bij getunede params; V1 zonder `%` want het regelmodel kent geen confidence), met de redenen per model in de hover-tooltip.

Welk model nu live is, zie je ook direct via:

```bash
curl -s http://localhost:8787/prediction/latest | grep -o '"modelVersion":"[^"]*"'
```

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
npm run ai:review -- --dry-run
```

Optionele AI-laag. Leest recente `prediction_snapshots` en schrijft, als `--dry-run`
weg is, alleen naar `ai_observations` en `ai_questions`. Staat standaard uit totdat
een AI-provider is gezet. Gebruikt alleen officiële OpenAI-compatible
`/v1/chat/completions` endpoints en neemt nooit alarmbeslissingen.

Nieuwe router-config met fallback-volgorde:

```bash
AI_ROUTER_PROVIDERS=openai,zai
AI_OPENAI_BASE_URL=https://api.openai.com
AI_OPENAI_API_KEY=...
AI_OPENAI_MODEL=gpt-4.1-mini
AI_ZAI_BASE_URL=https://api.z.ai
AI_ZAI_API_KEY=...
AI_ZAI_MODEL=glm-4.5
```

De oude single-provider vars `AI_CHAT_BASE_URL`, `AI_CHAT_API_KEY` en
`AI_CHAT_MODEL` blijven werken zolang `AI_ROUTER_PROVIDERS` leeg is.

`npm run ai:review` laadt lokaal automatisch `.env.ai` (gitignored) via
`node --env-file-if-exists`. Voorbeeld met Ollama Cloud:

```bash
# .env.ai
AI_ROUTER_PROVIDERS=ollama
AI_OLLAMA_BASE_URL=https://ollama.com
AI_OLLAMA_API_KEY=...
AI_OLLAMA_MODEL=gpt-oss:120b
```

Per run een ander model kiezen (overschrijft `AI_*_MODEL`):

```bash
npm run ai:review -- --dry-run --model glm-4.7
```

#### AI-review knop in de overlay

De overlay heeft rechtsonder een **AI-knop**. Die opent een paneel met een
model-dropdown, een "Review draaien"-knop en de recente observaties/vragen. De
knop praat via nginx (`/_ai-review/*`) met de `libreview-sync` server, die de
review draait (`ai_observations`/`ai_questions`) en de Ollama-modellen proxyt.

De server-routes: `POST /ai-review/run` (body `{ model }`), `GET /ai-review/latest`,
`GET /ai-review/models`. Een in-memory lock + `AI_REVIEW_MIN_INTERVAL_MS`
(default 30s) voorkomt spammen. Zet hiervoor `.env.ai` (zelfde vars als hierboven)
op de host; die wordt via `env_file` in de `libreview-sync` service geladen.

De review is **verrijkt** met deterministische AGP-context (TBR-first stats, per-uur
dipprofiel, episodes, reactive-digest) en gehard met **klinische guardrails**: geen onterecht
"reactieve hypo"-label bij 0% postprandiaal, artefact-/compressie-weging voor nachtelijke
lows, en een server-side backstop die `needsUserConfirmation` afdwingt op onbevestigde
low-observaties. **Cadans:** naast de knop draait de review **event-driven** — bij een
risico-escalatie naar watch+ of een nieuwe episode (`AI_EVENT_REVIEW`,
`AI_EVENT_MIN_INTERVAL_MINUTES`), plus één **dag-digest** per kalenderdag (`AI_DAILY_DIGEST`).
De per-minuut alarmlaag (detector + vectorlaag) staat hier los van. De CLI
(`npm run ai:review`) draait dezelfde verrijkte review via de server-endpoints
(`AI_REVIEW_SERVER_URL`). Regressie: `npm run ai:review-smoke` (in `ai:check`).

Daarnaast zijn er **deterministische, gratis** lees-endpoints (puur Mongo, geen LLM):
`/ai-review/stats`, `/episodes`, `/reports`, `/day`, `/history`, `/patterns`,
`/evaluation`, `/source-health` en `/episode-detail`, plus notities/reminders
(`/events`, `/reminders`). Het paneel heeft naast Inzichten ook Statistiek-, Rapporten- en
History-tabs. Episode-detail is een gefocuste review (metrics, dagdeel-pattern, klikbare
vergelijkbare episodes) **zonder eigen curve** — Nightscout toont de grafiek al. De
schrijf-endpoints (`POST /events`, `/reminders`) zijn in nginx beperkt tot
LAN/Tailscale/localhost (`limit_except GET`).

Optioneel periodiek automatisch draaien (default uit): zet
`AI_REVIEW_INTERVAL_MINUTES=60` in `.env.ai` → de server draait dan elk uur een
review op de achtergrond.

```bash
npm run spike-filter:check
```

Controleert de gedeelde Laag 9 spike-filter met een fixture (`172 -> 154 -> 172`) zodat
historische single-point sensorartefacten worden gladgestreken zonder ruwe entries te overschrijven.

```bash
npm run data-quality:check
```

Controleert de Laag 10 data-quality gate: normale 1-min data, grote gaten, dubbele/out-of-order
timestamps en oude laatste metingen. V1 en V2 gebruiken dezelfde `features.dataQuality`.

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

Nightscout/MongoDB blijft de bron van waarheid voor ruwe metingen, snapshots, feedback
en episodes. `episode_vectors` vervangen die database niet; ze zijn een afgeleide
zoeklaag/cache bovenop MongoDB. Als de vectorlogica verandert, bouw je de vectors opnieuw
uit de database. Live gebruikt vectors alleen om persoonlijke, vergelijkbare patronen snel
te vinden.

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

### Reactieve-hypo detector V2 (hypo.md)

De V2-laag draait op een gedeelde featurebuilder/detector in `scripts/lib/`, zodat live en
backtest exact dezelfde logica gebruiken. Deze commands draaien node in het Docker-netwerk
(MongoDB is daar bereikbaar) of lokaal op fixtures.

```bash
npm run episodes:build
```

Bouwt de collectie `reactive_hypo_episodes` (piek→nadir descents met outcome) uit alle entries.

```bash
npm run hypo:backtest
```

Speelt de historie af en vergelijkt V1 (regel) met V2 (reactieve detector): precision, recall,
lead-time, gemiste hypo's en vals alarm. Telt alleen echte vroege waarschuwingen en filtert op
meet-dichtheid. Verandert niets live.

```bash
npm run hypo:tune
```

Auto-tuner: temporele train/test-split + grid search over de V2-parameters met een
recall-gebonden doel. Schrijft de beste set naar `scripts/reactive-hypo-v2-state.json`
(en niets bij te weinig hypo-events). Wordt pas zinvol met genoeg 1-min data.

De tuner optimaliseert naast score-drempels ook de persoonlijke vectorlaag:
`patternRecencyDays` en `params.similarity` (afstandsdrempel, dynamische match-cap,
afstandsmarge en curve-similarity cutoff). Het aantal gebruikte matches is niet vast
`8` of `15`: de selector neemt minimaal genoeg bewijs, breidt uit als extra matches dicht
bij de beste match blijven, en gebruikt een veiligheidsplafond (`hardMax`) uit defaults of
state. Bij weinig data blijft de patroonlaag neutraal en blijft de universele safety-laag
leidend.

Dry-run zonder state te schrijven:

```bash
HYPO_TUNE_DRY_RUN=1 npm run hypo:tune
```

Op ~3 weken 1-min data kan volledige tuning meerdere minuten duren, omdat replay-punten
met `episode_vectors` worden vergeleken. De tuner zoekt daarom staged: eerst de
kernparameters, daarna een compacte similarity-refinement rond de beste kandidaat. Verdere
versnelling kan door precomputed vector-score matrices; live voorspellen blijft snel omdat
live maar een nieuwe meting per minuut verwerkt.

```bash
npm run detector:fixtures
npm run episodes:check
```

Lokale sanity-checks zonder database (detector op testgevallen / episode-builder op een
synthetische timeline).

```bash
npm run hypo:report -- --days 1     # dagrapport
npm run hypo:report -- --days 7     # weekrapport
npm run hypo:report -- --by-weekday # per-weekdag profiel (28 dagen)
npm run hypo:patterns -- --days 28  # uur-van-de-dag + weekdag + episode-patronen
```

Rapporten over jouw eigen data: (near-)hypo's, time-in-range, snelste daling, V1 vs V2,
en de riskantste uren/weekdagen — zodat je zoveel mogelijk patronen vindt.

```bash
npm run rebound:profile   # genereert scripts/rebound-recovery-profile.json
npm run rebound:eval      # out-of-sample evaluatie van de rebound-forecast
```

Rebound-forecast (shadow-first, raakt niets live aan): na een reactieve dip is het herstel
zeer voorspelbaar — de rebound-piek gaat dip-diepte-onafhankelijk naar een persoonlijk
set-point (~7.3 mmol). `rebound:profile` leert daaruit een vaste herstelcurve met band
(p10–p90 per horizon, 0–90 min na de nadir); `rebound:eval` toetst die out-of-sample
(temporele split) tegen twee baselines en bewaakt de band-kalibratie. Gedeelde, pure kern
in `scripts/lib/rebound-profile.mjs` (train/serve-pariteit). Pas een UI-band tonen zodra de
evaluator over genoeg episodes stabiel blijft.

### Automatisch leren (dagelijks)

`scripts/daily-hypo-tune.sh` draait via launchd (`deploy/com.glucosecgm.hypotune.plist`,
dagelijks 04:30): episodes verversen → auto-tunen op je eigen episodes → dag/week/weekdag/
patroon-rapporten in `hypo-tune-reports/`. De sync laadt de geleerde parameters
(`scripts/reactive-hypo-v2-state.json`) en past ze toe op de V2 shadow. De state kan naast
V2-scoreparams ook `similarity`-params bevatten; live, backtest en tuner gebruiken dan exact
dezelfde vectorselectie.

Installeren op de server:

```bash
cp deploy/com.glucosecgm.hypotune.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.glucosecgm.hypotune.plist
```

**Auto-activatie (M6)**: de tuner zet V2 alleen automatisch live als hij op out-of-sample
data niet slechter is dan V1 (recall én precision niet lager) en er genoeg events zijn.
Tot die kwaliteitsgate slaagt blijft V1 (`rules-v1.1`) de alarmbron en draait V2 in shadow.

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
- `user_feedback` endpoint voor feedbackregistratie

Reactieve-hypo detector V2 (`hypo.md`):

- M1 rijkere snapshots (`features`/`predicted`/`pattern`/`lagAdjustedMmol`, `rules-v1.1`)
- M2 gedeelde featurebuilder + V2-detector in `scripts/lib/`
- M3 episode-builder → `reactive_hypo_episodes`
- M4 backtest (V1 vs V2) + auto-tuner met train/test-split
- M5 shadow-mode: V2 draait stil mee als `shadowRisk` (geen alarm)
- Dagelijkse auto-tune (launchd) + dag/week/weekdag/patroon-rapporten
- Sync past geleerde params toe op V2 shadow (`shadowTuned`)
- M6 auto-activatie met kwaliteitsgate (gewapend; activeert vanzelf zodra V2 ≥ V1 op
  out-of-sample data en genoeg events)
- Slimmere features (stap 1 t/m 10): `acceleration`, herstelsignalen, persoonlijke
  nadir/curve/weekdag-patronen, dagdeel-context, variabele CGM-lag en gedeelde
  median-of-3 spike-filter plus datakwaliteitsflags
- V1- én V2-regel naast elkaar in de hypo-kaart (V2 met `confidence %`, redenen in tooltip);
  sync-risk mag het kaart-alarm escaleren (nooit verlagen)
- V2 krijgt dezelfde persoonlijke episode-vergelijking (`pattern`) als V1 in de live-sync;
  sinds 2026-06-04 ook in backtest en auto-tuner (gedeelde `scripts/lib/episode-similarity.mjs`),
  zodat train/serve gelijk zijn
- Dynamische vector matching: `pattern` gebruikt geen vaste top-N meer. Het aantal beste
  patronen hangt af van matchkwaliteit, beschikbare historie, recency-weighting en getunede
  `similarity`-params.

Verbeterd voorspellingsplan: `hypo.md` beschrijft 10 gebouwde lagen (nadir-schatting,
curvevorm-match, dagdeel-context, weekdag-patroon, meal-onset detector, spike-filter
en data-quality gate).
Stap 9 filtert single-point ruispieken met een gedeelde median-of-3 cleaning in sync,
features, backtest en tuner; ruwe CGM-entries blijven ongewijzigd. Stap 10 markeert
timestamp-/datakwaliteit en dempt V1/V2 escalatie als de input twijfelachtig is,
zonder actuele lage glucose te verbergen. Stap 8 (meal-onset) waarschuwt al in de
stijgende fase: een lage `watch` zodra een maaltijdpiek begint (~10-15 min eerder
dan de daling). De overlay spiegelt deze meal-onset client-side en toont een
gestapeld vierkant kaartje **links vóór de klok** (verankerd aan `#currentTime`)
met per fase zo veel mogelijk detail — bv. bij een reactieve daling: piek→huidig,
Δ mmol, daalsnelheid/min, minuten na piek, voorspelde dip en de risico-score —
zolang een maaltijd-episode loopt; geen extra API-call, berekend uit de readings
die de overlay al heeft. De escalatie van een reactieve daling stuurt op de
**verwachte bodem** (`projectReactiveNadir`) t.o.v. universele klinische drempels
(`watchMmol` 4.5, `alertMmol` 3.9, `seriousMmol` 3.0, configureerbaar), niet op de
kale daalsnelheid: een daling die ruim boven 3.9 bodemt (bv. normale klaring 11 → 9)
blijft `low`, een daling richting < 3.9 / < 3.0 wordt `high` / `urgent`. De
badge-basiskleur volgt dat niveau — rustig grijs (`low`), amber (`watch`), rood
(`high`/`urgent`) — zodat rood voorbehouden blijft aan een echte hypo-projectie.
Zie `mealdetectie.md` voor de detector + risico-laag.

Nog open (databottleneck, niet code):

- De kwaliteitsgate slaagt pas met ~1–2 weken dichte 1-min data verspreid over tijd
  (nu zitten alle hypo-events in één recente cluster). Tot dan blijft V1 de alarmbron.
- AI-laag is voorbereid maar staat uit tot er een API-key, endpoint en model zijn.

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

### `.env.dexcom`

Lokale Dexcom Share/Follow credentials. Dit bestand wordt niet gecommit. Je mag `.env.libreview` en `.env.dexcom` allebei laten staan; het startcommando kiest de bron.

```env
DEXCOM_USERNAME=+316...
DEXCOM_PASSWORD=your-dexcom-password
DEXCOM_REGION=ous
DEXCOM_MINUTES=1440
DEXCOM_MAX_COUNT=288
```

`DEXCOM_REGION=ous` is de standaard voor Europa/Outside-US. Dexcom levert normaal een meting per 5 minuten; `DEXCOM_MAX_COUNT=288` is ongeveer 24 uur historie.

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
LibreView/LibreLink of Dexcom Share/Follow
  -> lokale libreview-sync Docker service (bron gekozen met CGM_SOURCE)
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
