-- =============================================================================
-- Delete ONLY today's telemetry rows (UTC day window)
-- =============================================================================
-- Use this in Supabase SQL Editor when you want to purge today's points.
--
-- Safety workflow:
--   1) Run the PREVIEW queries first
--   2) If counts look correct, run the DELETE block
--
-- NOTE:
--   "Today" below is UTC midnight -> next UTC midnight.
--   If you prefer local timezone boundaries, replace timezone('utc', now())
--   with timezone('Africa/Johannesburg', now()) (or your timezone).
-- =============================================================================

-- -------------------------
-- PREVIEW (all devices)
-- -------------------------
SELECT count(*) AS rows_today_utc
FROM public.telemetry
WHERE created_at >= date_trunc('day', timezone('utc', now()))
  AND created_at <  date_trunc('day', timezone('utc', now())) + interval '1 day';

-- Optional preview by device:
-- SELECT device_id, count(*) AS rows_today_utc
-- FROM public.telemetry
-- WHERE created_at >= date_trunc('day', timezone('utc', now()))
--   AND created_at <  date_trunc('day', timezone('utc', now())) + interval '1 day'
-- GROUP BY device_id
-- ORDER BY rows_today_utc DESC;

-- -------------------------
-- DELETE (all devices)
-- -------------------------
-- BEGIN;
-- DELETE FROM public.telemetry
-- WHERE created_at >= date_trunc('day', timezone('utc', now()))
--   AND created_at <  date_trunc('day', timezone('utc', now())) + interval '1 day';
-- COMMIT;

-- -------------------------
-- DELETE (single device) - optional
-- -------------------------
-- BEGIN;
-- DELETE FROM public.telemetry
-- WHERE device_id = 'Andre'
--   AND created_at >= date_trunc('day', timezone('utc', now()))
--   AND created_at <  date_trunc('day', timezone('utc', now())) + interval '1 day';
-- COMMIT;

