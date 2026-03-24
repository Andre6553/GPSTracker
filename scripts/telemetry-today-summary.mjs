/**
 * Summarizes telemetry for "today" in local PC timezone vs UTC calendar day.
 * Usage: node scripts/telemetry-today-summary.mjs [device_id_optional]
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

const env = loadEnvLocal(envPath);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("Missing URL or key in .env.local");
  process.exit(1);
}

const deviceFilter = process.argv[2]?.trim() || null;

const now = new Date();

// Local calendar day (Windows / Node local TZ)
const localStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
const localEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);

// UTC calendar day
const utcStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
const utcEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));

const supabase = createClient(url, key);

async function countWindow(label, from, to) {
  let q = supabase
    .from("telemetry")
    .select("lat, lon, device_id, created_at", { count: "exact" })
    .gte("created_at", from.toISOString())
    .lt("created_at", to.toISOString())
    .order("created_at", { ascending: true })
    .limit(100000);

  if (deviceFilter) q = q.eq("device_id", deviceFilter);

  const { data, error, count } = await q;

  if (error) {
    console.error(label, "error:", error.message);
    return;
  }

  let minLat = Infinity,
    maxLat = -Infinity,
    minLon = Infinity,
    maxLon = -Infinity;
  const byDevice = {};
  for (const row of data || []) {
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
    }
    byDevice[row.device_id] = (byDevice[row.device_id] || 0) + 1;
  }

  const n = count ?? data?.length ?? 0;
  if (typeof count === "number" && data && count > data.length) {
    console.log("  (Note: bounding box from loaded rows only; not all points if count > limit.)");
  }
  const spanKm =
    n > 0 && minLat !== Infinity
      ? haversineKm(minLat, minLon, maxLat, maxLon)
      : 0;

  console.log("\n" + label);
  console.log("  Range (ISO):", from.toISOString(), "→", to.toISOString());
  console.log("  Row count:", n, "(sample fetch cap may apply)");
  console.log("  By device_id:", byDevice);
  if (n > 0 && minLat !== Infinity) {
    console.log("  Bounding box (lat, lon):", {
      minLat: +minLat.toFixed(6),
      maxLat: +maxLat.toFixed(6),
      minLon: +minLon.toFixed(6),
      maxLon: +maxLon.toFixed(6),
    });
    console.log("  Approx corner-to-corner span:", spanKm.toFixed(2), "km");
  }
  if (data?.length) {
    console.log("  First point time:", data[0].created_at);
    console.log("  Last point time:", data[data.length - 1].created_at);
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

console.log("PC local timezone day window uses your OS clock.");
if (deviceFilter) console.log("Filter device_id:", deviceFilter);

await countWindow("LOCAL calendar day (today 00:00 → tomorrow 00:00, your PC)", localStart, localEnd);
await countWindow("UTC calendar day (UTC midnight → next UTC midnight)", utcStart, utcEnd);

// Exact count without row limit (head only)
async function exactCount(label, from, to) {
  let q = supabase
    .from("telemetry")
    .select("*", { count: "exact", head: true })
    .gte("created_at", from.toISOString())
    .lt("created_at", to.toISOString());
  if (deviceFilter) q = q.eq("device_id", deviceFilter);
  const { count, error } = await q;
  if (error) console.error(label, error.message);
  else console.log("\nExact count (head):", label, "=", count);
}

await exactCount("Local day", localStart, localEnd);
await exactCount("UTC day", utcStart, utcEnd);
