-- Final, Forceful Fix for user_settings constraints
-- This will DROP and RECREATE the table to ensure the schema is 100% correct.
-- Note: Your settings (Fuel Price, etc) will be reset to defaults.

DROP TABLE IF EXISTS public.user_settings CASCADE;

CREATE TABLE public.user_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  fuel_cost DOUBLE PRECISION DEFAULT 22.50,
  telegram_chat_id TEXT,
  speed_alerts_enabled BOOLEAN DEFAULT true,
  geofence_alerts_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

-- Management Policy
CREATE POLICY "Users can manage their own settings" 
ON public.user_settings FOR ALL 
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
