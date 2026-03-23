import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

// Telegram Bot Notification API Route
// Triggered by Supabase Database Webhooks or client-side fetch calls
// POST /api/notify  { type: "speed" | "geofence" | "offline", message: string }

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

async function sendTelegram(text: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("[Notify] Telegram not configured. Skipping.");
    return false;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
    }),
  });

  return res.ok;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { type, message, device_id, speed, lat, lon, zone } = body;

    // Check if alerts are enabled for this user/device
    const { data: deviceOwner } = await supabase
      .from("user_devices")
      .select("user_id")
      .eq("device_id", device_id || "")
      .single();

    if (deviceOwner) {
      const { data: settings } = await supabase
        .from("user_settings")
        .select("speed_alerts_enabled, geofence_alerts_enabled")
        .eq("user_id", deviceOwner.user_id)
        .single();

      if (type === "speed" && settings?.speed_alerts_enabled === false) {
        return NextResponse.json({ success: false, message: "Speed alerts disabled by user" });
      }
      if ((type === "enter" || type === "exit") && settings?.geofence_alerts_enabled === false) {
        return NextResponse.json({ success: false, message: "Geofence alerts disabled by user" });
      }
    }

    let text = "";
    const time = new Date().toLocaleTimeString();
    const mapsUrl = lat && lon ? `https://www.google.com/maps?q=${lat},${lon}` : "";

    switch (type) {
      case "speed":
        text = `🚨 <b>SPEED ALERT</b>\n🚗 ${device_id || "Unknown"}\n⚡ ${speed || 0} km/h\n📍 <a href="${mapsUrl}">View on Maps</a>\n⏰ ${time}`;
        break;
      case "enter":
        text = `🟢 <b>ZONE ENTERED</b>\n🚗 ${device_id || "Unknown"}\n🌍 Zone: <b>${zone || "Unknown"}</b>\n📍 <a href="${mapsUrl}">View on Maps</a>\n⏰ ${time}`;
        break;
      case "exit":
        text = `🟠 <b>ZONE EXITED</b>\n🚗 ${device_id || "Unknown"}\n🌍 Zone: <b>${zone || "Unknown"}</b>\n📍 <a href="${mapsUrl}">View on Maps</a>\n⏰ ${time}`;
        break;
      case "offline":
        text = `⚠️ <b>OFFLINE ALERT</b>\n🚗 ${device_id || "Unknown"}\n${message || "Vehicle has gone offline."}\n⏰ ${time}`;
        break;
      default:
        text = `📢 <b>Fleet Alert</b>\n${message || "No details provided."}\n⏰ ${time}`;
    }

    const ok = await sendTelegram(text);

    return NextResponse.json({ success: ok, message: ok ? "Notification sent" : "Telegram not configured" });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
