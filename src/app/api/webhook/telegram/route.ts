import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { createClient } from "@supabase/supabase-js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEBUG_LOG_ENDPOINT =
  "http://127.0.0.1:7727/ingest/2d46f0c7-4e8b-4db0-80aa-a61519a17974";
const DEBUG_SESSION_ID = "b56b0f";

// Webhook requests come without an authenticated user; anon-key + RLS can return 0 rows.
// For Telegram reads (latest position / settings), use the service-role key.
const supabaseService =
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

async function sendTelegram(chatId: string, text: string) {
  if (!BOT_TOKEN) {
    // #region agent log
    console.log("[TelegramWebhook][sendTelegram] BOT_TOKEN missing; skipping send", { chatId });
    fetch(DEBUG_LOG_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": DEBUG_SESSION_ID,
      },
      body: JSON.stringify({
        sessionId: DEBUG_SESSION_ID,
        runId: "pre-debug",
        hypothesisId: "H2",
        location: "src/app/api/webhook/telegram/route.ts:sendTelegram-missing-token",
        message: "BOT_TOKEN missing; sendTelegram skipped",
        data: {},
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    return;
  }
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  let ok = false;
  let status: number | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    console.log("[TelegramWebhook][sendTelegram] sendMessage result", { chatId, ok: res.ok, status: res.status });
    ok = res.ok;
    status = res.status;
  } catch (e: any) {
    // #region agent log
    console.log("[TelegramWebhook][sendTelegram] fetch threw", { chatId, err: e?.message || String(e) });
    fetch(DEBUG_LOG_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": DEBUG_SESSION_ID,
      },
      body: JSON.stringify({
        sessionId: DEBUG_SESSION_ID,
        runId: "pre-debug",
        hypothesisId: "H2",
        location: "src/app/api/webhook/telegram/route.ts:sendTelegram-fetch-error",
        message: "Telegram sendMessage fetch threw",
        data: { errorMessage: e?.message || String(e) },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    throw e;
  }

  // #region agent log
  fetch(DEBUG_LOG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION_ID,
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      runId: "pre-debug",
      hypothesisId: "H2",
      location: "src/app/api/webhook/telegram/route.ts:sendTelegram-result",
      message: "Telegram sendMessage completed",
      data: { ok, status },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
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
    const rawText = message.text;
    const text = message.text.toLowerCase().trim();

    // #region agent log
    console.log("[TelegramWebhook][cmd]", {
      chatId,
      rawText,
      normalizedText: text,
      hasAt: text.includes("@"),
      equalsFindme: text === "/findme",
      equalsLocate: text === "/locate",
    });
    fetch(DEBUG_LOG_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": DEBUG_SESSION_ID,
      },
      body: JSON.stringify({
        sessionId: DEBUG_SESSION_ID,
        runId: "pre-debug",
        hypothesisId: "H3",
        location: "src/app/api/webhook/telegram/route.ts:command-normalization",
        message: "Telegram regular command text received",
        data: {
          rawText,
          normalizedText: text,
          hasAt: text.includes("@"),
          equalsFindme: text === "/findme",
          equalsLocate: text === "/locate",
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    // Standard Commands
    if (text === "/status") {
      const client = supabaseService ?? supabase;
      const { data } = await client.from("user_settings").select("*").eq("telegram_chat_id", chatId).single();
      const speed = data?.speed_alerts_enabled !== false ? "ON ✅" : "OFF 🛑";
      const geofence = data?.geofence_alerts_enabled !== false ? "ON ✅" : "OFF 🛑";
      await sendTelegram(chatId, `📊 <b>Status</b>\nSpeed Alerts: ${speed}\nZone Alerts: ${geofence}`);
    } 
    else if (text === "/findme" || text === "/locate") {
      // #region agent log
      console.log("[TelegramWebhook] entered findme/locate branch", { chatId, normalizedText: text });
      fetch(DEBUG_LOG_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Debug-Session-Id": DEBUG_SESSION_ID,
        },
        body: JSON.stringify({
          sessionId: DEBUG_SESSION_ID,
          runId: "pre-debug",
          hypothesisId: "H4",
          location: "src/app/api/webhook/telegram/route.ts:findme-branch",
          message: "Entered /findme or /locate branch",
          data: {
            normalizedText: text,
            botTokenConfigured: !!BOT_TOKEN,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion

      const client = supabaseService ?? supabase;

      // Resolve which device(s) belong to this Telegram user, then fetch latest telemetry for those.
      const { data: settings } = await client
        .from("user_settings")
        .select("user_id")
        .eq("telegram_chat_id", chatId)
        .single();

      const userId = settings?.user_id;
      console.log("[TelegramWebhook] /findme user_settings lookup", {
        chatId,
        hasUserId: !!userId,
      });
      if (!userId) {
        await sendTelegram(chatId, "⚠️ <b>No devices linked</b> for this Telegram chat.");
        return NextResponse.json({ ok: true });
      }

      const { data: devices } = await client
        .from("user_devices")
        .select("device_id")
        .eq("user_id", userId);

      const deviceIds = (devices || []).map((d: any) => d.device_id).filter(Boolean);
      console.log("[TelegramWebhook] /findme user_devices lookup", {
        chatId,
        userId,
        deviceIdsCount: deviceIds.length,
        deviceIdsPreview: deviceIds.slice(0, 5),
      });
      if (deviceIds.length === 0) {
        await sendTelegram(chatId, "⚠️ <b>No devices linked</b> for this Telegram chat.");
        return NextResponse.json({ ok: true });
      }

      const { data: latest, error } = await client
        .from("telemetry")
        .select("*")
        .in("device_id", deviceIds)
        .order("created_at", { ascending: false })
        .limit(1);

      // #region agent log
      console.log("[TelegramWebhook] supabase telemetry query result", {
        chatId,
        hasLatest: !!(latest && latest[0]),
        latestLen: Array.isArray(latest) ? latest.length : null,
        usingServiceRole: !!supabaseService,
        deviceIdsCount: deviceIds.length,
        supabaseError: error ? { message: error.message, code: (error as any).code } : null,
      });
      fetch(DEBUG_LOG_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Debug-Session-Id": DEBUG_SESSION_ID,
        },
        body: JSON.stringify({
          sessionId: DEBUG_SESSION_ID,
          runId: "pre-debug",
          hypothesisId: "H1",
          location: "src/app/api/webhook/telegram/route.ts:findme-supabase-query",
          message: "Supabase telemetry query result for /findme",
          data: {
            hasLatest: !!(latest && latest[0]),
            latestLen: Array.isArray(latest) ? latest.length : null,
            error: error ? { message: error.message, code: (error as any).code } : null,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion

      if (latest && latest[0]) {
        const p = latest[0];
        const mapsUrl = `https://www.google.com/maps?q=${p.lat},${p.lon}`;
        await sendTelegram(chatId, `📍 <b>${p.device_id}</b>\n⚡ ${p.speed_kmh.toFixed(0)} km/h\n🌍 <a href="${mapsUrl}">Maps</a>`);
      }
    }
    else if (text === "/groupid") {
      await sendTelegram(chatId, `🆔 Chat ID: <code>${chatId}</code>`);
    }
    else if (text === "/start" || text === "/help") {
      const helpMsg = `🤖 <b>Fleet Control Assistant</b>

/findme - Get current location
/killon - Remotely disable vehicle
/killoff - Remotely enable vehicle
/status - Check alert settings
/groupid - Get Chat ID for dashboard
/help - Show this menu`;
      await sendTelegram(chatId, helpMsg);
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
