/**
 * Shorthand for production-style 🟢 Geofence Armed test (~5 min 10 s wall clock).
 *
 * Same as: node scripts/simulate-geofence-armed.mjs --reset <device_id>
 *
 * Requires Supabase edge secrets (defaults): MIN_OUTSIDE_SEC=300, MIN_DRIVE_SEC=30,
 * and speed on invoke >= MIN_DRIVE_SPEED_KMH (default 12). Position is ~2 km outside Home.
 *
 * Usage:
 *   node scripts/simulate-armed-5min.mjs Andre
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const deviceId = process.argv[2]?.trim();
if (!deviceId) {
  console.error("Usage: node scripts/simulate-armed-5min.mjs <device_id>\n");
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [path.join(root, "scripts", "simulate-geofence-armed.mjs"), "--reset", deviceId],
  { cwd: root, stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
