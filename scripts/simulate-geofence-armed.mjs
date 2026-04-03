/**
 * Simulate the 🟢 "Geofence Armed" Telegram by calling telegram-alerts twice
 * while "outside" and driving — timing uses real wall clock (same as production).
 *
 * Prerequisites:
 * - .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SIMULATE_USER_ID,
 *   SIMULATE_DEVICE_ID (or pass device_id as first arg).
 * - Edge function gate state must start from HOME (use --reset or run --reset-gate first).
 *
 * Timing vs Supabase Edge secrets (telegram-alerts):
 *   MIN_OUTSIDE_SEC (default 300) and MIN_DRIVE_SEC (default 30) — "driving" needs speed
 *   >= MIN_DRIVE_SPEED_KMH (default 12). Position must be outside *outer* ring:
 *   home radius_meters + OUTER_RADIUS_OFFSET_M (default +250 m).
 *
 * Modes:
 *   --quick     Wait ~12s between pings (set secrets to e.g. MIN_OUTSIDE_SEC=10, MIN_DRIVE_SEC=5 first, then RESTORE).
 *   (default)   Wait ~310s (~5m 10s) for default secrets 300/30.
 *
 *   --wait-ms N  Override pause between first and second invoke (milliseconds).
 *   --reset      Set device_gate_state to HOME before running (like simulate-triggered-cooldown --reset).
 *   --allow-zone-alerts  Do not sync device_geofence_status (default: mark Home as already outside so
 *                        the 1st ping does not send a bogus Zone LEFT).
 *
 * Usage:
 *   node scripts/simulate-geofence-armed.mjs --quick --reset
 *   node scripts/simulate-geofence-armed.mjs
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  return { ok: res.ok, status: res.status, text: text.slice(0, 400) };
}

function parseArgs(argv) {
  let quick = false;
  let reset = false;
  let allowZoneAlerts = false;
  let waitMs = null;
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log(`Usage:
  node scripts/simulate-geofence-armed.mjs --quick --reset
  node scripts/simulate-geofence-armed.mjs [--wait-ms 310000]

--reset       Start from HOME in device_gate_state (recommended).
--quick       Pause ~12s — you MUST set Edge secrets MIN_OUTSIDE_SEC=10 MIN_DRIVE_SEC=5 (restore 300/30 after).
(default)     Pause ~310s for production defaults 300/30.
--wait-ms N   Override pause in milliseconds.
--allow-zone-alerts  Skip syncing geofence status (1st ping may send Zone LEFT if DB said inside).
`);
      process.exit(0);
    } else if (a === "--quick") quick = true;
    else if (a === "--reset") reset = true;
    else if (a === "--allow-zone-alerts") allowZoneAlerts = true;
    else if (a === "--wait-ms" && argv[i + 1]) {
      waitMs = Number(argv[++i]);
      if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error("Invalid --wait-ms");
    } else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else positional.push(a);
  }
  return { quick, reset, allowZoneAlerts, waitMs, positional };
}

const { quick, reset, allowZoneAlerts, waitMs: waitMsArg, positional } = parseArgs(process.argv);
const env = loadEnvLocal(envPath);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const userId = env.SIMULATE_USER_ID?.trim();
const deviceId = (positional[0] || env.SIMULATE_DEVICE_ID)?.trim();

if (!url || !key || !userId || !deviceId) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SIMULATE_USER_ID, SIMULATE_DEVICE_ID in .env.local (or pass device as arg).");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

if (reset) {
  const { data: existing, error: re } = await supabase
    .from("device_gate_state")
    .select("*")
    .eq("user_id", userId)
    .eq("device_id", deviceId)
    .maybeSingle();
  if (re) {
    console.error(re.message);
    process.exit(1);
  }
  const now = new Date().toISOString();
  const base = existing ?? {
    user_id: userId,
    device_id: deviceId,
    status: "HOME",
    outside_since: null,
    driving_since: null,
    inside_streak: 0,
    last_distance_m: null,
    last_trigger_at: null,
    cooldown_until: null,
  };
  const row = {
    ...base,
    status: "HOME",
    outside_since: null,
    driving_since: null,
    inside_streak: 0,
    last_distance_m: null,
    last_trigger_at: null,
    cooldown_until: null,
    updated_at: now,
  };
  const { error: upErr } = await supabase.from("device_gate_state").upsert(row, { onConflict: "user_id,device_id" });
  if (upErr) {
    console.error(upErr.message);
    process.exit(1);
  }
  console.log("Reset device_gate_state to HOME.");
}

const { data: zones, error: zErr } = await supabase
  .from("geofences")
  .select("id,name,lat,lon,radius_meters")
  .eq("user_id", userId);
if (zErr) {
  console.error(zErr.message);
  process.exit(1);
}
const home = (zones ?? []).find((z) => String(z.name ?? "").toLowerCase() === "home");
if (!home) {
  console.error("No Home geofence for this user.");
  process.exit(1);
}
const hlat = Number(home.lat);
const hlon = Number(home.lon);
if (Number.isNaN(hlat) || Number.isNaN(hlon)) {
  console.error("Invalid home lat/lon");
  process.exit(1);
}

// Far enough outside outer ring (inner + 250 m default offset — use 2 km)
const far = offsetMeters(hlat, hlon, 2000, 0);
const speedKmh = 25;

let pauseMs = waitMsArg;
if (pauseMs == null) {
  pauseMs = quick ? 12_000 : 310_000;
}

if (quick) {
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--quick uses only ${pauseMs / 1000}s between pings.
You MUST set Supabase → telegram-alerts → Secrets:
  MIN_OUTSIDE_SEC = 10
  MIN_DRIVE_SEC   = 5
(Production is usually 300 / 30 — restore after testing.)
If you skip this, you will NOT get "Geofence Armed" — only maybe Zone alerts.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
} else {
  console.log(`Pausing ${pauseMs} ms (~${(pauseMs / 60000).toFixed(1)} min) — matches default secrets MIN_OUTSIDE_SEC=300 & MIN_DRIVE_SEC=30.`);
}

if (!allowZoneAlerts) {
  const { error: stErr } = await supabase.from("device_geofence_status").upsert(
    {
      user_id: userId,
      device_id: deviceId,
      geofence_id: home.id,
      is_inside: false,
      last_status_change: new Date().toISOString(),
    },
    { onConflict: "device_id,geofence_id" }
  );
  if (stErr) console.warn("device_geofence_status upsert:", stErr.message);
  else console.log("Marked Home geofence as already OUTSIDE in DB (avoids fake Zone LEFT on ping 1). Use --allow-zone-alerts to skip.");
}

const r1 = await invokeTelegramAlerts(url, key, deviceId, far.lat, far.lon, speedKmh);
console.log("[invoke-a] outside + driving — HTTP", r1.status, r1.ok ? "OK" : r1.text);

await sleep(pauseMs);

const r2 = await invokeTelegramAlerts(url, key, deviceId, far.lat, far.lon, speedKmh);
console.log("[invoke-b] outside + driving — HTTP", r2.status, r2.ok ? "OK" : r2.text);
console.log(`
Finished — these lines are log output only; do not paste them into PowerShell.

Expected Telegram: Geofence Armed. With --quick, set Edge secrets MIN_OUTSIDE_SEC=10 and MIN_DRIVE_SEC=5 first.
Without lowering secrets, use default wait ~310s or run: node scripts/simulate-geofence-armed.mjs --reset
`);