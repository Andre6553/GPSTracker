import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function loadEnv(filePath) {
  const env = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    env[t.slice(0, eq).trim()] = v;
  }
  return env;
}

const env = loadEnv(path.join(root, ".env.local"));
const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// Match page.tsx: HTML date YYYY-MM-DD + hardcoded +02:00 (SAST)
const ymd = process.argv[2] || "2026-03-24";
const deviceId = process.argv[3] || "Andre";
const start = `${ymd}T00:00:00+02:00`;
const end = `${ymd}T23:59:59+02:00`;

const { count, error } = await supabase
  .from("telemetry")
  .select("*", { count: "exact", head: true })
  .eq("device_id", deviceId)
  .gte("created_at", start)
  .lte("created_at", end);

if (error) {
  console.error(error);
  process.exit(1);
}

console.log("Same filter as dashboard History tab:");
console.log("  device_id:", deviceId);
console.log("  gte:", start);
console.log("  lte:", end);
console.log("  Count:", count);

const { data: ends } = await supabase
  .from("telemetry")
  .select("created_at, lat, lon")
  .eq("device_id", deviceId)
  .gte("created_at", start)
  .lte("created_at", end)
  .order("created_at", { ascending: true })
  .limit(1);

const { data: lasts } = await supabase
  .from("telemetry")
  .select("created_at, lat, lon")
  .eq("device_id", deviceId)
  .gte("created_at", start)
  .lte("created_at", end)
  .order("created_at", { ascending: false })
  .limit(1);

if (ends?.[0] && lasts?.[0]) {
  console.log("  First row:", ends[0].created_at, ends[0].lat, ends[0].lon);
  console.log("  Last row:", lasts[0].created_at, lasts[0].lat, lasts[0].lon);
}
