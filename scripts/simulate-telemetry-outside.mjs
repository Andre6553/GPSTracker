/**
 * Insert fake telemetry so Supabase runs the same DB webhook → telegram-alerts as the ESP32.
 *
 * IMPORTANT: If you use supabase/telemetry_skip_home_geofence.sql, INSERTs *inside* Home are
 * dropped (RETURN NULL) — no webhook, no Telegram. For inside/Home-center points this script
 * POSTs telegram-alerts directly with the same `record` shape the webhook sends.
 *
 * Zone Telegram alerts (ENTERED / LEFT) only fire on *transitions* vs device_geofence_status.
 * Use --leave-home or --return-home for a two-step flow with a short pause.
 *
 * "Geofence Armed" needs real wall-clock time outside the outer ring + driving (see MIN_OUTSIDE_SEC).
 * This script does not speed that up; use a short drive or temporarily lower those secrets in Supabase.
 *
 * Usage:
 *   node scripts/simulate-telemetry-outside.mjs --leave-home
 *   node scripts/simulate-telemetry-outside.mjs --return-home
 *   node scripts/simulate-telemetry-outside.mjs --outside
 *   node scripts/simulate-telemetry-outside.mjs --inside
 *   node scripts/simulate-telemetry-outside.mjs --open-gate   # set TRIGGERED_COOLDOWN (+ optional HA webhook from .env.local)
 *   node scripts/simulate-telemetry-outside.mjs --reset-gate # reset row to HOME
 *   node scripts/simulate-telemetry-outside.mjs --coords LAT LON   # one telemetry row (map pin); uses admin_insert_telemetry RPC when present (run supabase/telemetry_admin_insert.sql)
 *
 * Env (.env.local):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SIMULATE_USER_ID
 *   SIMULATE_DEVICE_ID (or pass device as first arg)
 */
import { spawnSync } from "node:child_process";
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

/** ~meters north / east from (lat, lon). */
function offsetMeters(lat, lon, northM, eastM) {
  const lat1 = lat + northM / 111_320;
  const lon1 = lon + eastM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat1, lon: lon1 };
}

function parseArgs(argv) {
  const positional = [];
  let mode = null;
  let coordsLat = null;
  let coordsLon = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--coords") {
      mode = "coords";
      const la = argv[++i];
      const lo = argv[++i];
      if (la == null || lo == null) {
        console.error("--coords requires LAT LON (decimal degrees, e.g. -34.140124 22.092579)");
        process.exit(1);
      }
      coordsLat = Number(la);
      coordsLon = Number(lo);
      if (!Number.isFinite(coordsLat) || !Number.isFinite(coordsLon)) {
        console.error("Invalid lat/lon for --coords");
        process.exit(1);
      }
    } else if (a === "--leave-home") mode = "leave-home";
    else if (a === "--return-home") mode = "return-home";
    else if (a === "--outside") mode = "outside";
    else if (a === "--inside") mode = "inside";
    else if (a === "--open-gate") mode = "open-gate";
    else if (a === "--reset-gate") mode = "reset-gate";
    else if (a.startsWith("--")) {
      console.error("Unknown flag:", a);
      process.exit(1);
    } else positional.push(a);
  }
  return { mode, positional, coordsLat, coordsLon };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Same payload the DB webhook passes: edge reads `payload.record`. */
async function invokeTelegramAlerts(projectUrl, serviceRoleKey, deviceId, lat, lon, speedKmh) {
  const fnUrl = `${projectUrl.replace(/\/$/, "")}/functions/v1/telegram-alerts`;
  const body = JSON.stringify({
    record: { device_id: deviceId, lat, lon, speed_kmh: speedKmh },
  });
  const res = await fetch(fnUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
    body,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text: text.slice(0, 500) };
}

async function insertPoint(supabase, deviceId, lat, lon, speedKmh) {
  const row = {
    device_id: deviceId,
    lat,
    lon,
    speed_kmh: speedKmh,
    altitude_m: 0,
    satellites: 8,
  };
  const { data, error } = await supabase.from("telemetry").insert(row).select();
  if (error) {
    console.error("insert failed:", error.message);
    process.exit(1);
  }
  return data?.[0];
}

const { mode, positional, coordsLat, coordsLon } = parseArgs(process.argv);

if (mode === "open-gate" || mode === "reset-gate") {
  const scriptPath = path.join(root, "scripts", "simulate-triggered-cooldown.mjs");
  const args = [scriptPath];
  if (mode === "reset-gate") args.push("--reset");
  if (positional[0]) args.push(positional[0]);
  if (positional[1]) args.push(positional[1]);
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  process.exit(r.status === null ? 1 : r.status);
}

