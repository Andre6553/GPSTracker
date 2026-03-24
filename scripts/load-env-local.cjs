const fs = require("fs");
const path = require("path");

/**
 * @param {string} [rootDir] - project root (folder containing .env.local)
 * @returns {Record<string, string>}
 */
function loadEnvLocal(rootDir = path.join(__dirname, "..")) {
  const envPath = path.join(rootDir, ".env.local");
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing .env.local at ${envPath}`);
  }
  const env = {};
  const text = fs.readFileSync(envPath, "utf8");
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

function supabaseRestBase(env) {
  const base = (env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("NEXT_PUBLIC_SUPABASE_URL missing in .env.local");
  return base;
}

/** Prefer service role for local scripts; anon works only where RLS allows. */
function supabaseKey(env) {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
}

module.exports = { loadEnvLocal, supabaseRestBase, supabaseKey };
