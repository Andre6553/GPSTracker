-- =============================================================================
-- Skip telemetry inserts when point is inside "Home" geofence (jitter only)
-- =============================================================================
-- Purpose:
--   Reduce stationary GPS jitter at home from filling telemetry history.
--
-- Critical interaction:
--   Telegram / `telegram-alerts` runs on successful telemetry INSERT. If every
--   inside-home row is dropped, ENTER alerts and `device_geofence_status` never
--   see an "inside" sample — while EXIT still works from the first outside row.
--   Gate auto-open uses `inside_streak` (one step per INSERT while inside inner
--   radius). Keeping only one inside row per visit means `ENTRY_CONFIRM_POINTS`
--   in the edge function must be 1 (default), or the gate will never fire.
--
-- Behavior:
--   BEFORE INSERT on public.telemetry:
--   - If NEW is outside all geofences named "home" (case-insensitive) for this
--     device owner → INSERT normally.
--   - If NEW is inside Home:
--       • If there is no previous telemetry row for this device → INSERT (first fix).
--       • If the latest stored point was outside Home → INSERT (outside→inside:
--         ENTER / gate / webhooks need this row).
--       • If the latest stored point was also inside Home → skip (RETURN NULL).
--
-- Bypass:
--   Set session `app.skip_home_geofence` = 'on' for one row (see
--   telemetry_admin_insert.sql → admin_insert_telemetry).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.telemetry_point_inside_named_home_geofence(
  p_device_id text,
  p_lat double precision,
  p_lon double precision
)
RETURNS boolean
LANGUAGE sql
VOLATILE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_devices ud
    JOIN public.geofences g
      ON g.user_id = ud.user_id
    WHERE ud.device_id = p_device_id
      AND lower(trim(g.name)) = 'home'
      AND (
        2 * 6371000 * asin(
          sqrt(
            power(sin(radians((p_lat - g.lat) / 2)), 2) +
            cos(radians(g.lat)) * cos(radians(p_lat)) *
            power(sin(radians((p_lon - g.lon) / 2)), 2)
          )
        )
      ) <= g.radius_meters
  );
$$;

CREATE OR REPLACE FUNCTION public.skip_telemetry_inside_home_geofence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_last_lat double precision;
  v_last_lon double precision;
BEGIN
  IF NEW.lat IS NULL OR NEW.lon IS NULL THEN
    RETURN NEW;
  END IF;

  IF coalesce(current_setting('app.skip_home_geofence', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  IF NOT public.telemetry_point_inside_named_home_geofence(NEW.device_id, NEW.lat, NEW.lon) THEN
    RETURN NEW;
  END IF;

  -- NEW is inside Home: keep only boundary / first-fix rows; drop further inside jitter.
  SELECT t.lat, t.lon INTO v_last_lat, v_last_lon
  FROM public.telemetry t
  WHERE t.device_id = NEW.device_id
  ORDER BY t.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF public.telemetry_point_inside_named_home_geofence(NEW.device_id, v_last_lat, v_last_lon) THEN
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
