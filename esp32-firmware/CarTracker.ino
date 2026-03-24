#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Arduino.h>
#include <ArduinoOTA.h>
#include "Adafruit_MQTT.h"
#include "Adafruit_MQTT_Client.h"
#include <HardwareSerial.h>
#include <LittleFS.h>
#include <TinyGPSPlus.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <Wire.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

// =============================================================
// ESP32 CAR TRACKER - STABILITY OPTIMIZED
// =============================================================
#include "secrets.h"

#define AIO_SERVER "io.adafruit.com"
#define AIO_SERVERPORT 1883

WiFiMulti wifiMulti;
WiFiClient client;
Adafruit_MQTT_Client mqtt(&client, AIO_SERVER, AIO_SERVERPORT, AIO_USERNAME, AIO_KEY);
Adafruit_MQTT_Publish carTracker = Adafruit_MQTT_Publish(&mqtt, AIO_USERNAME "/feeds/cartracker2.csv");
Adafruit_MQTT_Subscribe throttle = Adafruit_MQTT_Subscribe(&mqtt, AIO_USERNAME "/feeds/cartracker2.throttle");

// Hardware
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
TinyGPSPlus gps;
HardwareSerial gpsSerial(2);

#define RELAY_PIN 2
#define NEOPIXEL_PIN 48 // S3 Native RGB

unsigned long lastCloudPublish = 0;
unsigned long lastDisplayUpdate = 0;
unsigned long lastSyncCheck = 0;
const unsigned long PUBLISH_INTERVAL = 10000;
const unsigned long SYNC_INTERVAL = 15000;
size_t lastSyncOffset = 0; 

void MQTT_connect();
void processOfflineSync();
void pushToSupabase(double lat, double lon, double speed, double alt, int sats, const char* timestamp = nullptr);

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.printf("\n\n--- BOOTING DEVICE: %s ---\n", DEVICE_ID);

  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println(F("OLED Failed"));
  }
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0,0);
  display.print("STABLE MODE: "); display.println(DEVICE_ID);
  display.display();

  wifiMulti.addAP(WIFI_HOME_SSID, WIFI_HOME_PASS);
  wifiMulti.addAP(WIFI_HOME2_SSID, WIFI_HOME2_PASS);
  wifiMulti.addAP(WIFI_SPOT_SSID, WIFI_SPOT_PASS);
  wifiMulti.addAP(WIFE_SPOT_SSID, WIFE_SPOT_PASS);

  Serial.println("Connecting WiFi...");
  unsigned long start = millis();
  while (wifiMulti.run() != WL_CONNECTED && millis() - start < 10000) {
    delay(500); 
    Serial.print(".");
    yield(); // Keep watchdog alive during WiFi wait
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi OK!");
  } else {
    Serial.println("\nWiFi Offline");
  }

  gpsSerial.begin(9600, SERIAL_8N1, 16, 17);
  
  if (!LittleFS.begin(true)) {
    Serial.println("FS Error");
  } else {
    Serial.println("FS Mounted");
  }

  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, HIGH);
  
  // Initialize LED to Green (Native)
  neopixelWrite(NEOPIXEL_PIN, 0, 50, 0); 
  
  mqtt.subscribe(&throttle);
  ArduinoOTA.begin();
}

void loop() {
  ArduinoOTA.handle();
  yield(); // Important for OS

  if (WiFi.status() == WL_CONNECTED) {
    MQTT_connect();
  }

  // Handle Commands
  Adafruit_MQTT_Subscribe *subscription;
  while ((subscription = mqtt.readSubscription(10))) {
    if (subscription == &throttle) {
      String cmd = String((char *)throttle.lastread);
      Serial.println("[CMD] " + cmd);
      if (cmd.startsWith("LOCK")) {
        digitalWrite(RELAY_PIN, LOW);
        neopixelWrite(NEOPIXEL_PIN, 100, 0, 0);
      } else if (cmd.startsWith("UNLOCK")) {
        digitalWrite(RELAY_PIN, HIGH);
        neopixelWrite(NEOPIXEL_PIN, 0, 100, 0);
      }
    }
    yield();
  }

  // Process GPS
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
    yield(); 
  }

  // Periodic Telemetry (Only push if location is fresh/updated)
  if (millis() - lastCloudPublish > PUBLISH_INTERVAL) {
    if (gps.location.isValid() && gps.location.isUpdated()) {
      if (mqtt.connected()) {
        String csv = String(gps.location.lat(), 6) + "," + String(gps.location.lng(), 6) + "," + String(gps.speed.kmph()) + "," + String(gps.altitude.meters());
        carTracker.publish(csv.c_str());
        Serial.println("[AIO] Published: " + csv);
      }
      pushToSupabase(gps.location.lat(), gps.location.lng(), gps.speed.kmph(), gps.altitude.meters(), gps.satellites.value());
      
      // Only save local backup if we have a valid time fix (prevents dashboard jumps)
      if (gps.time.isValid()) {
        File f = LittleFS.open("/history.csv", FILE_APPEND);
        if (f) {
          char ts[32];
          snprintf(ts, 32, "%04d-%02d-%02dT%02d:%02d:%02dZ", gps.date.year(), gps.date.month(), gps.date.day(), gps.time.hour(), gps.time.minute(), gps.time.second());
          f.printf("%s,%.6f,%.6f,%.1f,%.1f,%d\n", ts, gps.location.lat(), gps.location.lng(), gps.speed.kmph(), gps.altitude.meters(), (int)gps.satellites.value());
          f.close();
        }
      }
    }
    lastCloudPublish = millis();
    yield();
  }

  // Sync History (Watchdog-safe batching)
  if (WiFi.status() == WL_CONNECTED && (millis() - lastSyncCheck > SYNC_INTERVAL)) {
    processOfflineSync();
    lastSyncCheck = millis();
    yield();
  }

  if (millis() - lastDisplayUpdate > 5000) {
    display.clearDisplay();
    display.setCursor(0,0);
    display.printf("Sats: %d\n", gps.satellites.value());
    display.printf("Lat: %.4f\n", gps.location.lat());
    display.printf("Lon: %.4f\n", gps.location.lng());
    display.printf("Net: %s\n", (WiFi.status() == WL_CONNECTED ? "OK" : "ERR"));
    display.display();
    lastDisplayUpdate = millis();
    yield();
  }
}

