-- Allow dashboard users to UPDATE their claimed device rows (speed_limit, fuel_rate, fuel_type).
-- Without this policy, RLS blocks UPDATE and trip defaults never persist for max speed / consumption.
-- Run once in Supabase SQL Editor if user_devices already has RLS from rls_setup.sql.

DROP POLICY IF EXISTS "Users can update their own device claims" ON public.user_devices;

CREATE POLICY "Users can update their own device claims"
ON public.user_devices FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
