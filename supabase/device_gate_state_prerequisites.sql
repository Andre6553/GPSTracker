-- Auto gate prerequisites: require Home zone outward crossing + "Geofence Armed" before auto open.
-- Run in Supabase SQL Editor after gate_automation_setup.sql. Then redeploy `telegram-alerts`.

ALTER TABLE public.device_gate_state
  ADD COLUMN IF NOT EXISTS seen_left_home_alert boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS seen_geofence_armed_alert boolean NOT NULL DEFAULT false;

-- If a device was already AWAY_CONFIRMED when you ran this migration, auto-open is blocked until the
-- next full leave → arm → return, unless you intentionally backfill (only if Armed had already been sent):
-- UPDATE public.device_gate_state
-- SET seen_geofence_armed_alert = true
-- WHERE status IN ('AWAY_CONFIRMED', 'RETURNING');
