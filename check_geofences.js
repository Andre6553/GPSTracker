const fs = require("fs");
const { loadEnvLocal, supabaseRestBase, supabaseKey } = require("./scripts/load-env-local.cjs");

async function check() {
  try {
    const env = loadEnvLocal();
    const base = supabaseRestBase(env);
    const key = supabaseKey(env);
    if (!key) {
      throw new Error("Set SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local");
    }

    const urlRecent = `${base}/rest/v1/geofences?select=*`;
    const res = await fetch(urlRecent, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    const data = await res.json();

    if (!res.ok) {
      console.error("HTTP", res.status, data);
      return;
    }

    const len = Array.isArray(data) ? data.length : 0;
    console.log(`Found ${len} GEOFENCE records.`);

    if (len > 0) {
      console.log("Geofence records:", JSON.stringify(data, null, 2));
    } else {
      console.log("Geofences table is EMPTY or RLS blocked (try service role in .env.local).");
    }

    fs.writeFileSync("geofences_dump.json", JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(e);
  }
}

check();
