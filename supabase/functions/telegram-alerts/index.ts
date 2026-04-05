import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

interface TelemetryPayload {
  device_id: string;
  lat: number;
  lon: number;
  speed_kmh: number;
}

/** DB webhooks usually send `{ record: row }`; some stacks use `new` or the row at top level. */
function parseTelemetryRecord(body: unknown): TelemetryPayload | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  let row: Record<string, unknown>;
  if (b.record && typeof b.record === 'object') row = b.record as Record<string, unknown>;
  else if (b.new && typeof b.new === 'object') row = b.new as Record<string, unknown>;
  else row = b;

  const device_id = row.device_id != null ? String(row.device_id) : '';
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  const speed_kmh = Number(row.speed_kmh);
  if (!device_id || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    device_id,
    lat,
    lon,
    speed_kmh: Number.isFinite(speed_kmh) ? speed_kmh : 0,
  };
}

type GateStatus = 'HOME' | 'AWAY_PENDING' | 'AWAY_CONFIRMED' | 'RETURNING' | 'TRIGGERED_COOLDOWN';

interface GateStateRow {
  user_id: string;
  device_id: string;
  status: GateStatus;
  outside_since: string | null;
  driving_since: string | null;
  inside_streak: number;
  last_distance_m: number | null;
  last_trigger_at: string | null;
  cooldown_until: string | null;
}

const OUTER_RADIUS_OFFSET_M = Number(Deno.env.get('OUTER_RADIUS_OFFSET_M') ?? '250');
const MIN_DRIVE_SPEED_KMH = Number(Deno.env.get('MIN_DRIVE_SPEED_KMH') ?? '12');
const MIN_OUTSIDE_SEC = Number(Deno.env.get('MIN_OUTSIDE_SEC') ?? '300');
const MIN_DRIVE_SEC = Number(Deno.env.get('MIN_DRIVE_SEC') ?? '30');
/**
 * Inside-inner pings required before auto gate fire. Each increment needs a **telemetry INSERT**
 * that runs this edge function. The DB trigger `skip_telemetry_inside_home_geofence` keeps only
 * the first inside-Home row per return (then drops jitter), so values > 1 never accumulate in
 * practice — auto gate would never open. Default 1; set higher only if you disable that skip or
 * allow multiple inside rows per visit.
 */
const _entryConfirmEnv = Number(Deno.env.get('ENTRY_CONFIRM_POINTS') ?? '1');
const ENTRY_CONFIRM_POINTS =
  Number.isFinite(_entryConfirmEnv) && _entryConfirmEnv >= 1 ? Math.floor(_entryConfirmEnv) : 1;
if (ENTRY_CONFIRM_POINTS > 1) {
  console.warn(
    `telegram-alerts: ENTRY_CONFIRM_POINTS=${ENTRY_CONFIRM_POINTS} — with home telemetry skip, only ~1 inside row is stored per return; auto gate may never open. Remove the secret or set ENTRY_CONFIRM_POINTS=1.`,
  );
}
const COOLDOWN_SEC = Number(Deno.env.get('COOLDOWN_SEC') ?? '900');

const GATE_AUTOMATION_ENABLED = (Deno.env.get('GATE_AUTOMATION_ENABLED') ?? 'true') === 'true';
/** Same HA webhook URL as Vercel `HOME_ASSISTANT_GATE_WEBHOOK_URL` (`/trigger_gate_*`). On auto-trigger we POST here immediately (like manual pulse). Set `GATE_EDGE_WEBHOOK_NOTIFY=false` to skip and rely only on HA REST polling `TRIGGERED_COOLDOWN`. */
const HOME_ASSISTANT_GATE_WEBHOOK_URL = (Deno.env.get('HOME_ASSISTANT_GATE_WEBHOOK_URL') ?? '').trim();
const GATE_EDGE_WEBHOOK_DISABLED = (Deno.env.get('GATE_EDGE_WEBHOOK_NOTIFY') ?? '').trim().toLowerCase() === 'false';

/** All chats for alerts: `user_telegram_chats` rows plus legacy `user_settings.telegram_chat_id` (deduped). */
async function resolveTelegramChatIds(userId: string, legacyChatId: unknown): Promise<string[]> {
  const { data: rows, error } = await supabase
    .from('user_telegram_chats')
    .select('chat_id')
    .eq('user_id', userId);
  if (error) console.warn('telegram-alerts: user_telegram_chats read failed', error.message);

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
  if (leg && !seen.has(leg)) {
    seen.add(leg);
    out.push(leg);
  }
  return out;
}

