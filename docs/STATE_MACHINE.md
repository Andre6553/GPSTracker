# `device_gate_state` State Machine

Implemented in `supabase/functions/telegram-alerts/index.ts` (`processGateAutomation`). Distances are in meters.

## Constants (env overrides)

| Variable | Default | Meaning |
|----------|---------|---------|
| `OUTER_RADIUS_OFFSET_M` | `250` | Outer radius = inner `radius_meters` + this. |
| `MIN_DRIVE_SPEED_KMH` | `12` | `isDriving` if `speed_kmh >=` this. |
| `MIN_OUTSIDE_SEC` | `300` | Seconds outside outer before arming timer eligibility. |
| `MIN_DRIVE_SEC` | `30` | Seconds of driving while outside before `AWAY_CONFIRMED`. |
| `ENTRY_CONFIRM_POINTS` | `3` | Consecutive inside-inner samples to fire trigger. |
| `COOLDOWN_SEC` | `900` | Duration `TRIGGERED_COOLDOWN` holds (and `cooldown_until`). |
| `GATE_AUTOMATION_ENABLED` | `true` | Set `false` to skip gate processing. |

## States

| Status | Meaning |
|--------|---------|
| `HOME` | Inside inner radius (parked / at home). |
| `AWAY_PENDING` | Left home context; outside inner, not fully armed. |
| `AWAY_CONFIRMED` | Armed: outside outer long enough + driving requirement met. |
| `RETURNING` | Armed and moving toward home (distance decreasing while driving). |
| `TRIGGERED_COOLDOWN` | Trigger fired; HA should open gate; cooldown active until `cooldown_until`. |

## High-level flow

1. **Cooldown active** — If `now < cooldown_until`, status is forced to `TRIGGERED_COOLDOWN`, then return (no further transitions that tick).
2. **Cooldown expired** — If status was `TRIGGERED_COOLDOWN` and cooldown ended: `HOME` if inside inner, else `AWAY_PENDING`.
3. **Outside outer** (`distM > outerRadiusM`):
   - From `HOME` or `TRIGGERED_COOLDOWN` → `AWAY_PENDING`, start `outside_since`.
   - In `AWAY_PENDING`: accumulate `outside_since` / `driving_since`; when both `MIN_OUTSIDE_SEC` and `MIN_DRIVE_SEC` satisfied → `AWAY_CONFIRMED` (Telegram “armed” message).
   - `AWAY_CONFIRMED` is **not** downgraded to `AWAY_PENDING` just because driving stops while still outside outer (pending block only runs for `AWAY_PENDING`).
4. **Between inner and outer** while `AWAY_PENDING` — stays pending; clears inside streak.
5. **Returning** — For `AWAY_CONFIRMED` or `RETURNING`, outside inner: if driving and distance dropped by >5 m since last sample → `RETURNING`.
6. **Trigger** — For `AWAY_CONFIRMED` or `RETURNING`, inside inner: increment `inside_streak`; when `>= ENTRY_CONFIRM_POINTS`, send Telegram gate command, set `TRIGGERED_COOLDOWN`, `last_trigger_at`, `cooldown_until`.
7. **Inside inner** (not in the armed+inside trigger branch above) — `HOME`.
8. **Stalled return** — If `RETURNING`, not driving, outside inner → back to `AWAY_CONFIRMED`.

## HA integration note

Poll `device_gate_state` for your `user_id` + `device_id`. Treat **`TRIGGERED_COOLDOWN`** as the automation condition to pulse the gate; respect your own hardware debounce in addition to `COOLDOWN_SEC`.