if (!mode) {
  console.log(`Usage:
  node scripts/simulate-telemetry-outside.mjs --leave-home    # inside → outside (expect "Left Home" if geofence alerts on)
  node scripts/simulate-telemetry-outside.mjs --return-home     # outside → inside (expect "Entered Home")
  node scripts/simulate-telemetry-outside.mjs --outside        # single point ~2 km north of Home
  node scripts/simulate-telemetry-outside.mjs --inside         # Home center (direct edge invoke; DB would skip insert)
  node scripts/simulate-telemetry-outside.mjs --open-gate       # DB TRIGGERED_COOLDOWN → HA opens gate (may POST HA webhook)
  node scripts/simulate-telemetry-outside.mjs --reset-gate      # back to HOME after a test
  node scripts/simulate-telemetry-outside.mjs --coords -34.140124 22.092579
  node scripts/simulate-telemetry-outside.mjs Andre --coords -34.140124 22.092579

Device id: first arg OR SIMULATE_DEVICE_ID in .env.local (gate scripts also need SIMULATE_USER_ID).
--coords does not need SIMULATE_USER_ID.
`);
  process.exit(0);
}

const env = loadEnvLocal(envPath);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const userId = env.SIMULATE_USER_ID?.trim();
const deviceId = (positional[0] || env.SIMULATE_DEVICE_ID)?.trim();

if (!url || !key) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
if (!deviceId) {
  console.error("Set SIMULATE_DEVICE_ID or pass device id as first argument.");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

if (mode === "coords") {
  const { data: rpcData, error: rpcErr } = await supabase.rpc("admin_insert_telemetry", {
    p_device_id: deviceId,
    p_lat: coordsLat,
    p_lon: coordsLon,
    p_speed_kmh: 0,
  });

  if (rpcErr) {
    console.error("admin_insert_telemetry:", rpcErr.message);
    if (/Could not find|not found|schema cache|PGRST202/i.test(rpcErr.message)) {
      console.error(
        "\nRun this file in Supabase → SQL Editor, then retry:\n  supabase/telemetry_admin_insert.sql\n"
      );
    }
    process.exit(1);
  }

  const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
  if (!row) {
    console.error("No row returned from admin_insert_telemetry.");
    process.exit(1);
  }
  console.log("Inserted telemetry:", row.id, "lat", coordsLat, "lon", coordsLon, row.created_at);
  console.log("Refresh the dashboard map (up to ~25s or switch tab) to see the pin.");
  process.exit(0);
}

if (!userId) {
  console.error("Need SIMULATE_USER_ID in .env.local for this mode (or use --coords).");
  process.exit(1);
}

const { data: settingsRow } = await supabase
  .from("user_settings")
  .select("geofence_alerts_enabled, telegram_chat_id")
  .eq("user_id", userId)
  .maybeSingle();
if (!settingsRow?.telegram_chat_id) {
  console.warn("Warning: user_settings.telegram_chat_id empty — edge returns early; no Telegram.");
}
if (settingsRow && !settingsRow.geofence_alerts_enabled) {
  console.warn("Warning: geofence_alerts_enabled is false — no ENTERED/LEFT zone messages.");
}

const { data: zones, error: zErr } = await supabase
  .from("geofences")
  .select("name,lat,lon,radius_meters")
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

// ~2 km north — outside typical inner (50 m) + outer offset (250 m)
const far = offsetMeters(hlat, hlon, 2000, 0);

async function run() {
  if (mode === "inside") {
    const r = await invokeTelegramAlerts(url, key, deviceId, hlat, hlon, 0);
    console.log("INSIDE at Home (edge invoke — DB skips inserts inside Home):", r.status, r.ok ? "OK" : r.text);
    return;
  }
  if (mode === "outside") {
    const row = await insertPoint(supabase, deviceId, far.lat, far.lon, 25);
    console.log("Inserted OUTSIDE (~2 km N of Home):", row?.id, row?.created_at);
    return;
  }
  if (mode === "leave-home") {
    const r1 = await invokeTelegramAlerts(url, key, deviceId, hlat, hlon, 0);
    console.log("1) Inside (edge invoke):", r1.status, r1.ok ? "OK" : r1.text);
    await sleep(1500);
    const b = await insertPoint(supabase, deviceId, far.lat, far.lon, 25);
    console.log("2) Outside (insert):", b?.id, "— check Telegram for zone LEFT.");
    return;
  }
  if (mode === "return-home") {
    const a = await insertPoint(supabase, deviceId, far.lat, far.lon, 25);
    console.log("1) Outside (insert):", a?.id);
    await sleep(1500);
    const r2 = await invokeTelegramAlerts(url, key, deviceId, hlat, hlon, 8);
    console.log("2) Inside (edge invoke):", r2.status, r2.ok ? "OK" : r2.text, "— check Telegram for zone ENTERED.");
  }
}

await run();
