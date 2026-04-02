/**
 * Prints the "Home" geofence from Supabase:
 *   geofences rows for SIMULATE_USER_ID, selecting the one where name === 'home'
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
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const userId = env.SIMULATE_USER_ID;

if (!url || !key || !userId) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SIMULATE_USER_ID in .env.local");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const { data, error } = await supabase
  .from("geofences")
  .select("id,name,lat,lon,radius_meters")
  .eq("user_id", userId);

if (error) {
  console.error("Supabase error:", error.message);
  process.exit(1);
}

const home = (data ?? []).find((z) => String(z.name ?? "").toLowerCase() === "home");
if (!home) {
  console.log("No 'Home' geofence found for this user.");
  process.exit(0);
}

console.log("Home geofence:");
console.log(JSON.stringify(home, null, 2));

