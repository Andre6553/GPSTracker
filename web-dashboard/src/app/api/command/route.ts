import { NextRequest, NextResponse } from "next/server";
import { sendAdafruitCommand } from "@/lib/adafruit";

export async function POST(req: NextRequest) {
  try {
    const { command, device_id } = await req.json();

    try {
      await sendAdafruitCommand(command);
      return NextResponse.json({ success: true, message: `Command '${command}' sent to ${device_id}` });
    } catch (err: any) {
      return NextResponse.json({ success: false, message: err.message }, { status: 500 });
    }
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
