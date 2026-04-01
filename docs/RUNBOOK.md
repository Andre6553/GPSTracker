# Runbook — Deploy & Recovery

## Supabase Edge Function

From repo root (with Supabase CLI logged in):

```bash
npx supabase functions deploy telegram-alerts --project-ref <YOUR_PROJECT_REF> --no-verify-jwt
```

Set function secrets in the Supabase dashboard (or CLI): at minimum `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, plus any optional gate env vars from `STATE_MACHINE.md`.

Ensure the **database webhook** on `telemetry` (or relevant table) invokes `telegram-alerts` with the JSON payload shape the function expects (`record.device_id`, `lat`, `lon`, `speed_kmh`).

## Vercel (dashboard + webhook)

Deploy from your normal Vercel workflow; confirm env vars mirror local needs (`TELEGRAM_BOT_TOKEN`, Supabase URL keys, Adafruit credentials as used by `src/app/api/webhook/telegram/route.ts`).

### `/trigger_gate_*` without eWeLink developer (CoolKit) keys

Cloud gate pulse uses `ewelink-api`, which requires `EWELINK_APP_ID` / `EWELINK_APP_SECRET` from the [eWeLink developer console](https://dev.ewelink.cc/). If you do not have those yet, point Telegram at **Home Assistant** instead:

1. On Home Assistant, add an automation (or merge into `automations.yaml`) with a **webhook** trigger and the **same** action you use to pulse the gate (e.g. momentary switch / relay).

```yaml
automation:
  - alias: "Telegram manual gate pulse (webhook)"
    id: telegram_gate_webhook
    trigger:
      - platform: webhook
        webhook_id: YOUR_LONG_RANDOM_SECRET
        local_only: false
    action:
      # Reuse whatever you already use for the gate — example:
      - service: switch.turn_on
        target:
          entity_id: switch.your_gate_relay
      - delay: "00:00:00.7"
      - service: switch.turn_off
        target:
          entity_id: switch.your_gate_relay
```

2. **Public URL** so Vercel can reach HA: [Nabu Casa](https://www.nabucasa.com/), [Tailscale Funnel](https://tailscale.com/kb/1223/funnel/), or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) to your HA instance. The webhook URL looks like:

   `https://<your-ha-host>/api/webhook/YOUR_LONG_RANDOM_SECRET`

3. Set on **Vercel** (and optionally `.env.local`):

   `HOME_ASSISTANT_GATE_WEBHOOK_URL` = that full URL (HTTPS).

Redeploy. Then `/trigger_gate_andre` will **POST** to HA instead of calling eWeLink on Vercel. Automatic arrival flow is unchanged (Supabase → HA polling `device_gate_state`).

### If the HA webhook returns **400 Bad Request** (curl or Telegram)

Home Assistant often rejects reverse-proxy requests until it knows your **public hostname** and trusts the proxy loopback.

1. **Settings → System → Network** (or **Settings → System** on older HA): set  
   **Home Assistant URL** / **External URL** to your Funnel base **exactly**:  
   `https://ubunto.<your>.ts.net` (no path, no trailing slash — use your real Funnel host).

2. In `configuration.yaml`, under **`http:`**:

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 127.0.0.1
    - ::1
```

Restart Home Assistant (or reload if your setup allows), then test again:

`curl -X POST "https://YOUR_HOST/api/webhook/vercel_gate_v1_a8f3c91d"`

### Telegram webhook stuck / conflict

Only one integration may call `getUpdates` on the bot. Home Assistant must **not** use the Telegram polling integration for this bot if Vercel uses `setWebhook`.

Manual reset (replace placeholders, run locally — do not commit the token):

```bash
python -c "import requests; requests.post('https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<YOUR_DOMAIN>/api/webhook/telegram')"
```

## Home Assistant (NUC)

Typical workflow:

1. Edit YAML/scripts on Windows (or in repo copies if mirrored).
2. Copy to the NUC, e.g. `scp` to `/tmp/` then move into the HA config directory with `ssh`.
3. Reload automations or restart HA as required.

**NUC SSH example:** `andre@192.168.10.173` (adjust user/IP to your network).

Paths on the appliance often resemble:

- `configuration.yaml` — REST sensor for `device_gate_state`
- `automations.yaml` — gate pulse when status is `TRIGGERED_COOLDOWN`
- `fetch_car.py` — optional bridge for maps/status

## Quick verification

| Check | Action |
|-------|--------|
| Telemetry flowing | Supabase `telemetry` rows updating for `device_id`. |
| Function runs | Supabase function logs show `telegram-alerts hit`. |
| State updates | `device_gate_state.status` transitions when driving away / back. |
| HA sees trigger | REST sensor entity shows `TRIGGERED_COOLDOWN` after return trip. |
| Vercel webhook | `getWebhookInfo` shows correct URL; bot commands reply. |

## If gate never opens

1. Confirm `GATE_AUTOMATION_ENABLED` is not `false`.
2. Confirm a `geofences` row named `home` exists for the user with correct `lat`/`lon`/`radius_meters`.
3. Check `device_gate_state` — stuck in `AWAY_PENDING` usually means outer/timing/driving thresholds not met.
4. Confirm HA automation matches `TRIGGERED_COOLDOWN` and relay entity works manually.

## Credentials

Use environment variables and platform secret stores only. Rotate any secret that was ever pasted in plaintext.
