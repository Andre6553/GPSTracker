# Architecture — Single Source of Truth

Hybrid cloud + local executor: ESP32 reports position, Supabase holds state, Vercel owns the Telegram webhook and manual commands, Home Assistant (NUC) performs the physical gate pulse by polling Supabase.

## 1. Geofence logic

| Rule | Source |
|------|--------|
| **Home zone** | Row in `geofences` with `name` matching **`home`** (case-insensitive) in `supabase/functions/telegram-alerts/index.ts`. |
| **Inner radius** | `geofences.radius_meters` for that row — definitive “inside home” circle for entry / trigger. |
| **Outer boundary** | `innerRadiusM + OUTER_RADIUS_OFFSET_M` (env, default **250** m). “Far enough away” uses distance **greater than** this outer radius. |

Do not rename the home geofence to anything other than `Home` semantics without updating the edge function filter.

## 2. Supabase tables (contract)

### `geofences`

- `user_id` — owner.
- `name` — must resolve to home (`Home` / `home`).
- `lat`, `lon` — center.
- `radius_meters` — inner zone size (e.g. 50 m in production DB).

### `telemetry`

- `device_id` — tracker identifier (e.g. `Andre`).
- `lat`, `lon`, `speed_kmh` — latest samples (edge function receives inserts via DB webhook payload).
- Timestamps — used upstream for ordering; gate logic uses the payload row.

### `device_gate_state` (automation bridge)

Canonical state machine for gate automation. **Home Assistant should treat `status === TRIGGERED_COOLDOWN` as the “open gate” signal** when polling (e.g. every ~5 s).

| Column | Role |
|--------|------|
| `status` | State machine value (see `STATE_MACHINE.md`). |
| `outside_since`, `driving_since` | Arming timers. |
| `inside_streak` | Consecutive “inside inner” samples before trigger. |
| `last_distance_m`, `last_trigger_at`, `cooldown_until` | Anti-flap and cooldown. |
| `user_id`, `device_id` | Composite identity (`onConflict: user_id, device_id`). |

Related: `user_devices` (device claim, speed alerts), `user_settings` (Telegram chat, flags), `device_geofence_status` (per-zone enter/leave alerts — separate from gate state).

## 3. Components

### ESP32 (`esp32-firmware/CarTracker.ino`)

- POSTs telemetry to Supabase REST.

### Edge function (`supabase/functions/telegram-alerts/index.ts`)

- Triggered on telemetry (Supabase webhook → function).
- Resolves home geofence, updates `device_gate_state`, sends speed/geofence Telegram messages as configured.
- **Gate pulse path in code:** sends a dynamic Telegram command `/trigger_gate_<deviceId>` to the linked chat; the Vercel bot can handle that. **Parallel path:** HA reads `device_gate_state` and triggers the relay — this avoids exclusive Telegram webhook use by HA.

### Vercel (`src/app/api/webhook/telegram/route.ts`)

- **Single webhook owner** for the bot (do not let Home Assistant poll `getUpdates` on the same bot).
- User commands: `/locate`, `/findme`, `/status`, `/killon`, `/killoff` (and gate trigger commands if implemented there).

### Home Assistant (NUC)

- REST sensor polling Supabase for `device_gate_state` (not Telegram polling).
- Config paths on device (example): `configuration.yaml`, `automations.yaml`, `fetch_car.py` under the Home Assistant config tree.

## 4. Manual / Adafruit IO

- Vercel → Adafruit IO for remote kill / feed commands to the device (see webhook implementation).

## 5. Secrets

Never commit tokens. Store in Supabase function secrets, Vercel env, and local `.env.local`. Rotate any credential that has appeared in chat or docs history.
