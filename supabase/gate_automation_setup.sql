-- Gate automation state table (reliable arrival detection)
CREATE TABLE IF NOT EXISTS public.device_gate_state (
  user_id uuid NOT NULL,
  device_id text NOT NULL,
  status text NOT NULL DEFAULT 'HOME',
  outside_since timestamptz NULL,
  driving_since timestamptz NULL,
  inside_streak integer NOT NULL DEFAULT 0,
  last_distance_m double precision NULL,
  last_trigger_at timestamptz NULL,
  cooldown_until timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id)
);

ALTER TABLE public.device_gate_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read their own gate state" ON public.device_gate_state;
CREATE POLICY "Users can read their own gate state"
ON public.device_gate_state
FOR SELECT
USING (auth.uid() = user_id);

-- Service role / edge function writes state.
DROP POLICY IF EXISTS "Service role can manage gate state" ON public.device_gate_state;
CREATE POLICY "Service role can manage gate state"
ON public.device_gate_state
FOR ALL
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');
