-- Optional ETA personalization: km/h above posted limit by road class (Mapbox maxspeed annotations).
-- Run in Supabase SQL editor once.

ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS eta_highway_over_limit_kmh double precision DEFAULT 20,
  ADD COLUMN IF NOT EXISTS eta_urban_over_limit_kmh double precision DEFAULT 10;

COMMENT ON COLUMN public.user_settings.eta_highway_over_limit_kmh IS 'Added to posted limit on segments with limit >= 90 km/h (or unlimited) for personalized route ETA.';
COMMENT ON COLUMN public.user_settings.eta_urban_over_limit_kmh IS 'Added to posted limit on lower-speed (town) segments for personalized route ETA.';
