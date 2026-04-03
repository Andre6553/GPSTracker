-- =============================================================================
-- Admin telemetry insert (bypass Home skip trigger for one row)
-- =============================================================================
-- Run this in Supabase → SQL Editor after telemetry_skip_home_geofence.sql.
--
-- - Updates the skip trigger to honour session flag app.skip_home_geofence = on
-- - Adds public.admin_insert_telemetry(...) callable only by service_role
-- - Use from scripts with SUPABASE_SERVICE_ROLE_KEY so the map can show a pin
--   at Home coordinates that would normally be dropped as jitter.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.skip_telemetry_inside_home_geofence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_inside_home boolean := false;
BEGIN
  IF NEW.lat IS NULL OR NEW.lon IS NULL THEN
    RETURN NEW;
  END IF;

  -- Set for one INSERT only via admin_insert_telemetry (local to transaction).
  IF coalesce(current_setting('app.skip_home_geofence', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.user_devices ud
    JOIN public.geofences g
      ON g.user_id = ud.user_id
    WHERE ud.device_id = NEW.device_id
      AND lower(trim(g.name)) = 'home'
      AND (
        2 * 6371000 * asin(
          sqrt(
            power(sin(radians((NEW.lat - g.lat) / 2)), 2) +
            cos(radians(g.lat)) * cos(radians(NEW.lat)) *
            power(sin(radians((NEW.lon - g.lon) / 2)), 2)
          )
        )
      ) <= g.radius_meters
  )
  INTO v_inside_home;

  IF v_inside_home THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

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
