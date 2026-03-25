-- =============================================================================
-- Skip telemetry inserts when point is inside "Home" geofence
-- =============================================================================
-- Purpose:
--   Prevent stationary GPS jitter at home from filling telemetry history.
--
-- Behavior:
--   BEFORE INSERT on public.telemetry:
--   - Finds geofences named "home" (case-insensitive) for users who own NEW.device_id
--   - If NEW.lat/lon is inside any such geofence radius, INSERT is skipped (RETURN NULL)
--   - Otherwise row is inserted normally
--
-- Notes:
--   - This affects live uploads and offline sync uploads (both insert into telemetry)
--   - Existing historical rows are not changed
--   - If you need a safety margin, increase the radius check by +X meters
-- =============================================================================

CREATE OR REPLACE FUNCTION public.skip_telemetry_inside_home_geofence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_inside_home boolean := false;
BEGIN
  -- No coordinates -> nothing to filter.
  IF NEW.lat IS NULL OR NEW.lon IS NULL THEN
    RETURN NEW;
  END IF;

  /*
    Haversine distance in meters:
      2 * R * asin(sqrt(...)), with R = 6371000m
  */
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
    -- Skip insert entirely.
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_skip_home_geofence_telemetry ON public.telemetry;

CREATE TRIGGER trg_skip_home_geofence_telemetry
BEFORE INSERT ON public.telemetry
FOR EACH ROW
EXECUTE FUNCTION public.skip_telemetry_inside_home_geofence();