async function sendTelegramBroadcast(chatIds: string[], text: string) {
  await Promise.allSettled(chatIds.map((id) => sendTelegram(id, text)));
}

Deno.serve(async (req: Request) => {
  try {
    const payload = await req.json();
    const parsed = parseTelemetryRecord(payload);
    if (!parsed) {
      console.warn('telegram-alerts: bad payload', JSON.stringify(payload).slice(0, 400));
      return new Response('Bad payload: expected device_id, lat, lon', { status: 400 });
    }
    const { device_id, lat, lon, speed_kmh } = parsed;
    console.log("telegram-alerts hit", device_id, lat, lon, speed_kmh);

    // 1. Find the owner and their settings (avoid .single() — duplicate device_id breaks alerts)
    const { data: deviceRows, error: deviceRowsErr } = await supabase
      .from('user_devices')
      .select('user_id, speed_limit, last_speed_alert_sent')
      .eq('device_id', device_id);
    if (deviceRowsErr || !deviceRows?.length) {
      return new Response('Device not claimed', { status: 404 });
    }
    deviceRows.sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)));
    if (deviceRows.length > 1) {
      console.warn(
        `telegram-alerts: ${deviceRows.length} user_devices rows for ${device_id} — using user_id=${deviceRows[0].user_id} (stable sort). Deduplicate for consistent geofence status.`,
      );
    }
    const deviceOwner = deviceRows[0];

    const { data: userSettings } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', deviceOwner.user_id)
      .single();

    if (!userSettings) return new Response('No user_settings row');

    const chatIds = await resolveTelegramChatIds(deviceOwner.user_id, userSettings.telegram_chat_id);
    if (chatIds.length === 0) return new Response('No Telegram link (add user_telegram_chats or telegram_chat_id)');

    // Match dashboard semantics (src/app/page.tsx): NULL / missing => alerts ON; only explicit false disables.
    const speedAlertsOn = userSettings.speed_alerts_enabled !== false;
    const geofenceAlertsOn = userSettings.geofence_alerts_enabled !== false;

    // 2. SPEED ALERTS
    if (speedAlertsOn && speed_kmh > deviceOwner.speed_limit) {
      const now = new Date();
      const lastSent = deviceOwner.last_speed_alert_sent ? new Date(deviceOwner.last_speed_alert_sent) : null;
      
      // Throttle speed alerts to once every 5 minutes
      if (!lastSent || (now.getTime() - lastSent.getTime()) > 5 * 60 * 1000) {
        await sendTelegramBroadcast(
          chatIds,
          `🚨 *Speed Alert: ${device_id}*\nCurrent Speed: ${speed_kmh.toFixed(0)} km/h\nLimit: ${deviceOwner.speed_limit} km/h`,
        );
        await supabase
          .from('user_devices')
          .update({ last_speed_alert_sent: now.toISOString() })
          .eq('device_id', device_id);
      }
    }

    // 3. GEOFENCE ALERTS & HOME LOOKUP
    const { data: geofences } = await supabase
      .from('geofences')
      .select('*')
      .eq('user_id', deviceOwner.user_id);

    let homeZone: any = null;

    for (const zone of geofences || []) {
      // Same name rule as skip_telemetry_inside_home_geofence (trim + case-insensitive).
      const zoneName = typeof zone.name === 'string' ? zone.name.trim().toLowerCase() : '';
      if (zoneName === 'home') {
        homeZone = zone;
      }

      if (geofenceAlertsOn) {
        const zLat = Number(zone.lat);
        const zLon = Number(zone.lon);
        const radiusM = Number(zone.radius_meters);
        if (!Number.isFinite(zLat) || !Number.isFinite(zLon) || !Number.isFinite(radiusM)) {
          console.warn('telegram-alerts: skipping geofence with bad coords', zone.id, zone.name);
          continue;
        }
        const isInside = haversineKm(lat, lon, zLat, zLon) * 1000 <= radiusM;
        
        // Get previous status
        const { data: statusRecord } = await supabase
          .from('device_geofence_status')
          .select('is_inside')
          .eq('device_id', device_id)
          .eq('geofence_id', zone.id)
          .maybeSingle();

        const wasInside = statusRecord?.is_inside || false;

        if (isInside !== wasInside) {
          const action = isInside ? "ENTERED" : "LEFT";
          const emoji = isInside ? "🚩" : "✅";
          await sendTelegramBroadcast(
            chatIds,
            `${emoji} *Zone Alert: ${device_id}*\nHas ${action} the zone: *${zone.name}*`,
          );
          
          await supabase
            .from('device_geofence_status')
            .upsert({
              user_id: deviceOwner.user_id,
              device_id: device_id,
              geofence_id: zone.id,
              is_inside: isInside,
              last_status_change: new Date().toISOString()
            }, { onConflict: 'device_id,geofence_id' });
        }
      }
    }

    // 4. GATE AUTOMATION (Multi-Tenant dynamic device trigger)
    if (GATE_AUTOMATION_ENABLED && homeZone) {
      const hLat = Number(homeZone.lat);
      const hLon = Number(homeZone.lon);
      const hR = Number(homeZone.radius_meters);
      if (Number.isFinite(hLat) && Number.isFinite(hLon) && Number.isFinite(hR)) {
        await processGateAutomation({
          userId: deviceOwner.user_id,
          deviceId: device_id,
          lat,
          lon,
          speedKmh: speed_kmh,
          chatIds,
          homeLat: hLat,
          homeLon: hLon,
          innerRadiusM: hR,
          outerRadiusM: hR + OUTER_RADIUS_OFFSET_M,
        });
      }
    }

    return new Response('OK');
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(message, { status: 500 });
  }
});

