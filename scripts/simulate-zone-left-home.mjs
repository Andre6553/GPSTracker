/**
 * Simulate "✅ Zone Alert: … Has LEFT the zone: Home" by:
 *   1) Upserting device_geofence_status (Home) to is_inside = true
 *   2) POSTing telegram-alerts with GPS clearly outside the Home radius
 *
 * Same payload shape as the DB webhook on telemetry inserts.
 *
 * Env (.env.local):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SIMULATE_USER_ID
 *   SIMULATE_DEVICE_ID or pass device_id as first argument
 *
 * Usage:
 *   node scripts/simulate-zone-left-home.mjs
 *   node scripts/simulate-zone-left-home.mjs Andre
 */
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const envPath = path.join(root, ".env.local");

function loadEnvLocal(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${filePath}`);
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[t.slice(0, eq).trim()] = val;
  }
  return env;
}

function offsetMeters(lat, lon, northM, eastM) {
  const lat1 = lat + northM / 111_320;
  const lon1 = lon + eastM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat1, lon: lon1 };
}

async function invokeTelegramAlerts(projectUrl, serviceRoleKey, deviceId, lat, lon, speedKmh) {
  const fnUrl = `${projectUrl.replace(/\/$/, "")}/functions/v1/telegram-alerts`;
  const res = await fetch(fnUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
    body: JSON.stringify({
      record: { device_id: deviceId, lat, lon, speed_kmh: speedKmh },
    }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text: text.slice(0, 500) };
}

function parseArgs(argv) {
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log(`Usage:
  node scripts/simulate-zone-left-home.mjs [device_id]

Sets Home geofence status to INSIDE, then invokes telegram-alerts with a point
~2 km north of Home (outside the circle) so you get:
  ✅ Zone Alert: <device> Has LEFT the zone: Home

Requires .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
SIMULATE_USER_ID, and SIMULATE_DEVICE_ID or device_id as first arg.

user_settings.geofence_alerts_enabled must not be false (NULL/missing = ON).`);
      process.exit(0);
    } else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else positional.push(a);
  }
  return { positional };
}

const { positional } = parseArgs(process.argv);
const env = loadEnvLocal(envPath);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const userId = env.SIMULATE_USER_ID?.trim();
const deviceId = (positional[0] || env.SIMULATE_DEVICE_ID)?.trim();

if (!url || !key || !userId || !deviceId) {
  console.error(
    "Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SIMULATE_USER_ID in .env.local, and SIMULATE_DEVICE_ID or device_id as first arg.",
  );
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: zones, error: zErr } = await supabase
  .from("geofences")
  .select("id,name,lat,lon,radius_meters")
  .eq("user_id", userId);
if (zErr) {
  console.error(zErr.message);
  process.exit(1);
}
const home = (zones ?? []).find((z) => String(z.name ?? "").trim().toLowerCase() === "home");
if (!home) {
  console.error("No geofence named Home for SIMULATE_USER_ID.");
  process.exit(1);
}

const hlat = Number(home.lat);
const hlon = Number(home.lon);
const radiusM = Number(home.radius_meters);
if (!Number.isFinite(hlat) || !Number.isFinite(hlon) || !Number.isFinite(radiusM)) {
  console.error("Invalid Home geofence lat/lon/radius_meters");
  process.exit(1);
}

const { error: stErr } = await supabase.from("device_geofence_status").upsert(
  {
    user_id: userId,
    device_id: deviceId,
    geofence_id: home.id,
    is_inside: true,
    last_status_change: new Date().toISOString(),
  },
  { onConflict: "device_id,geofence_id" },
);
if (stErr) {
  console.error("device_geofence_status upsert:", stErr.message);
  process.exit(1);
}
console.log(`Set device_geofence_status: ${deviceId} @ Home → is_inside=true (pretend you were home).`);

const far = offsetMeters(hlat, hlon, 2000, 0);
const speedKmh = 15;

const r = await invokeTelegramAlerts(url, key, deviceId, far.lat, far.lon, speedKmh);
console.log(`Invoke outside Home (~2 km N) — HTTP ${r.status}`, r.ok ? "OK" : r.text);
if (r.ok) {
  console.log(`
Expected Telegram (Markdown):
  ✅ Zone Alert: ${deviceId}
  Has LEFT the zone: Home

If nothing arrived: check user_settings.geofence_alerts_enabled, user_telegram_chats / telegram_chat_id, and Edge function logs.`);
} else {
  process.exit(1);
}
