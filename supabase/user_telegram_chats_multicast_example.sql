-- Optional: attach multiple Telegram chats (DM + group) to one dashboard user.
-- The telegram-alerts edge function sends speed, zone enter/leave, and gate messages to
-- every row in user_telegram_chats for that user_id, plus legacy user_settings.telegram_chat_id.
--
-- Replace YOUR_USER_UUID with the auth user that OWNS the device (see user_devices.user_id).
-- Group IDs are often negative strings (e.g. -5136324257).

INSERT INTO public.user_telegram_chats (user_id, chat_id)
VALUES
  ('YOUR_USER_UUID'::uuid, '-5136324257'),
  ('YOUR_USER_UUID'::uuid, '1519716896')
ON CONFLICT (user_id, chat_id) DO NOTHING;
