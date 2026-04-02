---
name: gate-ha-webhook
description: Deploys and configures spatial-orbit automatic gate triggers via Supabase edge telegram-alerts and Home Assistant webhooks (parity with Telegram /trigger_gate_*). Use when the user asks about auto gate open, TRIGGERED_COOLDOWN, HA funnel, or matching manual and automatic gate pulses.
---

# Gate automation — HA webhook parity

## Behavior

- **Zone Telegram alerts** (enter/leave Home) are independent of arming; they can fire on any boundary crossing.
- **Automatic gate open** only when the edge function state machine is armed (`AWAY_CONFIRMED` / `RETURNING`), the device is inside the Home inner radius, and `inside_streak` reaches `ENTRY_CONFIRM_POINTS`. That is **not** every “entered zone” ping (avoids GPS jitter opens).
- On that event the function sets **`device_gate_state.status = TRIGGERED_COOLDOWN`** and, if configured, **POSTs `HOME_ASSISTANT_GATE_WEBHOOK_URL`** — the **same** URL Vercel uses for `/trigger_gate_<slug>` (`src/lib/pulse-gate.ts`).

## Supabase secrets (`telegram-alerts`)

- Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`.
- **Recommended for instant pulse:** `HOME_ASSISTANT_GATE_WEBHOOK_URL` = full HTTPS webhook (e.g. Tailscale Funnel `https://…/api/webhook/…`).
- Optional: `GATE_EDGE_WEBHOOK_NOTIFY=false` disables the webhook POST (REST polling only).

## Deploy

From repo root, after `npx supabase login`:

```bash
npx supabase functions deploy telegram-alerts --project-ref <REFERENCE_ID> --no-verify-jwt
```

## Double pulse

If Home Assistant **both** reacts to REST `TRIGGERED_COOLDOWN` **and** runs the same relay on the **manual** webhook, one arrival can pulse **twice**. Keep one physical pulse path (adjust `homeassistant/automations.yaml`) or debounce in HA.

## Vercel

Set the same `HOME_ASSISTANT_GATE_WEBHOOK_URL` on Vercel for Telegram `/trigger_gate_*`.
