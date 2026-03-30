import { NextRequest, NextResponse } from "next/server";
import eWelink from "ewelink-api";

export const runtime = "nodejs";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sonoff gate momentary pulse via eWeLink (Node).
 * Called from Supabase Edge (Deno cannot load ewelink-api).
 * Auth: Authorization: Bearer <GATE_PULSE_SECRET>
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || token !== process.env.GATE_PULSE_SECRET) {
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
    const connection = new eWelink({
      email,
      password,
      region,
    } as ConstructorParameters<typeof eWelink>[0]);
    await connection.login();
    await connection.setDevicePowerState(deviceId, "on");
    await sleep(pulseMs);
    await connection.setDevicePowerState(deviceId, "off");
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
