-- Route ETA source: Mapbox Directions duration vs personalized (posted limits + offsets).
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS eta_duration_mode text DEFAULT 'personalized';

COMMENT ON COLUMN public.user_settings.eta_duration_mode IS
  'Route travel time: mapbox = Mapbox Directions duration (traffic-aware, scaled by trip Max Speed); personalized = recomputed from maxspeed annotations + highway/town offsets.';
