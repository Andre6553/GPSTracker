/**
 * Sonoff momentary pulse via eWeLink (Node). Shared by `/api/gate-pulse` and Telegram `/trigger_gate_*`.
 */
import eWelinkMod from "ewelink-api";

type EwelinkConnection = {
  at?: string | null;
  getCredentials(): Promise<unknown>;
  setDevicePowerState(deviceId: string, state: string, channel?: number): Promise<unknown>;
};

function getEwelinkConstructor(): new (params: {
  email: string;
  password: string;
  region: string;
  APP_ID?: string;
  APP_SECRET?: string;
}) => EwelinkConnection {
  const mod = eWelinkMod as unknown as { default?: unknown } | (new (...args: unknown[]) => unknown);
  const Ctor = typeof mod === "function" ? mod : (mod as { default: unknown }).default;
  if (typeof Ctor !== "function") {
    throw new Error("ewelink-api: invalid export (expected class constructor)");
  }
  return Ctor as new (params: {
    email: string;
    password: string;
    region: string;
    APP_ID?: string;
    APP_SECRET?: string;
  }) => EwelinkConnection;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type GatePulseResult = { ok: true } | { ok: false; error: string };

/**
 * Reads EWELINK_* / SONOFF_DEVICE_ID / PULSE_MS from process.env (same as HTTP route).
 */
export async function executeGatePulseFromEnv(): Promise<GatePulseResult> {
  const email = process.env.EWELINK_EMAIL;
  const password = process.env.EWELINK_PASSWORD;
  const region = process.env.EWELINK_REGION ?? "eu";
  const deviceId = process.env.SONOFF_DEVICE_ID;
  const pulseMs = Number(process.env.PULSE_MS ?? "700");
  const appId = process.env.EWELINK_APP_ID?.trim();
  const appSecret = process.env.EWELINK_APP_SECRET?.trim();

  if (!email || !password || !deviceId) {
    return { ok: false, error: "Missing EWELINK_EMAIL, EWELINK_PASSWORD, or SONOFF_DEVICE_ID" };
  }

  if (!appId || !appSecret) {
    return {
      ok: false,
      error:
        "Missing EWELINK_APP_ID / EWELINK_APP_SECRET (CoolKit requires app credentials). See gate-pulse route.",
    };
  }

  try {
    const Ewelink = getEwelinkConstructor();
    const connection = new Ewelink({ email, password, region, APP_ID: appId, APP_SECRET: appSecret });
    const credResult = await connection.getCredentials();
    if (!connection.at) {
      const o = (credResult && typeof credResult === "object" ? credResult : {}) as {
        msg?: string;
        error?: unknown;
      };
      throw new Error(o.msg ? String(o.msg) : String(o.error ?? "eWeLink getCredentials failed (no token)"));
    }
    await connection.setDevicePowerState(deviceId, "on");
    await sleep(pulseMs);
    await connection.setDevicePowerState(deviceId, "off");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[gate-pulse-ewelink]", msg);
    return { ok: false, error: msg };
  }
}
