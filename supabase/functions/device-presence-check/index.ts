import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PRESENCE_CHECK_SECRET = (Deno.env.get('PRESENCE_CHECK_SECRET') ?? '').trim();
const OFFLINE_THRESHOLD_SEC = Number(Deno.env.get('OFFLINE_THRESHOLD_SEC') ?? '300');
const SCAN_LIMIT = Number(Deno.env.get('OFFLINE_SCAN_LIMIT') ?? '500');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function isAuthorized(req: Request): boolean {
  if (!PRESENCE_CHECK_SECRET) return true;
  const auth = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${PRESENCE_CHECK_SECRET}`;
  return auth === expected;
}

async function sendTelegram(chatId: string, text: string) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

async function resolveTelegramChatIds(userId: string, legacyChatId: unknown): Promise<string[]> {
  const { data: rows } = await supabase
    .from('user_telegram_chats')
    .select('chat_id')
    .eq('user_id', userId);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows ?? []) {
    const id = r.chat_id != null ? String(r.chat_id).trim() : '';
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  const leg = legacyChatId != null ? String(legacyChatId).trim() : '';
  if (leg && !seen.has(leg)) out.push(leg);
  return out;
}

async function sendTelegramBroadcast(chatIds: string[], text: string) {
  await Promise.allSettled(chatIds.map((id) => sendTelegram(id, text)));
}

Deno.serve(async (req: Request) => {
  try {
    if (!isAuthorized(req)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const cutoff = new Date(Date.now() - OFFLINE_THRESHOLD_SEC * 1000).toISOString();
    const { data: rows, error } = await supabase
      .from('user_devices')
      .select('user_id, device_id, last_seen_at, offline_alert_sent')
      .not('last_seen_at', 'is', null)
      .lt('last_seen_at', cutoff)
      .eq('offline_alert_sent', false)
      .limit(SCAN_LIMIT);

    if (error) {
      console.error('device-presence-check query failed', error.message);
      return new Response(error.message, { status: 500 });
    }

    let notified = 0;
    for (const row of rows ?? []) {
      const userId = String(row.user_id);
      const deviceId = String(row.device_id);

      const { data: settings } = await supabase
        .from('user_settings')
        .select('telegram_chat_id')
        .eq('user_id', userId)
        .maybeSingle();

      const chatIds = await resolveTelegramChatIds(userId, settings?.telegram_chat_id ?? null);
      if (chatIds.length > 0) {
        const agoSec = Math.max(0, Math.floor((Date.now() - Date.parse(String(row.last_seen_at))) / 1000));
        const mins = Math.max(1, Math.floor(agoSec / 60));
        await sendTelegramBroadcast(
          chatIds,
          `⚠️ *Device Offline*\nDevice: *${deviceId}*\nNo telemetry for ${mins} min.`,
        );
      }

      await supabase
        .from('user_devices')
        .update({ offline_alert_sent: true })
        .eq('user_id', userId)
        .eq('device_id', deviceId);
      notified += 1;
    }

    return new Response(JSON.stringify({ ok: true, scanned: rows?.length ?? 0, notified }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(message, { status: 500 });
  }
});
