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
