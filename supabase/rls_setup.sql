-- Enable RLS on user_devices
ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;

-- Clean up existing policies to avoid "already exists" errors
DROP POLICY IF EXISTS "Users can insert their own device claims" ON public.user_devices;
DROP POLICY IF EXISTS "Users can view their own device claims" ON public.user_devices;
DROP POLICY IF EXISTS "Users can delete their own device claims" ON public.user_devices;

-- Users can insert their own claims
CREATE POLICY "Users can insert their own device claims" 
ON public.user_devices FOR INSERT 
WITH CHECK (auth.uid() = user_id);

-- Users can view their own claims
CREATE POLICY "Users can view their own device claims" 
ON public.user_devices FOR SELECT 
USING (auth.uid() = user_id);

-- Users can delete their own claims
CREATE POLICY "Users can delete their own device claims" 
ON public.user_devices FOR DELETE 
USING (auth.uid() = user_id);


-- Enable RLS on telemetry
ALTER TABLE public.telemetry ENABLE ROW LEVEL SECURITY;

-- Clean up existing telemetry policies
DROP POLICY IF EXISTS "Anyone can insert telemetry (Devices)" ON public.telemetry;
DROP POLICY IF EXISTS "Users can read telemetry for owned devices" ON public.telemetry;
DROP POLICY IF EXISTS "Users can delete telemetry for owned devices" ON public.telemetry;

-- Devices (using Anon Key) can insert telemetry without restrictions
CREATE POLICY "Anyone can insert telemetry (Devices)" 
ON public.telemetry FOR INSERT 
WITH CHECK (true);

-- Dashboard Users can ONLY read telemetry for devices they have claimed
CREATE POLICY "Users can read telemetry for owned devices" 
ON public.telemetry FOR SELECT 
USING (
  EXISTS (
    SELECT 1 FROM public.user_devices
    WHERE user_devices.device_id = telemetry.device_id
    AND user_devices.user_id = auth.uid()
  )
);

-- Dashboard Users can DELETE telemetry for devices they have claimed
CREATE POLICY "Users can delete telemetry for owned devices" 
ON public.telemetry FOR DELETE 
USING (
  EXISTS (
    SELECT 1 FROM public.user_devices
    WHERE user_devices.device_id = telemetry.device_id
    AND user_devices.user_id = auth.uid()
  )
);
