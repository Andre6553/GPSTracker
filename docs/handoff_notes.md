# 🚀 Project Handoff: Multi-Tenant GPS Gate Automation

This document summarizes the current state of the GPS Tracking and Gate Automation system for future development.

## 🏗 System Architecture

The system is a "Hybrid Cloud" setup designed for zero-latency gate triggers while maintaining global manual control.

### 1. The Hardware (ESP32)
*   **Role**: Sits in the vehicle and broadcasts GPS/Speed data.
*   **Path**: `esp32-firmware/CarTracker.ino`
*   **Connectivity**: 
    1.  **Supabase**: Sends telemetry via REST POST every 5-15 seconds.
    2.  **Adafruit IO**: Subscribes via MQTT to receive `/killon` (LOCK) and `/killoff` (UNLOCK) commands.

### 2. The Cloud Brains (Supabase)
*   **Role**: Database and Logic Processor.
*   **Edge Function**: `supabase/functions/telegram-alerts/index.ts`
*   **Logic**:
    -   **Arming**: If the car is >350m away for 5+ minutes, status sets to `AWAY_CONFIRMED`.
    -   **Triggering**: When returning home and entering the 50m radius, status sets to `TRIGGERED_COOLDOWN`.
    -   **Multi-Tenancy**: Lookups are performed dynamically against the `geofences` table (searching for "Home") and the `user_devices` table.

### 3. The Control Center (Vercel Dashboard)
*   **Domain**: `https://gps-tracker-three.vercel.app`
*   **Role**: Handles the Telegram Bot Webhook and User UI.
*   **Path**: `src/app/api/webhook/telegram/route.ts`
*   **Commands Handled**: `/locate`, `/findme`, `/status`, `/killon`, `/killoff`.
*   **Note**: Vercel talks to **Adafruit IO** to send commands back to the car.

### 4. The Local Executor (Home Assistant NUC)
*   **IP/User**: `andre@192.168.10.173`
*   **Role**: Physically triggers the Sonoff Gate Relay.
*   **The Fix**: To avoid Telegram Webhook conflicts, HA now uses a **REST Sensor** (polling Supabase every 5s) instead of listening to the Bot directly.
*   **Paths**:
    -   `/var/lib/homeassistant/homeassistant/configuration.yaml` (REST Sensor + Shell Commands)
    -   `/var/lib/homeassistant/homeassistant/automations.yaml` (Gate Trigger Logic)
    -   `/var/lib/homeassistant/homeassistant/fetch_car.py` (Python bridge for status/maps)

---

## 🛠 Recent Critical Fixes (April 2026)

### 1. The "Road Trip" Bug (Geofence State Lock)
*   **Problem**: Stopping at red lights caused `isDriving` to be false, which downgraded the state from `AWAY_CONFIRMED` to `AWAY_PENDING`, preventing the gate from opening on return.
*   **Fix**: Implemented "State Locks" in the Edge Function. Once `AWAY_CONFIRMED` is reached, it cannot downgrade until a `HOME` or `TRIGGERED` event occurs.

### 2. Telegram Routing Conflict
*   **Problem**: Home Assistant (Polling) and Vercel (Webhook) were fighting over the Bot. Telegram disabled the Webhook every time HA polled.
*   **Fix**: Removed the Telegram Integration from Home Assistant. HA now polls Supabase via **REST API** to find the gate trigger signal. Vercel Webhook has been restored manually.

---

## 🏁 Future Takeover Instructions

### To Edit & Deploy:
1.  **Edge Functions**:
    `npx supabase login` then `npx supabase functions deploy telegram-alerts --project-ref iizjhnhnpsvaylcdgish --no-verify-jwt` (ref = subdomain of your Supabase URL).
2.  **Home Assistant Config**:
    Edit files on the Windows PC first, then `scp` them to `/tmp/` on the NUC, and `mv` them to the HA directory via SSH.
3.  **Manual Webhook Reset** (If it breaks again):
    `python -c "import requests; requests.post('https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<DOMAIN>/api/webhook/telegram')"`

### 🔑 Critical Credentials
*   **Supabase URL**: `https://iizjhnhnpsvaylcdgish.supabase.co`
*   **AIO Username**: `Andre1980`
*   **AIO Feed**: `cartracker2.throttle`
*   **Bot Token**: `8605157358:AAHeFPtcs5W-7sV3pVotyRDUf1bglE8hLJY`
