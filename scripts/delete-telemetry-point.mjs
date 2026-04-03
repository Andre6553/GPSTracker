/**
 * Delete telemetry row(s) matching device + lat + lon (and optional speed / created_at).
 *
 * Usage:
 *   node scripts/delete-telemetry-point.mjs Andre -34.122219 22.092565
 *   node scripts/delete-telemetry-point.mjs Andre -34.122219 22.092565 --dry-run
 *   node scripts/delete-telemetry-point.mjs Andre -34.122219 22.092565 --speed 25
 *   node scripts/delete-telemetry-point.mjs Andre -34.122219 22.092565 --created-at 2026-04-02T13:54:07.000Z
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env.local
 *
 * If multiple rows match, use --created-at (ISO UTC from Supabase Table editor) or delete by id in SQL.
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

function parseArgs(argv) {
  let dryRun = false;
  let speed = null;
  let createdAt = null;
  const pos = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--speed" && argv[i + 1]) speed = Number(argv[++i]);
    else if (a === "--created-at" && argv[i + 1]) createdAt = argv[++i];
    else if (a.startsWith("--")) {
      console.error("Unknown:", a);
      process.exit(1);
    } else pos.push(a);
  }
  return { dryRun, speed, createdAt, pos };
}

const { dryRun, speed, createdAt, pos } = parseArgs(process.argv);
const deviceId = pos[0];
const lat = Number(pos[1]);
const lon = Number(pos[2]);

if (!deviceId || !Number.isFinite(lat) || !Number.isFinite(lon)) {
  console.log(`Usage:
  node scripts/delete-telemetry-point.mjs <device_id> <lat> <lon> [--speed 25] [--created-at ISO_UTC] [--dry-run]
`);
  process.exit(1);
}

const env = loadEnvLocal(envPath);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

/** Match floats from DB / UI rounding */
const latTol = 1e-5;
const lonTol = 1e-5;

let q = supabase
  .from("telemetry")
  .select("id, created_at, lat, lon, speed_kmh, device_id")
  .eq("device_id", deviceId)
  .gte("lat", lat - latTol)
  .lte("lat", lat + latTol)
  .gte("lon", lon - lonTol)
  .lte("lon", lon + lonTol);

if (speed != null && Number.isFinite(speed)) q = q.eq("speed_kmh", speed);
if (createdAt) q = q.eq("created_at", createdAt);

const { data: rows, error: selErr } = await q.order("created_at", { ascending: false });

if (selErr) {
  console.error(selErr.message);
  process.exit(1);
}

if (!rows?.length) {
  console.log("No matching rows.");
  process.exit(0);
}

console.log("Matching rows:", rows.length);
console.log(JSON.stringify(rows, null, 2));

if (dryRun) {
  console.log("--dry-run: no delete.");
  process.exit(0);
}

if (rows.length > 1 && !createdAt) {
  console.error(
    "Multiple rows match. Re-run with --created-at <exact created_at from list> or delete one id in Supabase SQL Editor."
  );
  process.exit(1);
}

const ids = rows.map((r) => r.id);
const { error: delErr } = await supabase.from("telemetry").delete().in("id", ids);
if (delErr) {
  console.error("Delete failed:", delErr.message);
  process.exit(1);
}
console.log("Deleted", ids.length, "row(s). Refresh the map / history.");
