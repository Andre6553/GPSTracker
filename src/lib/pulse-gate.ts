import dns from "node:dns";
import { executeGatePulseFromEnv, type GatePulseResult } from "@/lib/gate-pulse-ewelink";

function webhookFetchErrorDetail(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  let s = e.name === "AbortError" ? "timeout (25s)" : e.message;
  const c = e.cause;
  if (c instanceof Error) {
    s += ` | ${c.name}: ${c.message}`;
    if ("code" in c && typeof (c as NodeJS.ErrnoException).code === "string") {
      s += ` [${(c as NodeJS.ErrnoException).code}]`;
    }
  } else if (c != null) {
    s += ` | cause: ${String(c)}`;
  }
  return s;
}

/**
 * Manual gate pulse from Telegram `/trigger_gate_*`.
 *
 * 1) If `HOME_ASSISTANT_GATE_WEBHOOK_URL` is set → POST to that Home Assistant webhook (no CoolKit / eWeLink app id needed).
 * 2) Else → eWeLink cloud via `executeGatePulseFromEnv()` (requires EWELINK_APP_ID / EWELINK_APP_SECRET).
 */
export async function executeGatePulseFlexible(): Promise<GatePulseResult> {
  const haUrl = process.env.HOME_ASSISTANT_GATE_WEBHOOK_URL?.trim();
  if (haUrl) {
    // Vercel/Node sometimes picks broken IPv6 for *.ts.net; prefer IPv4.
    if (typeof dns.setDefaultResultOrder === "function") {
      dns.setDefaultResultOrder("ipv4first");
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25_000);
    try {
      const res = await fetch(haUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "*/*",
          "User-Agent": "spatial-orbit-gate-pulse/1",
        },
        body: "{}",
        signal: ctrl.signal,
      });
      if (res.ok) return { ok: true };
      const text = (await res.text()).slice(0, 500);
      return { ok: false, error: text || `${res.status} ${res.statusText}` };
    } catch (e) {
      return {
        ok: false,
        error: `HA webhook: ${webhookFetchErrorDetail(e)}. Check Vercel env URL, redeploy, test: curl -X POST "${haUrl}" -d "{}"`,
      };
    } finally {
      clearTimeout(t);
    }
  }

  return executeGatePulseFromEnv();
}
