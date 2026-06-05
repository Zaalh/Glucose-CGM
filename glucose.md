# Glucose CGM Plan

> Status-/roadmap-document. Voor de technische gids zie [CGM.md](./CGM.md), voor setup
> [README.md](./README.md), voor de predictie-implementatie [predict.md](./predict.md).

## Doel

Een single-user CGM-monitor die LibreView/LibreLink-data elke minuut inleest, opslaat en
analyseert (live waarde, grafieken, time-in-range, alarmen en hypo-voorspelling). UI in het
Nederlands.

## Huidige basis (af)

- UI: de **Nightscout-webinterface met nginx-overlay** (`nightscout-overlay/rate-overlay.js`) —
  dit is wat live op poort 1337 draait.
- **Nightscout + MongoDB** als API- en opslaglaag (de live flow). LibreView →
  `scripts/libreview-nightscout-sync.mjs` → Nightscout → MongoDB → overlay leest
  `/api/v1/entries/sgv.json` en de sync-endpoints.
- Docker-stack: `nightscout-mongo`, `nightscout`, `libreview-sync`, `nightscout-ui` (nginx-overlay).
- Alarmen/hypo-risico: de overlay rendert de hypo-kaart; drempels uit `scripts/risk-model-state.json`.
- Voorspelling: weighted linear regression (geen quadratic), in de sync en overlay.
- Predictie-pipeline (`scripts/`): `entry_features` → `pattern_events` → `prediction_snapshots`
  → evaluatie → modeltraining → export naar `scripts/risk-model-state.json`.
- `episode_vectors` + live similarity-correctie en `user_feedback`-knoppen in de overlay-hypokaart.
- Laag 9 spike-filter: gedeelde median-of-3 cleaning in sync, featurebuilder, backtest en tuner;
  ruwe Nightscout/LibreView entries worden niet overschreven.

> De oude React/Vite-frontend (`src/`) en Supabase-laag (`supabase/`) zijn verwijderd. Niet
> opnieuw introduceren; bouw op de Nightscout/MongoDB-flow.

## Nog open (bewust)

1. **AI-laag activeren**: de OpenAI-compatible chatvoorbereiding staat klaar via
   `npm run ai:review`, maar blijft uit tot `AI_CHAT_BASE_URL`, `AI_CHAT_API_KEY` en
   `AI_CHAT_MODEL` zijn gezet. Schrijft alleen `ai_observations` / `ai_questions` en
   neemt **nooit** de live alarmbeslissing.
2. Fine-tuning van thresholds/policies op een langere dataperiode (optioneel).

## Werkwijze

- Houd wijzigingen gericht op de Nightscout/MongoDB-flow.
- Geen build-stap; check scripts met `node --check scripts/<file>.mjs`.
- Pipeline-scripts draaien tegen de live MongoDB op de iMac (zie deployment-notities).
