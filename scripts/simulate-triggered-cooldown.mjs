/**
 * Simulate gate automation row so HA sees TRIGGERED_COOLDOWN (or reset to HOME).
 *
 * ⚠️  If Home Assistant is polling Supabase, this can pulse your real gate.
 *     Disable the automation or unplug the relay before testing if needed.
 *
 * Usage:
 *   node scripts/simulate-triggered-cooldown.mjs <device_id> <user_uuid>
 *   node scripts/simulate-triggered-cooldown.mjs --reset <device_id> <user_uuid>
 *   node scripts/simulate-triggered-cooldown.mjs --cooldown-minutes 2 Andre f3fff815-...-uuid
 *
 * Env (optional defaults if you set them in .env.local):
 *   SIMULATE_DEVICE_ID, SIMULATE_USER_ID — used when args omitted (both must be set).
 *   TELEGRAM_BOT_TOKEN — after a simulated trigger, sends you a Telegram (same as production bot).
 *   TELEGRAM_NOTIFY_CHAT_ID or NEXT_PUBLIC_TELEGRAM_CHAT_ID — chat to notify; if omitted, uses user_settings.telegram_chat_id for SIMULATE_USER_ID.
 *
 *   --no-notify — skip Telegram (DB update only).
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
  let reset = false;
  let noNotify = false;
  let cooldownMinutes = 15;
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reset") reset = true;
    else if (a === "--no-notify") noNotify = true;
    else if (a === "--cooldown-minutes" && argv[i + 1]) {
      cooldownMinutes = Number(argv[++i]);
      if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 0) {
        throw new Error("Invalid --cooldown-minutes");
      }
    } else if (a === "--help" || a === "-h") positional.push("__help__");
    else positional.push(a);
  }
  return { reset, noNotify, cooldownMinutes, positional };
}

const { reset, noNotify, cooldownMinutes, positional } = parseArgs(process.argv);

if (positional.includes("__help__")) {
  console.log(`Usage:
  node scripts/simulate-triggered-cooldown.mjs
  node scripts/simulate-triggered-cooldown.mjs --reset
  node scripts/simulate-triggered-cooldown.mjs --cooldown-minutes 2

  (with SIMULATE_DEVICE_ID + SIMULATE_USER_ID in .env.local)

  Or with explicit ids:
  node scripts/simulate-triggered-cooldown.mjs <device_id> <user_uuid>
  node scripts/simulate-triggered-cooldown.mjs --reset <device_id> <user_uuid>

⚠️  May open the real gate while HA is active.`);
  process.exit(0);
}

const env = loadEnvLocal(envPath);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const deviceId = positional[0] || env.SIMULATE_DEVICE_ID?.trim();
const userId = positional[1] || env.SIMULATE_USER_ID?.trim();

if (!deviceId || !userId) {
  console.log(`Usage:
  node scripts/simulate-triggered-cooldown.mjs
  node scripts/simulate-triggered-cooldown.mjs --reset

Add to .env.local:
  SIMULATE_DEVICE_ID=<your device_id>
  SIMULATE_USER_ID=<your uuid>

Or pass: node scripts/simulate-triggered-cooldown.mjs <device_id> <user_uuid>

⚠️  May open the real gate while HA is active.`);
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const now = new Date();

const { data: existing, error: readErr } = await supabase
  .from("device_gate_state")
  .select("*")
  .eq("user_id", userId)
  .eq("device_id", deviceId)
  .maybeSingle();

if (readErr) {
  console.error("Read error:", readErr.message);
  process.exit(1);
}

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

const row = reset
  ? {
      ...base,
      status: "HOME",
      outside_since: null,
      driving_since: null,
      inside_streak: 0,
      last_distance_m: null,
      last_trigger_at: null,
      cooldown_until: null,
      updated_at: now.toISOString(),
    }
  : {
      ...base,
      status: "TRIGGERED_COOLDOWN",
      last_trigger_at: now.toISOString(),
      cooldown_until: new Date(now.getTime() + cooldownMinutes * 60 * 1000).toISOString(),
      updated_at: now.toISOString(),
    };

const { data, error } = await supabase.from("device_gate_state").upsert(row, { onConflict: "user_id,device_id" }).select();

if (error) {
  console.error("Supabase error:", error.message);
  process.exit(1);
}

console.log(reset ? "Reset to HOME:" : "Simulated TRIGGERED_COOLDOWN:", JSON.stringify(data, null, 2));

async function resolveChatId(supabaseclient, uid, localEnv) {
  const fromEnv = (localEnv.TELEGRAM_NOTIFY_CHAT_ID || localEnv.NEXT_PUBLIC_TELEGRAM_CHAT_ID || "").trim();
  if (fromEnv) return fromEnv;
  const { data, error } = await supabaseclient
    .from("user_settings")
    .select("telegram_chat_id")
    .eq("user_id", uid)
    .maybeSingle();
  if (error || !data?.telegram_chat_id) return "";
  return String(data.telegram_chat_id);
}

async function sendTelegramMarkdown(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.description || res.statusText || "sendMessage failed");
  }
}

if (!reset && !noNotify) {
  const token = (env.TELEGRAM_BOT_TOKEN || "").trim();
  if (token) {
    try {
      const chatId = await resolveChatId(supabase, userId, env);
      if (!chatId) {
        console.warn("Telegram: no chat id (set TELEGRAM_NOTIFY_CHAT_ID or link telegram_chat_id in user_settings).");
      } else {
        const cooldownUntil = data?.[0]?.cooldown_until ?? row.cooldown_until;
        await sendTelegramMarkdown(
          token,
          chatId,
          `🚪 *Gate triggered*\nDevice: *${deviceId}*\n_Source: manual simulation (Supabase \`device_gate_state\`)_\nCooldown until: \`${cooldownUntil ?? "—"}\``
        );
        console.log("Telegram notification sent.");
      }
    } catch (e) {
      console.warn("Telegram notify failed:", e instanceof Error ? e.message : e);
    }
  }
}
