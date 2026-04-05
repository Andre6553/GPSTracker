-- =============================================================================
-- Admin telemetry insert (bypass Home skip trigger for one row)
-- =============================================================================
-- Prerequisite: run `telemetry_skip_home_geofence.sql` first. That file defines
-- `skip_telemetry_inside_home_geofence` (including the `app.skip_home_geofence`
-- session bypass used below).
--
-- This file adds only:
--   public.admin_insert_telemetry(...) — service_role only; inserts one row even
--   inside Home (sets app.skip_home_geofence = on for that INSERT).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_insert_telemetry(
  p_device_id text,
  p_lat double precision,
  p_lon double precision,
  p_speed_kmh real DEFAULT 0
)
RETURNS SETOF public.telemetry
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('app.skip_home_geofence', 'on', true);
  RETURN QUERY
  INSERT INTO public.telemetry (device_id, lat, lon, speed_kmh, altitude_m, satellites)
  VALUES (p_device_id, p_lat, p_lon, COALESCE(p_speed_kmh, 0), 0, 8)
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_insert_telemetry(text, double precision, double precision, real) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_insert_telemetry(text, double precision, double precision, real) TO service_role;

COMMENT ON FUNCTION public.admin_insert_telemetry(text, double precision, double precision, real) IS
  'Service-role only: insert one telemetry row even inside Home (bypass jitter skip).';
