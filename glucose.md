# Glucose CGM Plan

> Status-/roadmap-document. Voor de technische gids zie [CGM.md](./CGM.md), voor setup
> [README.md](./README.md), voor de predictie-implementatie [predict.md](./predict.md).

## Doel

Een single-user CGM-monitor die LibreView/LibreLink-data elke minuut inleest, opslaat en
analyseert (live waarde, grafieken, time-in-range, alarmen en hypo-voorspelling). UI in het
Nederlands.

## Huidige basis (af)

- React 19 + Vite + TypeScript frontend (`src/`) — pagina's `Nightscout.tsx`, `Dashboard.tsx`,
  `Settings.tsx`.
- **Nightscout + MongoDB** als API- en opslaglaag (de live flow). LibreView →
  `scripts/libreview-nightscout-sync.mjs` → Nightscout → MongoDB → frontend leest
  `/api/v1/entries/sgv.json` via `src/lib/nightscout.ts`.
- Docker-stack: `nightscout-mongo`, `nightscout`, `libreview-sync` (+ nginx-overlay).
- Alarmen (`src/lib/alarms.ts`): actuele en voorspellende triggers, snooze, geluid, stale-data.
- Voorspelling (`src/lib/prediction.ts`): weighted linear regression (geen quadratic).
- Predictie-pipeline (`scripts/`): `entry_features` → `pattern_events` → `prediction_snapshots`
  → evaluatie → modeltraining → export naar `src/lib/risk-model-state.json`.
- `episode_vectors` + live similarity-correctie en `user_feedback`-knoppen in de overlay-hypokaart.

> Supabase-bestanden (`supabase/`, `src/lib/supabase.ts`) staan nog in de repo als oudere/
> alternatieve basis, maar zijn **niet** de live flow. Geen nieuwe features op Supabase bouwen.

## Nog open (bewust)

1. **AI-laag** (`ai_observations` / `ai_questions` via gemini-mcp): uitleg, context en vragen
   bovenop de voorspelling. Komt later en neemt **nooit** de live alarmbeslissing.
2. Fine-tuning van thresholds/policies op een langere dataperiode (optioneel).
3. `episode_vectors`-similarity ook tonen in de UI-redenen.
4. Repo-/mappenopschoning.

## Werkwijze

- Houd wijzigingen gericht op de Nightscout/MongoDB-flow.
- Draai `npm run build` na codewijzigingen.
- Pipeline-scripts draaien tegen de live MongoDB op de iMac (zie deployment-notities).
