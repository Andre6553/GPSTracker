import { executeGatePulseFromEnv, type GatePulseResult } from "@/lib/gate-pulse-ewelink";

/**
 * Manual gate pulse from Telegram `/trigger_gate_*`.
 *
 * 1) If `HOME_ASSISTANT_GATE_WEBHOOK_URL` is set → POST to that Home Assistant webhook (no CoolKit / eWeLink app id needed).
 * 2) Else → eWeLink cloud via `executeGatePulseFromEnv()` (requires EWELINK_APP_ID / EWELINK_APP_SECRET).
 */
export async function executeGatePulseFlexible(): Promise<GatePulseResult> {
  const haUrl = process.env.HOME_ASSISTANT_GATE_WEBHOOK_URL?.trim();
  if (haUrl) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 25_000);
      const res = await fetch(haUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok) return { ok: true };
      const text = await res.text();
      return { ok: false, error: text || `${res.status} ${res.statusText}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Home Assistant webhook: ${msg}` };
    }
  }

  return executeGatePulseFromEnv();
}
