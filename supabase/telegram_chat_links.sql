-- Allow linking multiple Telegram chats (DM + groups) to one user.
-- Run this in Supabase SQL editor once.

CREATE TABLE IF NOT EXISTS public.user_telegram_chats (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (user_id, chat_id)
);

-- Prevent the same chat being linked to multiple accounts (security/privacy).
CREATE UNIQUE INDEX IF NOT EXISTS user_telegram_chats_chat_id_unique
  ON public.user_telegram_chats (chat_id);

ALTER TABLE public.user_telegram_chats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their telegram chats" ON public.user_telegram_chats;
CREATE POLICY "Users can manage their telegram chats"
ON public.user_telegram_chats FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Optional backfill from the legacy single-value column.
-- Safe to run repeatedly.
INSERT INTO public.user_telegram_chats (user_id, chat_id)
SELECT user_id, telegram_chat_id
FROM public.user_settings
WHERE telegram_chat_id IS NOT NULL AND length(trim(telegram_chat_id)) > 0
ON CONFLICT DO NOTHING;

