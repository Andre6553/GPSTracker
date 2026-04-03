-- Optional: attach multiple Telegram chats (DM + group) to the dashboard user who owns a tracker.
-- The telegram-alerts edge function sends speed, zone enter/leave, and gate messages to
-- every row in user_telegram_chats for that user_id, plus legacy user_settings.telegram_chat_id.
--
-- Run in Supabase → SQL Editor. Edit v_device_id below to match your tracker name in user_devices.

DO $$
DECLARE
  v_device_id text := 'Andre';  -- same string as "Link New Device" / telemetry device_id
  uid uuid;
BEGIN
  SELECT user_id INTO uid
  FROM public.user_devices
  WHERE device_id = v_device_id
  LIMIT 1;

  IF uid IS NULL THEN
    RAISE EXCEPTION
      'No row in user_devices for device_id = %. Link the device in the dashboard first, or change v_device_id in this script.',
      v_device_id;
  END IF;

  INSERT INTO public.user_telegram_chats (user_id, chat_id)
  VALUES
    (uid, '-5136324257'),
    (uid, '1519716896')
  ON CONFLICT (user_id, chat_id) DO NOTHING;
END $$;

-- Manual alternative (only if you prefer to paste a UUID — use your real auth.users id):
-- INSERT INTO public.user_telegram_chats (user_id, chat_id)
-- VALUES
--   ('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, '-5136324257'),
--   ('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, '1519716896')
-- ON CONFLICT (user_id, chat_id) DO NOTHING;
