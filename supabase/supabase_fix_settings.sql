-- Ensure user_settings exists with correct constraints for UPSERT
CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  fuel_cost DOUBLE PRECISION DEFAULT 22.50,
  telegram_chat_id TEXT,
  speed_alerts_enabled BOOLEAN DEFAULT true,
  geofence_alerts_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

-- Policy to allow users to manage their own settings (SELECT, INSERT, UPDATE)
DROP POLICY IF EXISTS "Users can manage their own settings" ON public.user_settings;
CREATE POLICY "Users can manage their own settings" 
ON public.user_settings FOR ALL 
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Optional: If the table already existed but user_id was NOT the primary key
-- ALTER TABLE public.user_settings ADD PRIMARY KEY (user_id);
