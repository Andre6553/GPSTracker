import { createRequire } from "node:module";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/** `ewelink-api` is CJS (`module.exports`); ESM default import breaks on V/Turbopack → `.login is not a function`. */
function getEwelinkConstructor(): new (params: {
  email: string;
  password: string;
  region: string;
}) => {
  login(): Promise<unknown>;
  setDevicePowerState(deviceId: string, state: string, channel?: number): Promise<unknown>;
} {
  const require = createRequire(import.meta.url);
  const mod = require("ewelink-api") as { default?: unknown } | (new (...args: unknown[]) => unknown);
  const Ctor = typeof mod === "function" ? mod : (mod as { default: unknown }).default;
  if (typeof Ctor !== "function") {
    throw new Error("ewelink-api: invalid export (expected class constructor)");
  }
  return Ctor as new (params: {
    email: string;
    password: string;
    region: string;
  }) => {
    login(): Promise<unknown>;
    setDevicePowerState(deviceId: string, state: string, channel?: number): Promise<unknown>;
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sonoff gate momentary pulse via eWeLink (Node).
 * Called from Supabase Edge (Deno cannot load ewelink-api).
 * Auth: Authorization: Bearer <GATE_PULSE_SECRET>
 */
export async function POST(req: NextRequest) {
  const serverSecret = process.env.GATE_PULSE_SECRET;
  if (!serverSecret) {
    return NextResponse.json(
      { ok: false, error: "Server misconfigured: GATE_PULSE_SECRET missing on Vercel" },
      { status: 500 }
    );
  }

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || token !== serverSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const email = process.env.EWELINK_EMAIL;
  const password = process.env.EWELINK_PASSWORD;
  const region = process.env.EWELINK_REGION ?? "eu";
  const deviceId = process.env.SONOFF_DEVICE_ID;
  const pulseMs = Number(process.env.PULSE_MS ?? "700");

  if (!email || !password || !deviceId) {
    return NextResponse.json(
      { ok: false, error: "Missing EWELINK_EMAIL, EWELINK_PASSWORD, or SONOFF_DEVICE_ID" },
      { status: 500 }
    );
  }

  try {
    const Ewelink = getEwelinkConstructor();
    const connection = new Ewelink({ email, password, region });
    await connection.login();
    await connection.setDevicePowerState(deviceId, "on");
    await sleep(pulseMs);
    await connection.setDevicePowerState(deviceId, "off");
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[gate-pulse] eWeLink error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
