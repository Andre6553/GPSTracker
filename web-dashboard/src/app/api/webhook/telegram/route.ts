import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function sendTelegram(chatId: string, text: string) {
  if (!BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  }).catch(e => console.error("Telegram send error:", e));
}

export async function POST(req: NextRequest) {
  try {
    const update = await req.json();
    
    // 1. Handle Callback Queries (Button Clicks)
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = String(cb.message.chat.id);
      const data = cb.data; 
      
      if (data === "cancel") {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, message_id: cb.message.message_id, text: "❌ <b>Cancelled.</b>", parse_mode: "HTML" }),
        });
        return NextResponse.json({ ok: true });
      }

      // Step 2: Confirmation Prompt (After selecting a vehicle)
      if (data.startsWith("sel_")) {
        const parts = data.split("_"); // ["sel", "LOCK", "Andre"]
        const action = parts[1];
        const deviceId = parts[2];
        const label = action === "LOCK" ? "🚨 KILL & LOCK" : "🔓 RESTORE";

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: cb.message.message_id,
            text: `⚠️ <b>CONFIRMATION</b>\n\nAre you sure you want to <b>${label}</b> vehicle <b>${deviceId}</b>?`,
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ Yes, Execute", callback_data: `final_${action}_${deviceId}` },
                { text: "❌ No", callback_data: "cancel" }
              ]]
            }
          }),
        });
      }

      // Step 3: Final Execution (After clicking 'Yes')
      if (data.startsWith("final_")) {
        const parts = data.split("_"); // ["final", "LOCK", "Andre"]
        const action = parts[1];
        const deviceId = parts[2];

        try {
          const { sendAdafruitCommand } = await import("@/lib/adafruit");
          await sendAdafruitCommand(`${action}:${deviceId}`); // Format: LOCK:Andre
          
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: cb.message.message_id,
              text: `✅ <b>SUCCESS</b>\nVehicle: <code>${deviceId}</code>\nAction: <code>${action === "LOCK" ? "KILLED" : "RESTORED"}</code>`,
              parse_mode: "HTML"
            }),
          });
        } catch (err: any) {
          await sendTelegram(chatId, `❌ <b>Failed.</b> ${err.message}`);
        }
      }
      return NextResponse.json({ ok: true });
    }

    // 2. Handle Regular Messages
    const message = update.message;
    if (!message || !message.text) return NextResponse.json({ ok: true });

    const chatId = String(message.chat.id);
    const text = message.text.toLowerCase().trim();

    // Standard Commands
    if (text === "/status") {
      const { data } = await supabase.from("user_settings").select("*").eq("telegram_chat_id", chatId).single();
      const speed = data?.speed_alerts_enabled !== false ? "ON ✅" : "OFF 🛑";
      const geofence = data?.geofence_alerts_enabled !== false ? "ON ✅" : "OFF 🛑";
      await sendTelegram(chatId, `📊 <b>Status</b>\nSpeed Alerts: ${speed}\nZone Alerts: ${geofence}`);
    } 
    else if (text === "/findme" || text === "/locate") {
      const { data: latest } = await supabase.from("telemetry").select("*").order("created_at", { ascending: false }).limit(1);
      if (latest && latest[0]) {
        const p = latest[0];
        const mapsUrl = `https://www.google.com/maps?q=${p.lat},${p.lon}`;
        await sendTelegram(chatId, `📍 <b>${p.device_id}</b>\n⚡ ${p.speed_kmh.toFixed(0)} km/h\n🌍 <a href="${mapsUrl}">Maps</a>`);
      }
    }
    else if (text === "/groupid") {
      await sendTelegram(chatId, `🆔 Chat ID: <code>${chatId}</code>`);
    }
    else if (text === "/start") {
      await sendTelegram(chatId, "👋 <b>Fleet Control</b>\n\n/findme - Locate\n/killon - Kill Relay\n/killoff - Restore Relay\n/status - Check settings");
    }
    // Kill Switch Flow Starting Point
    else if (text === "/killon" || text === "/killoff") {
      const isKill = text === "/killon";
      const cmd = isKill ? "LOCK" : "UNLOCK";
      
      const adminChatId = process.env.NEXT_PUBLIC_TELEGRAM_CHAT_ID || "1519716896";
      const isAdmin = chatId === adminChatId;

      let deviceIds: string[] = [];
      const { data: settings } = await supabase.from("user_settings").select("user_id").eq("telegram_chat_id", chatId).single();
      
      if (settings) {
        const { data: devices } = await supabase.from("user_devices").select("device_id").eq("user_id", settings.user_id);
        if (devices && devices.length > 0) deviceIds = devices.map(d => d.device_id);
      } 
      
      // Fallback for Admin
      if (deviceIds.length === 0 && isAdmin) {
        // Attempt one last check on telemetry if settings link is missing
        const { data: telemetry } = await supabase.from("telemetry").select("device_id").limit(10);
        if (telemetry && telemetry.length > 0) {
          deviceIds = Array.from(new Set(telemetry.map(t => t.device_id)));
        } else {
          // Absolute fallback for local testing
          deviceIds = ["Andre"]; 
        }
      }

      if (deviceIds.length === 0) {
        await sendTelegram(chatId, "⚠️ <b>No devices linked.</b>");
      } else {
        const keyboard = deviceIds.map(id => ([{ text: `🚗 ${id}`, callback_data: `sel_${cmd}_${id}` }]));
        keyboard.push([{ text: "❌ Cancel", callback_data: "cancel" }]);

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: `🎯 <b>SELECT VEHICLE</b>\nWhich vehicle do you want to <b>${isKill ? "KILL" : "RESTORE"}</b>?`,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: keyboard }
          }),
        });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("Webhook error:", e);
    return NextResponse.json({ ok: true });
  }
}
