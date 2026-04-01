import { NextRequest, NextResponse } from "next/server";
import { executeGatePulseFromEnv } from "@/lib/gate-pulse-ewelink";

export const runtime = "nodejs";

/**
 * Sonoff gate momentary pulse via eWeLink (Node).
 * Called from Supabase Edge (Deno cannot load ewelink-api).
 * Auth: Authorization: Bearer <GATE_PULSE_SECRET>
 */
export async function POST(req: NextRequest) {
  const serverSecret = process.env.GATE_PULSE_SECRET?.trim();
  if (!serverSecret) {
    return NextResponse.json(
      { ok: false, error: "Server misconfigured: GATE_PULSE_SECRET missing on Vercel" },
      { status: 500 },
    );
  }

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || token !== serverSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const result = await executeGatePulseFromEnv();
  if (result.ok) {
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
}