void processOfflineSync() {
  const char* syncFile = "/sync.csv";
  const char* historyFile = "/history.csv";

  // 1. Prepare sync snapshot if needed
  if (!LittleFS.exists(syncFile)) {
    if (!LittleFS.exists(historyFile)) return;
    
    // Rename history to sync to allow new data to accumulate in a fresh history.csv
    if (LittleFS.rename(historyFile, syncFile)) {
      Serial.println("[SYNC] Snapshotted history.csv -> sync.csv");
      lastSyncOffset = 0;
    } else {
      Serial.println("[SYNC] Rename failed!");
      return;
    }
  }

  // 2. Open sync file
  File f = LittleFS.open(syncFile, FILE_READ);
  if (!f) return;

  // 3. Seek to last known offset
  if (lastSyncOffset > f.size()) lastSyncOffset = 0;
  f.seek(lastSyncOffset);

  Serial.printf("[SYNC] Processing batch from offset %u...\n", lastSyncOffset);
  int count = 0;
  while (f.available() && count < 5) {
    String line = f.readStringUntil('\n');
    lastSyncOffset = f.position(); // Keep track of progress
    line.trim();
    if (line.length() < 10) continue;

    int first = line.indexOf(',');
    int second = line.indexOf(',', first+1);
    int third = line.indexOf(',', second+1);

    if (first > 0 && second > 0) {
      String ts = line.substring(0, first);
      
      // CRITICAL: Skip any points that don't have a valid GPS timestamp
      // These cause "location jumps" on the dashboard because Supabase assigns them the current time.
      if (ts == "NO_TS") {
        Serial.println("[SYNC] Skipping line with NO_TS");
        count++; // Still count towards batch limit to give WiFi a break
        continue;
      }

      String lt = line.substring(first+1, second);
      String ln = line.substring(second+1, (third > 0 ? third : line.length()));
      
      int fourth = line.indexOf(',', third+1);
      int fifth = line.indexOf(',', fourth+1);
      
      String sp = (third > 0 ? line.substring(third+1, (fourth > 0 ? fourth : line.length())) : "0");
      String al = (fourth > 0 ? line.substring(fourth+1, (fifth > 0 ? fifth : line.length())) : "0");
      String sa = (fifth > 0 ? line.substring(fifth+1) : "0");

      pushToSupabase(lt.toDouble(), ln.toDouble(), sp.toDouble(), al.toDouble(), sa.toInt(), ts.c_str());
      count++;
      yield();   
    }
  }
  
  bool finished = !f.available();
  f.close();

  // 4. Cleanup if finished
  if (finished) {
    LittleFS.remove(syncFile);
    lastSyncOffset = 0;
    Serial.println("[SYNC] Finished and deleted sync.csv.");
  }
}

void pushToSupabase(double lat, double lon, double speed, double alt, int sats, const char* timestamp) {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClientSecure secureClient;
  secureClient.setInsecure();
  secureClient.setTimeout(2); // VERY SHORT timeout to prevent watchdog trigger

  HTTPClient http;
  String url = String(SUPABASE_URL) + "/rest/v1/telemetry";
  http.begin(secureClient, url);
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", "Bearer " + String(SUPABASE_ANON_KEY));
  http.addHeader("Content-Type", "application/json");

  char json[350];
  if (timestamp) {
    snprintf(json, 350, "{\"device_id\":\"%s\",\"lat\":%.6f,\"lon\":%.6f,\"speed_kmh\":%.1f,\"altitude_m\":%.1f,\"satellites\":%d,\"created_at\":\"%s\"}", DEVICE_ID, lat, lon, speed, alt, sats, timestamp);
  } else {
    snprintf(json, 350, "{\"device_id\":\"%s\",\"lat\":%.6f,\"lon\":%.6f,\"speed_kmh\":%.1f,\"altitude_m\":%.1f,\"satellites\":%d}", DEVICE_ID, lat, lon, speed, alt, sats);
  }

  int code = http.POST(json);
  Serial.printf("  -> [SUPABASE] Code %d\n", code);
  http.end();
  yield();
}

void MQTT_connect() {
  if (mqtt.connected()) return;
  Serial.print("Connecting MQTT...");
  if (mqtt.connect() == 0) Serial.println("OK");
  else { Serial.println("FAIL"); mqtt.disconnect(); }
  yield();
}
