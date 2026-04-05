/**
 * Simulate "🚩 Zone Alert: … Has ENTERED the zone: Home" by:
 *   1) Upserting device_geofence_status (Home) to is_inside = false
 *   2) POSTing telegram-alerts with GPS at the Home center (inside the circle)
 *
 * Same payload shape as the DB webhook on telemetry inserts.
 *
 * Env (.env.local):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   SIMULATE_DEVICE_ID or pass device_id as first argument
 *
 * Owner resolution: scripts/lib/resolve-device-context.mjs (same as telegram-alerts).
 *
 * Usage:
 *   node scripts/simulate-zone-enter-home.mjs Andre
 */
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { resolveDeviceContext } from "./lib/resolve-device-context.mjs";

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
  node scripts/simulate-zone-enter-home.mjs [device_id]

Sets Home geofence status to OUTSIDE, then invokes telegram-alerts at Home center
(lat/lon from geofence) so you get:
  🚩 Zone Alert: <device> Has ENTERED the zone: Home

Requires .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
and SIMULATE_DEVICE_ID or device_id as first arg.

Note: This also runs gate automation in the edge function (may update device_gate_state).`);
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
const deviceId = (positional[0] || env.SIMULATE_DEVICE_ID)?.trim();

if (!url || !key || !deviceId) {
  console.error(
    "Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env.local, and SIMULATE_DEVICE_ID or device_id as first arg.",
  );
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

let ownerUserId;
let home;
try {
  const ctx = await resolveDeviceContext(supabase, deviceId);
  ownerUserId = ctx.ownerUserId;
  home = ctx.home;
  if (ctx.duplicateDeviceLinks) {
    console.warn(
      `Multiple user_devices for "${deviceId}". Using user_id=${ownerUserId} (has Home). Remove duplicate links when you can.`,
    );
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

const hlat = Number(home.lat);
const hlon = Number(home.lon);
const radiusM = Number(home.radius_meters);
if (!Number.isFinite(hlat) || !Number.isFinite(hlon) || !Number.isFinite(radiusM) || radiusM <= 0) {
  console.error("Invalid Home geofence lat/lon/radius_meters (need positive radius).");
  process.exit(1);
}

const { error: stErr } = await supabase.from("device_geofence_status").upsert(
  {
    user_id: ownerUserId,
    device_id: deviceId,
    geofence_id: home.id,
    is_inside: false,
    last_status_change: new Date().toISOString(),
  },
  { onConflict: "device_id,geofence_id" },
);
if (stErr) {
  console.error("device_geofence_status upsert:", stErr.message);
  process.exit(1);
}
console.log(
  `Set device_geofence_status: ${deviceId} @ Home (${home.id}) owner=${ownerUserId} → is_inside=false (pretend outside).`,
);

// Home center is always inside for radius_meters > 0
const speedKmh = 8;
const r = await invokeTelegramAlerts(url, key, deviceId, hlat, hlon, speedKmh);
console.log(`Invoke at Home center — HTTP ${r.status}`, r.ok ? `OK body: ${r.text}` : r.text);
if (r.ok) {
  const body = (r.text || "").trim();
  if (body && body !== "OK") {
    console.log(`Edge returned: ${body}`);
    if (body.includes("No Telegram") || body.includes("No user_settings")) {
      console.error("Fix the issue above — Telegram was not sent.");
      process.exit(1);
    }
  }
  console.log(`
Expected Telegram (Markdown):
  🚩 Zone Alert: ${deviceId}
  Has ENTERED the zone: Home`);
} else {
  process.exit(1);
}
