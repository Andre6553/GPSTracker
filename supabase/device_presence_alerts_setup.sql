-- Device presence alerts (single offline alert per outage + online reset).
-- Run in Supabase SQL editor.

ALTER TABLE public.user_devices
ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

ALTER TABLE public.user_devices
ADD COLUMN IF NOT EXISTS offline_alert_sent BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_user_devices_last_seen_at
ON public.user_devices (last_seen_at);

-- Optional: initialize known devices as "online" baseline to avoid immediate offline alerts.
UPDATE public.user_devices
SET last_seen_at = COALESCE(last_seen_at, timezone('utc'::text, now()));

-- Optional pg_cron schedule (Pro/Team):
-- 1) Enable extension: CREATE EXTENSION IF NOT EXISTS pg_cron;
-- 2) Add vault secret with service-role bearer token if needed and call edge function endpoint:
--    SELECT cron.schedule(
--      'device-presence-check-every-minute',
--      '* * * * *',
--      $$
--      select net.http_post(
--        url:='https://<PROJECT-REF>.supabase.co/functions/v1/device-presence-check',
--        headers:='{"Authorization":"Bearer <PRESENCE_CHECK_SECRET>","Content-Type":"application/json"}'::jsonb,
--        body:='{}'::jsonb
--      );
--      $$
--    );
