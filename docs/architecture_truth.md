# 🧭 Architecture: Single Source of Truth

To ensure the system operates smoothly across Supabase, Vercel, and Home Assistant, the following definitions are the "Single Source of Truth."

## 1. Geofence Logic
*   **The "Home" Zone**: The system *internally* looks for a geofence where the column `name` is exactly **`Home`** (case-insensitive in the Edge Function).
*   **Dimensions**: The `radius_meters` for this "Home" zone is the definitive trigger radius (currently set to **50m** in your DB).

## 2. Table Schemas (Supabase)
### `geofences`
*   `user_id`: Links to the owner (f3fff815...).
*   `name`: Trigger name (must be "Home").
*   `lat` / `lon`: The target center coordinates.
*   `radius_meters`: The zone size.

### `telemetry`
*   `device_id`: The tracker ID (e.g., "Andre").
*   `lat` / `lon` / `speed_kmh`: Live vehicle data.
*   `created_at`: GPS Timestamp (used for sorting latest position).

### `device_gate_state` (The Trigger Bridge)
*   `status`: The state machine status. Possible values:
    -   `HOME`: Parked.
    -   `AWAY_PENDING`: Left the inner zone but not "Armed" yet.
    -   `AWAY_CONFIRMED`: System is **Armed** (outside outer radius for 5+ mins).
    -   `RETURNING`: Vehicle moving toward home after being Armed.
    -   `TRIGGERED_COOLDOWN`: **The Trigger Command!** When this is set, the gate opens.

## 3. Communication Bridge
*   **ESP32 → Supabase**: Reports telemetry via REST API.
*   **Supabase → Home Assistant**: HA polls `device_gate_state` every 5 seconds.
*   **Vercel → Adafruit IO**: Sends manual engine kill commands.
