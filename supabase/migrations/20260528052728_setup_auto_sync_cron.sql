/*
  # Auto-sync LibreView elke minuut via pg_cron + pg_net

  Schakelt pg_cron en pg_net in en maakt een cron job aan die
  elke minuut de libreview-sync Edge Function aanroept.

  1. Extensions inschakelen
     - pg_cron: job scheduler in PostgreSQL
     - pg_net: async HTTP vanuit PostgreSQL

  2. Cron job: libreview_auto_sync
     - Schema: cron
     - Schedule: elke minuut (* * * * *)
     - Roept /functions/v1/libreview-sync aan via pg_net

  3. Logging tabel: sync_log
     - Houdt bij wanneer de auto-sync heeft gedraaid en of het gelukt is

  Noot: SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY worden uit
  current_setting gelezen — deze zijn standaard beschikbaar in Supabase.
*/

-- Extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Log tabel voor sync resultaten
CREATE TABLE IF NOT EXISTS sync_log (
  id          bigserial PRIMARY KEY,
  triggered_at timestamptz DEFAULT now(),
  request_id  bigint,
  source      text DEFAULT 'auto'
);

ALTER TABLE sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read sync log"
  ON sync_log FOR SELECT
  TO authenticated
  USING (true);

-- Verwijder bestaande job als die er al is
SELECT cron.unschedule('libreview_auto_sync')
WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'libreview_auto_sync'
);

-- Maak de minuut-cron job aan
SELECT cron.schedule(
  'libreview_auto_sync',
  '* * * * *',
  $$
  SELECT
    net.http_post(
      url := current_setting('app.supabase_url', true) || '/functions/v1/libreview-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.supabase_service_role_key', true)
      ),
      body := '{}'::jsonb
    ) AS request_id
  $$
);
