/**
 * Create (or refresh) dashboard demo login: demo@demo.com / demo12345, linked to device "Andre".
 *
 * Usage:
 *   node scripts/create-demo-user.mjs
 *
 * Env (from .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional:
 *   DEMO_DEVICE_ID=Andre   (default Andre)
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

const EMAIL = "demo@demo.com";
const PASSWORD = "demo12345";

async function findUserIdByEmail(admin, email) {
  const needle = email.toLowerCase();
  let page = 1;
  const perPage = 200;
  for (let guard = 0; guard < 50; guard++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const u = data.users.find((x) => String(x.email || "").toLowerCase() === needle);
    if (u?.id) return u.id;
    if (data.nextPage == null || data.users.length === 0) break;
    page = data.nextPage;
  }
  return null;
}

async function main() {
  const env = loadEnvLocal(envPath);
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const deviceId = (process.env.DEMO_DEVICE_ID || "Andre").trim();
  if (!url || !serviceKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .env.local");
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  let userId;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { demo: true, label: "dashboard-demo" },
  });

  if (createErr) {
    const msg = createErr.message || "";
    if (!/already|registered|exists|duplicate/i.test(msg)) {
      throw createErr;
    }
    userId = await findUserIdByEmail(admin, EMAIL);
    if (!userId) {
      throw new Error(`User ${EMAIL} exists but could not be listed — check Admin API or create manually.`);
    }
    const { error: updErr } = await admin.auth.admin.updateUserById(userId, {
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { demo: true, label: "dashboard-demo" },
    });
    if (updErr) throw updErr;
    console.log(`Updated existing user ${EMAIL} (password reset to demo12345).`);
  } else {
    userId = created.user?.id;
    if (!userId) throw new Error("createUser returned no user id");
    console.log(`Created user ${EMAIL}.`);
  }

  const { data: existingLink } = await admin
    .from("user_devices")
    .select("device_id")
    .eq("user_id", userId)
    .eq("device_id", deviceId)
    .maybeSingle();

  if (!existingLink) {
    const { error: insErr } = await admin.from("user_devices").insert({
      user_id: userId,
      device_id: deviceId,
    });
    if (insErr) throw insErr;
    console.log(`Linked user_devices: ${deviceId}`);
  } else {
    console.log(`user_devices already has ${deviceId}.`);
  }

  console.log(`\nSign in at /login with:\n  ${EMAIL}\n  ${PASSWORD}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
