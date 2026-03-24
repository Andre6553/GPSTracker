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

Deno.serve(async (req: Request) => {
  try {
    const payload = await req.json();
    const { device_id, lat, lon, speed_kmh } = payload.record as TelemetryPayload;

    // 1. Find the owner and their settings
    const { data: deviceOwner } = await supabase
      .from('user_devices')
      .select('user_id, speed_limit, last_speed_alert_sent')
      .eq('device_id', device_id)
      .single();

    if (!deviceOwner) return new Response('Device not claimed');

    const { data: userSettings } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', deviceOwner.user_id)
      .single();

    if (!userSettings || !userSettings.telegram_chat_id) return new Response('No Telegram link');

    const chat_id = userSettings.telegram_chat_id;

    // 2. SPEED ALERTS
    if (userSettings.speed_alerts_enabled && speed_kmh > deviceOwner.speed_limit) {
      const now = new Date();
      const lastSent = deviceOwner.last_speed_alert_sent ? new Date(deviceOwner.last_speed_alert_sent) : null;
      
      // Throttle speed alerts to once every 5 minutes
      if (!lastSent || (now.getTime() - lastSent.getTime()) > 5 * 60 * 1000) {
        await sendTelegram(chat_id, `🚨 *Speed Alert: ${device_id}*\nCurrent Speed: ${speed_kmh.toFixed(0)} km/h\nLimit: ${deviceOwner.speed_limit} km/h`);
        await supabase
          .from('user_devices')
          .update({ last_speed_alert_sent: now.toISOString() })
          .eq('device_id', device_id);
      }
    }

    // 3. GEOFENCE ALERTS
    if (userSettings.geofence_alerts_enabled) {
      const { data: geofences } = await supabase
        .from('geofences')
        .select('*')
        .eq('user_id', deviceOwner.user_id);

      for (const zone of geofences || []) {
        const isInside = haversineKm(lat, lon, zone.lat, zone.lon) * 1000 <= zone.radius_meters;
        
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
          await sendTelegram(chat_id, `${emoji} *Zone Alert: ${device_id}*\nHas ${action} the zone: *${zone.name}*`);
          
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