async function sendTelegram(chatId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  });
}

/** Plain POST — matches Vercel `executeGatePulseFlexible` → HA webhook. */
async function pulseHomeAssistantGateWebhook(url: string): Promise<{ ok: boolean; detail: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Accept: '*/*', 'User-Agent': 'supabase-telegram-alerts-gate-pulse/1' },
      signal: ctrl.signal,
    });
    if (res.ok) return { ok: true, detail: 'HTTP ' + res.status };
    const text = (await res.text()).slice(0, 200);
    return { ok: false, detail: text || `${res.status} ${res.statusText}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: msg };
  } finally {
    clearTimeout(t);
  }
}

async function processGateAutomation(params: {
  userId: string;
  deviceId: string;
  lat: number;
  lon: number;
  speedKmh: number;
  chatIds: string[];
  homeLat: number;
  homeLon: number;
  innerRadiusM: number;
  outerRadiusM: number;
}) {
  const { userId, deviceId, lat, lon, speedKmh, chatIds, homeLat, homeLon, innerRadiusM, outerRadiusM } = params;
  const now = new Date();
  const distM = haversineKm(lat, lon, homeLat, homeLon) * 1000;
  const isInsideInner = distM <= innerRadiusM;
  const isOutsideOuter = distM > outerRadiusM;
  const isDriving = speedKmh >= MIN_DRIVE_SPEED_KMH;

  const { data: row } = await supabase
    .from('device_gate_state')
    .select('*')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();

  const state: GateStateRow = row ?? {
    user_id: userId,
    device_id: deviceId,
    status: 'HOME',
    outside_since: null,
    driving_since: null,
    inside_streak: 0,
    last_distance_m: null,
    last_trigger_at: null,
    cooldown_until: null,
  };

  const inCooldown = !!state.cooldown_until && now < new Date(state.cooldown_until);
  if (inCooldown) {
    state.status = 'TRIGGERED_COOLDOWN';
    state.last_distance_m = distM;
    state.inside_streak = isInsideInner ? Math.min(state.inside_streak + 1, ENTRY_CONFIRM_POINTS) : 0;
    await saveGateState(state);
    return;
  }

  if (state.status === 'TRIGGERED_COOLDOWN' && !inCooldown) {
    state.status = isInsideInner ? 'HOME' : 'AWAY_PENDING';
  }

  if (isOutsideOuter) {
    if (state.status === 'HOME' || state.status === 'TRIGGERED_COOLDOWN') {
      state.status = 'AWAY_PENDING';
      state.outside_since = now.toISOString();
      state.driving_since = isDriving ? now.toISOString() : null;
    }
    
    if (state.status === 'AWAY_PENDING') {
      if (!state.outside_since) state.outside_since = now.toISOString();
      if (isDriving) {
        if (!state.driving_since) state.driving_since = now.toISOString();
      } else {
        state.driving_since = null;
      }

      const outsideSec = state.outside_since ? elapsedSeconds(state.outside_since, now) : 0;
      const drivingSec = state.driving_since ? elapsedSeconds(state.driving_since, now) : 0;
      
      if (outsideSec >= MIN_OUTSIDE_SEC && drivingSec >= MIN_DRIVE_SEC) {
        state.status = 'AWAY_CONFIRMED';
        await sendTelegramBroadcast(
          chatIds,
          `🟢 *Geofence Armed*\nDevice: *${deviceId}*\nSystem is locked and ready to trigger the gate upon your return! 🚗`,
        );
      }
    }
    state.inside_streak = 0;
  } else if (state.status === 'AWAY_PENDING' && !isInsideInner) {
    // Between inner and outer radius, keep pending and wait for clear movement context.
    state.inside_streak = 0;
  }

  if ((state.status === 'AWAY_CONFIRMED' || state.status === 'RETURNING') && !isInsideInner) {
    if (isDriving && state.last_distance_m !== null && distM < state.last_distance_m - 5) {
      state.status = 'RETURNING';
    }
  }

  let triggered = false;
  if ((state.status === 'AWAY_CONFIRMED' || state.status === 'RETURNING') && isInsideInner) {
    state.inside_streak += 1;
    if (state.inside_streak >= ENTRY_CONFIRM_POINTS) {
      // Drive gate from Home Assistant: set DB state only. HA polls `device_gate_state` and pulses the relay.
      // Do NOT depend on Vercel/eWeLink or Telegram commands here (avoids ewelink-api / spam on failure).
      triggered = true;
      state.last_trigger_at = now.toISOString();
      state.cooldown_until = new Date(now.getTime() + COOLDOWN_SEC * 1000).toISOString();
      state.status = 'TRIGGERED_COOLDOWN';
      state.outside_since = null;
      state.driving_since = null;

      const gateCmdSlug = deviceId.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'device';
      let pulseLine = '';
      if (HOME_ASSISTANT_GATE_WEBHOOK_URL && !GATE_EDGE_WEBHOOK_DISABLED) {
        const pulse = await pulseHomeAssistantGateWebhook(HOME_ASSISTANT_GATE_WEBHOOK_URL);
        if (pulse.ok) {
          pulseLine = `\n✅ *HA webhook pulse* (same as \`/trigger_gate_${gateCmdSlug}\`): ok`;
        } else {
          pulseLine = `\n⚠️ *HA webhook pulse failed:* ${pulse.detail.replace(/[\n`]/g, ' ')}`;
          console.error('HOME_ASSISTANT_GATE_WEBHOOK_URL pulse failed', pulse.detail);
        }
      }

      await sendTelegramBroadcast(
        chatIds,
        `🚪 *Gate triggered*\nDevice: *${deviceId}*\nSensor \`TRIGGERED_COOLDOWN\` + optional instant pulse${pulseLine}\nDistance: ${distM.toFixed(0)}m · Speed: ${speedKmh.toFixed(1)} km/h`,
      );
    }
  } else if (isInsideInner) {
    state.status = 'HOME';
    state.inside_streak = Math.min(state.inside_streak + 1, ENTRY_CONFIRM_POINTS);
  } else {
    state.inside_streak = 0;
  }

  if (!triggered && state.status === 'RETURNING' && !isDriving && !isInsideInner) {
    // Pause return flow if movement stops far from home.
    state.status = 'AWAY_CONFIRMED';
  }

  state.last_distance_m = distM;
  await saveGateState(state);
}

async function saveGateState(state: GateStateRow) {
  await supabase.from('device_gate_state').upsert({
    user_id: state.user_id,
    device_id: state.device_id,
    status: state.status,
    outside_since: state.outside_since,
    driving_since: state.driving_since,
    inside_streak: state.inside_streak,
    last_distance_m: state.last_distance_m,
    last_trigger_at: state.last_trigger_at,
    cooldown_until: state.cooldown_until,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,device_id' });
}

function elapsedSeconds(iso: string, now: Date): number {
  const t = new Date(iso).getTime();
  return Math.max(0, Math.floor((now.getTime() - t) / 1000));
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
