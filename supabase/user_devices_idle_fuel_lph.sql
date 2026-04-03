-- Liters per hour burned while idling / crawling (speed ≤5 km/h in today's stats). Used for fuel cost estimate.
-- Without this column, the dashboard still loads (defaults 0.8 L/h) but saving Trip defaults may error until applied.
-- Safe to run multiple times.

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS idle_fuel_lph double precision DEFAULT 0.8;

COMMENT ON COLUMN public.user_devices.idle_fuel_lph IS
  'Estimated fuel burn (L/h) when stationary or in slow traffic; multiplied by "Idle Today" time for cost.';
