-- Add ETA / route-mode columns to user_settings if you see:
--   Settings save error (400) on .../user_settings
-- Safe to run multiple times (IF NOT EXISTS).

ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS eta_highway_over_limit_kmh double precision DEFAULT 20,
  ADD COLUMN IF NOT EXISTS eta_urban_over_limit_kmh double precision DEFAULT 10;

ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS eta_duration_mode text DEFAULT 'personalized';

COMMENT ON COLUMN public.user_settings.eta_highway_over_limit_kmh IS
  'Added to posted limit on highway segments for personalized route ETA.';
COMMENT ON COLUMN public.user_settings.eta_urban_over_limit_kmh IS
  'Added to posted limit on town segments for personalized route ETA.';
COMMENT ON COLUMN public.user_settings.eta_duration_mode IS
  'mapbox | personalized — how route travel time is computed.';
