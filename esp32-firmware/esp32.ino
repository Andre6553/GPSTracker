// =============================================================
// ESP32 Car Tracker with Remote Kill Switch
// =============================================================

#include <Arduino.h>
#include <TinyGPS++.h>
#include <HardwareSerial.h>
#include <LittleFS.h>
#include "secrets.h"

// --- SETTINGS ---
String deviceId = "ESP32-Car2";
const int SYNC_INTERVAL_MS = 10000;
const int HEARTBEAT_INTERVAL_MS = 60000;

// --- HARDWARE ---
HardwareSerial gpsSerial(2); // ESP32 UART2 (Pins 16/17 default)
TinyGPSPlus gps;

#define RELAY_PIN 2
#define NEOPIXEL_PIN 48 

// --- STATE ---
unsigned long lastSync = 0;
unsigned long lastHeartbeat = 0;

void setup() {
  Serial.begin(115200);
  gpsSerial.begin(9600, SERIAL_8N1, 16, 17);

  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS Mount Failed");
  } else {
    Serial.println("LittleFS Mounted Successfully");
  }

  // --- HARDWARE INITIALIZATION ---
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, HIGH); // Default: Unlocked

  // DIAGNOSTIC NeoPixel Initialization (using native neopixelWrite)
  Serial.print("[LED] Testing NeoPixel on Pin: ");
  Serial.println(NEOPIXEL_PIN);
  
  // Test Orange color
  neopixelWrite(NEOPIXEL_PIN, 100, 50, 0); 
  delay(100); 
  Serial.println("[LED] Test color shown.");
}

void loop() {
  // Process GPS
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
  }

  // Periodic Telemetry Sync
  if (millis() - lastSync > SYNC_INTERVAL_MS) {
    if (gps.location.isValid()) {
      sendTelemetry();
    }
    lastSync = millis();
  }

  // Periodic Heartbeat
  if (millis() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
    sendHeartbeat();
    lastHeartbeat = millis();
  }

  // Handle Serial Commands (for local testing)
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd == "LOCK") {
      digitalWrite(RELAY_PIN, LOW);
      neopixelWrite(NEOPIXEL_PIN, 100, 0, 0); // RED
      Serial.println("VEHICLE LOCKED");
    } else if (cmd == "UNLOCK") {
      digitalWrite(RELAY_PIN, HIGH);
      neopixelWrite(NEOPIXEL_PIN, 0, 100, 0); // GREEN
      Serial.println("VEHICLE UNLOCKED");
    }
  }
}

void sendTelemetry() {
  Serial.print("TELEMETRY: ");
  Serial.print(gps.location.lat(), 6);
  Serial.print(",");
  Serial.println(gps.location.lng(), 6);
}

void sendHeartbeat() {
  Serial.println("HEARTBEAT: OK");
}
