/**
 * Reads .env.local (no secrets printed). Uses SUPABASE_SERVICE_ROLE_KEY to query telemetry.
 * Usage: node scripts/query-telemetry-last-24h.mjs
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
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${filePath}`);
  }
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const env = loadEnvLocal(envPath);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const supabase = createClient(url, serviceKey);

const { data, error, count } = await supabase
  .from("telemetry")
  .select("*", { count: "exact" })
  .gte("created_at", since)
  .order("created_at", { ascending: false })
  .limit(500);

if (error) {
  console.error("Supabase error:", error.message);
  process.exit(1);
}

console.log(`Connection OK. Rows in last 24h (from ${since}): ${count ?? data?.length ?? 0}`);
if (data?.length) {
  const newest = data[0];
  const oldest = data[data.length - 1];
  console.log("Newest point:", {
    created_at: newest.created_at,
    device_id: newest.device_id,
    lat: newest.lat,
    lon: newest.lon,
    speed_kmh: newest.speed_kmh,
  });
  console.log("Oldest in batch:", {
    created_at: oldest.created_at,
    device_id: oldest.device_id,
  });
} else {
  console.log("No rows in that window (or table empty).");
}
