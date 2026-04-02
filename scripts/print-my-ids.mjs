/**
 * One-time helper: prints device_id + user_id from Supabase so you can paste into .env.local.
 *
 * Uses .env.local: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage: node scripts/print-my-ids.mjs
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
    console.error(`Missing ${filePath}`);
    process.exit(1);
  }
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
if (!url || !key) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: devices, error: dErr } = await supabase
  .from("user_devices")
  .select("user_id, device_id")
  .order("device_id");

if (dErr) {
  console.error("user_devices query failed:", dErr.message);
  process.exit(1);
}

if (!devices?.length) {
  console.log("No rows in user_devices. Claim a device in your app or insert a row in Supabase first.");
  process.exit(0);
}

console.log("\n=== Your fleet (copy ONE line into .env.local) ===\n");
for (const row of devices) {
  console.log(`device_id=${row.device_id}`);
  console.log(`user_id =${row.user_id}`);
  console.log("");
}

const first = devices[0];
console.log("=== Suggested .env.local lines (paste at bottom of file) ===\n");
console.log(`SIMULATE_DEVICE_ID=${first.device_id}`);
console.log(`SIMULATE_USER_ID=${first.user_id}`);
console.log("\nThen run: node scripts/simulate-triggered-cooldown.mjs");
console.log("(No passwords, no UUID typing — the script reads .env.local.)\n");
