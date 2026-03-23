-- Telegram Alert Engine Setup
-- Part 1: Geofence State Tracking

CREATE TABLE IF NOT EXISTS public.device_geofence_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  geofence_id UUID REFERENCES public.geofences(id) ON DELETE CASCADE,
  is_inside BOOLEAN DEFAULT false,
  last_status_change TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  UNIQUE(device_id, geofence_id)
);

-- Enable RLS
ALTER TABLE public.device_geofence_status ENABLE ROW LEVEL SECURITY;

-- Management Policy
DROP POLICY IF EXISTS "Users can view geofence status" ON public.device_geofence_status;
CREATE POLICY "Users can view geofence status" 
ON public.device_geofence_status FOR ALL 
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);


-- Part 2: Speed Alert Throttling
-- We add a column to user_devices to track when the last alert was sent.
ALTER TABLE public.user_devices 
ADD COLUMN IF NOT EXISTS last_speed_alert_sent TIMESTAMP WITH TIME ZONE;
