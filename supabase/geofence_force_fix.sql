-- Geofence Persistence Force Fix
-- Part 1: Ensure Table Exists with Correct Schema
CREATE TABLE IF NOT EXISTS public.geofences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    radius_meters INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Part 2: Enable Row Level Security (RLS)
ALTER TABLE public.geofences ENABLE ROW LEVEL SECURITY;

-- Part 3: Management Policy
-- This policy allows users to see, add, and delete ONLY their own geofences.
DROP POLICY IF EXISTS "Users can manage their own geofences" ON public.geofences;
CREATE POLICY "Users can manage their own geofences" 
ON public.geofences FOR ALL 
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
