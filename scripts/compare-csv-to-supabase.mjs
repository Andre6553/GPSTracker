/**
 * Spot-check rows from Andre_fleet_history CSV against telemetry table.
 * Usage: node scripts/compare-csv-to-supabase.mjs [path-to-csv]
 */
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

function parseCsvLine(line) {
  const parts = [];
  let cur = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "," && parts.length < 6) {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  parts.push(cur);
  return parts;
}

const csvPath =
  process.argv[2] ||
  path.join(root, "logs", "Andre_fleet_history (1).csv");

const env = loadEnv(path.join(root, ".env.local"));
const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const raw = fs.readFileSync(csvPath, "utf8");
const lines = raw.split(/\r?\n/).filter(Boolean);
const header = lines[0];
if (!header.includes("timestamp")) {
  console.error("Unexpected CSV header:", header);
  process.exit(1);
}

const rows = [];
for (let li = 1; li < lines.length; li++) {
  const cols = parseCsvLine(lines[li]);
  if (cols.length < 4) continue;
  const [timestamp, device_id, lat, lon, speed_kmh] = cols;
  rows.push({
    timestamp: timestamp.trim(),
    device_id: device_id.trim(),
    lat: parseFloat(lat),
    lon: parseFloat(lon),
    speed_kmh: speed_kmh ? parseFloat(speed_kmh) : null,
  });
}

console.log("CSV:", csvPath);
console.log("Parsed data rows:", rows.length);

// Sample indices: first, early drive, mid, near end, last
const n = rows.length;
const idxs = [0, Math.floor(n * 0.1), Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 1].filter(
  (v, i, a) => a.indexOf(v) === i
);

let found = 0;
let missing = 0;

for (const i of idxs) {
  const r = rows[i];
  const t = r.timestamp;
  const { data, error } = await supabase
    .from("telemetry")
    .select("id, created_at, lat, lon, speed_kmh")
    .eq("device_id", r.device_id)
    .eq("created_at", t)
    .limit(1);

  if (error) {
    console.error("Query error:", error.message);
    process.exit(1);
  }

  const match = data?.[0];
  const latClose = match && Math.abs(Number(match.lat) - r.lat) < 0.0002;
  const lonClose = match && Math.abs(Number(match.lon) - r.lon) < 0.0002;

  if (match && latClose && lonClose) {
    found++;
    console.log(`OK row ${i + 1}:`, t, "lat/lon match");
  } else if (match && !latClose) {
    console.log(`PARTIAL row ${i + 1}: timestamp exists but coords differ`, {
      csv: [r.lat, r.lon],
      db: [match.lat, match.lon],
    });
    found++;
  } else {
    missing++;
    console.log(`MISS row ${i + 1}:`, t, r.lat, r.lon);
    // try ±2s window
    const t0 = new Date(t).getTime();
    const { data: near } = await supabase
      .from("telemetry")
      .select("created_at, lat, lon")
      .eq("device_id", r.device_id)
      .gte("created_at", new Date(t0 - 3000).toISOString())
      .lte("created_at", new Date(t0 + 3000).toISOString())
      .limit(3);
    if (near?.length) console.log("  Nearby in ±3s:", near);
  }
}

console.log("\nSpot-check summary:", { found, missing, checked: idxs.length });

// Count overlap: CSV time range vs Supabase count in that range
const tMin = rows[0].timestamp;
const tMax = rows[rows.length - 1].timestamp;
const { count: dbCount } = await supabase
  .from("telemetry")
  .select("*", { count: "exact", head: true })
  .eq("device_id", rows[0].device_id)
  .gte("created_at", tMin)
  .lte("created_at", tMax);

console.log("CSV time span:", tMin, "→", tMax);
console.log("Supabase rows (same device, same span):", dbCount);
console.log("CSV rows:", rows.length);
