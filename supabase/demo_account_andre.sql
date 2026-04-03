-- Demo dashboard login: demo@demo.com / password: demo12345 — device "Andre".
-- Run in Supabase SQL Editor as postgres (or service role). Prefer scripts/create-demo-user.mjs with the
-- service role key if your auth schema differs slightly from this template.
--
-- Idempotent: removes prior demo@demo.com auth rows and user_devices links, then recreates.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$
DECLARE
  v_user_id uuid := gen_random_uuid();
  v_encrypted_pw text := crypt('demo12345', gen_salt('bf'));
BEGIN
  DELETE FROM public.user_devices
  WHERE user_id IN (SELECT id FROM auth.users WHERE email = 'demo@demo.com');

  DELETE FROM auth.identities
  WHERE user_id IN (SELECT id FROM auth.users WHERE email = 'demo@demo.com');

  DELETE FROM auth.users WHERE email = 'demo@demo.com';

  INSERT INTO auth.users (
    id,
    instance_id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
  )
  VALUES (
    v_user_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'demo@demo.com',
    v_encrypted_pw,
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"demo":true,"label":"dashboard-demo"}'::jsonb,
    now(),
    now()
  );

  INSERT INTO auth.identities (
    id,
    user_id,
    identity_data,
    provider,
    provider_id,
    last_sign_in_at,
    created_at,
    updated_at
  )
  VALUES (
    gen_random_uuid(),
    v_user_id,
    jsonb_build_object('sub', v_user_id::text, 'email', 'demo@demo.com'),
    'email',
    v_user_id::text,
    now(),
    now(),
    now()
  );

  INSERT INTO public.user_devices (user_id, device_id)
  VALUES (v_user_id, 'Andre');
END $$;
