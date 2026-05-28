/*
  # Auto-sync cron job v3

  Elke minuut roept pg_cron de libreview-sync edge function aan via pg_net.
  Gebruikt de anon key — de edge function is deployed met verify_jwt=false
  zodat deze ook zonder auth-header werkt. Intern gebruikt de function altijd
  SUPABASE_SERVICE_ROLE_KEY voor database-toegang.
*/

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Verwijder bestaande job als die er al is
DO $$
BEGIN
  PERFORM cron.unschedule('libreview_auto_sync');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Plan elke minuut
SELECT cron.schedule(
  'libreview_auto_sync',
  '* * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://vmtogivembhcviulvgfv.supabase.co/functions/v1/libreview-sync',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZtdG9naXZlbWJoY3ZpdWx2Z2Z2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MTU2NjEsImV4cCI6MjA5NTQ5MTY2MX0.J-bIov27lHipMp657DS_9PXQr15HLaZrH-3syZt8NJE'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  )
  $$
);
