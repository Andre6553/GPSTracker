-- =============================================================================
-- Telemetry retention: delete OLD rows so the database stays within plan limits.
-- =============================================================================
-- Supabase does not auto-delete when you hit a storage cap; you must prune.
-- Practical approach: time-based retention (e.g. keep last 90 days). Adjust
-- p_days to your plan and how many devices you log.
--
-- Rough capacity math (one device, 5 s interval, moving 24/7):
--   ~12 points/min × 1440 min ≈ 17,280 rows/day
--   ~150–300 bytes per row (table + indexes) → ~3–5 MB/day/device for telemetry
--   On a ~500 MB DB budget (typical free-tier ballpark; check your plan):
--     telemetry-only → order of ~100–150 days before you are in trouble IF nothing
--     else uses space. With other tables, geofences, auth, etc., plan shorter
--     retention (e.g. 30–90 days) or upgrade.
--
-- HOW TO RUN
-- 1) Supabase Dashboard → SQL Editor → paste and run this file once.
-- 2) Schedule repeats:
--    - Pro / Team: enable extension `pg_cron`, then uncomment the block at bottom.
--    - Free: run `SELECT public.prune_telemetry_older_than(90);` weekly from SQL
--      Editor, or use an external cron (GitHub Actions, etc.) calling the REST API
--      with service_role (Edge Function that runs DELETE is another option).
--
-- The function uses SECURITY DEFINER so it can delete regardless of RLS (runs as owner).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.prune_telemetry_older_than(p_days integer DEFAULT 90)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  IF p_days < 1 THEN
    RAISE EXCEPTION 'p_days must be >= 1';
  END IF;

  DELETE FROM public.telemetry
  WHERE created_at < (timezone('utc', now()) - make_interval(days => p_days));

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.prune_telemetry_older_than(integer) IS
  'Deletes telemetry rows older than p_days (UTC). Returns number of rows removed.';

REVOKE ALL ON FUNCTION public.prune_telemetry_older_than(integer) FROM PUBLIC;
-- Service role can call via RPC if you automate; postgres/cron use superuser path.
GRANT EXECUTE ON FUNCTION public.prune_telemetry_older_than(integer) TO service_role;

-- Optional: run once manually to verify
-- SELECT public.prune_telemetry_older_than(90);

-- -----------------------------------------------------------------------------
-- Optional: nightly job (enable "pg_cron" under Database → Extensions first).
-- Not available on all plans; remove if extension missing.
-- -----------------------------------------------------------------------------
-- SELECT cron.schedule(
--   'prune-telemetry-nightly',
--   '0 4 * * *',
--   $$SELECT public.prune_telemetry_older_than(90);$$
-- );
