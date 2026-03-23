#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <TinyGPSPlus.h>
#include <SoftwareSerial.h>
#include <ESP8266WiFi.h>
#include <ESP8266WiFiMulti.h>
#include <ArduinoOTA.h>
#include "Adafruit_MQTT.h"
#include "Adafruit_MQTT_Client.h"
#include <LittleFS.h>

// =============================================================
// 1. WIFI & ADAFRUIT IO CONFIGURATION
// =============================================================
#define WIFI_HOME_SSID  "Van Der Westhuizen_Office"
#define WIFI_HOME_PASS  "[YOUR_PASS]"
#define WIFI_HOME2_PASS "[YOUR_PASS]"
#define WIFI_SPOT_PASS  "[YOUR_PASS]"
#define WIFE_SPOT_PASS  "[YOUR_PASS]"

#define AIO_USERNAME    "Andre1980"
#define AIO_KEY "[YOUR_AIO_KEY]"

#define AIO_SERVER      "io.adafruit.com"
#define AIO_SERVERPORT  1883

// Create WiFi and MQTT objects
ESP8266WiFiMulti wifiMulti;
WiFiClient client;
Adafruit_MQTT_Client mqtt(&client, AIO_SERVER, AIO_SERVERPORT, AIO_USERNAME, AIO_KEY);

// Adafruit IO Feeds (Rate-limit safe: 3 publishes per 10s = 18/min)
Adafruit_MQTT_Publish carTracker   = Adafruit_MQTT_Publish(&mqtt, AIO_USERNAME "/feeds/cartracker/csv");
Adafruit_MQTT_Publish feed_speed   = Adafruit_MQTT_Publish(&mqtt, AIO_USERNAME "/feeds/speed");
Adafruit_MQTT_Publish group_stats  = Adafruit_MQTT_Publish(&mqtt, AIO_USERNAME "/groups/car-stats/json");
Adafruit_MQTT_Publish group_health = Adafruit_MQTT_Publish(&mqtt, AIO_USERNAME "/groups/car-health/json");
Adafruit_MQTT_Subscribe throttle   = Adafruit_MQTT_Subscribe(&mqtt, AIO_USERNAME "/throttle");

// Throttle state (millis rollover safe)
unsigned long throttleStartTime = 0;
bool isThrottled = false;

// =============================================================
// 2. HARDWARE CONFIGURATION (ESP8266 NodeMCU)
// =============================================================
Adafruit_SSD1306 display(128, 64, &Wire, -1);
#define I2C_SDA 4   // GPIO 4 (D2 on NodeMCU)
#define I2C_SCL 5   // GPIO 5 (D1 on NodeMCU)

TinyGPSPlus gps;
#define RX_PIN 12   // GPIO 12 (D6 on NodeMCU) - connect to GPS TX
#define TX_PIN 13   // GPIO 13 (D7 on NodeMCU) - connect to GPS RX
SoftwareSerial gpsSerial(RX_PIN, TX_PIN);

unsigned long lastDisplayUpdate = 0;
unsigned long lastCloudPublish = 0;
unsigned long lastSuccessfulCloudPublish = 0;
unsigned long lastGPSFixTime = 0;
unsigned long lastWiFiCheck = 0;
#define PUBLISH_INTERVAL 10000
const int utcOffset = 2; // South Africa UTC+2

// --- OFFLINE BATCH BUFFER (Memory-optimized for ESP8266: 10 x 150 = 1.5KB) ---
#define LOG_BUFFER_SIZE 10
char logBuffer[LOG_BUFFER_SIZE][150];
int logIndex = 0;

// --- Statistics Variables ---
unsigned long movingTimeSec = 0;
unsigned long stopTimeSec = 0;
float maxSpeedKmph = 0.0;
float sumMovingSpeed = 0.0;
unsigned long movingSamples = 0;
unsigned long lastStatTime = 0;

// --- History Sync Variables ---
unsigned long lastHistorySyncTime = 0;
#define SYNC_INTERVAL 7000
bool isSyncing = false;
size_t syncFilePosition = 0;

// --- Health & Storage Variables ---
unsigned long lastHealthPublish = 0;
unsigned long lastStatPublish = 0;
#define HEALTH_INTERVAL 300000   // 5 minutes
#define STATS_INTERVAL 60000     // 1 minute
#define MIN_FREE_SPACE 50000     // 50KB (ESP8266 has smaller flash)

unsigned long lastMQTTReconnectAttempt = 0;
unsigned long mqttBackoffInterval = 5000;

void MQTT_connect();
void updateOLED();
void syncHistory();

// =============================================================
// SETUP
// =============================================================
void setup() {
  Serial.begin(115200);
  delay(1000);

  client.setTimeout(2000);

  Wire.begin(I2C_SDA, I2C_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println(F("SSD1306 allocation failed"));
    for (;;);
  }

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("Connecting to WiFi:");
  display.display();

  wifiMulti.addAP(WIFI_HOME_SSID, WIFI_HOME_PASS);
  wifiMulti.addAP(WIFI_HOME2_SSID, WIFI_HOME2_PASS);
  wifiMulti.addAP(WIFI_SPOT_SSID, WIFI_SPOT_PASS);
  wifiMulti.addAP(WIFE_SPOT_SSID, WIFE_SPOT_PASS);

  Serial.println("Scanning for known WiFi networks...");
  unsigned long wifiWaitStart = millis();
  while (wifiMulti.run() != WL_CONNECTED && millis() - wifiWaitStart < 10000) {
    delay(500);
    Serial.print(".");
    yield();
  }

  display.clearDisplay();
  display.setCursor(0, 0);
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi Connected!");
    Serial.print("Connected Network: "); Serial.println(WiFi.SSID());
    Serial.print("IP Address: "); Serial.println(WiFi.localIP());
    display.println("WIFI OK");
  } else {
    Serial.println("\nBooting in OFFLINE mode.");
    display.println("OFFLINE BOOT");
  }

  ArduinoOTA.setHostname("NodeMCU-GPS-Tracker");
  ArduinoOTA.begin();

  display.println("Starting GPS...");
  display.display();

  gpsSerial.begin(9600);
  delay(1000);

  if (!LittleFS.begin()) {
    Serial.println("LittleFS Mount Failed");
  } else {
    Serial.println("LittleFS Mounted Successfully");
  }

  mqtt.subscribe(&throttle);
}

// =============================================================
// MAIN LOOP
// =============================================================
void loop() {
  ArduinoOTA.handle();

  // 15-minute cloud watchdog
  if (lastSuccessfulCloudPublish > 0 && millis() - lastSuccessfulCloudPublish > 900000) {
    Serial.println("[CRITICAL] No cloud for 15 min! Rebooting...");
    delay(1000);
    ESP.restart();
  }

  // Throttle auto-lift after 60 seconds
  if (isThrottled && millis() - throttleStartTime > 60000) {
    isThrottled = false;
    Serial.println("[CLOUD] Throttling lifted.");
  }

  // Process MQTT keepalive + throttle subscription
  if (mqtt.connected()) {
    mqtt.processPackets(10);

    Adafruit_MQTT_Subscribe *subscription;
    while ((subscription = mqtt.readSubscription(10))) {
      if (subscription == &throttle) {
        Serial.print("\n[WARNING] Adafruit IO THROTTLED: ");
        Serial.println((char *)throttle.lastread);
        isThrottled = true;
        throttleStartTime = millis();
      }
    }
  }

  // Read GPS data
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
  }

  // Calculate statistics every second
  if (millis() - lastStatTime >= 1000) {
    if (gps.location.isValid() && gps.speed.isValid()) {
      float currentSpeed = gps.speed.kmph();
      if (currentSpeed > maxSpeedKmph) maxSpeedKmph = currentSpeed;

      if (currentSpeed > 3.0) {
        movingTimeSec++;
        sumMovingSpeed += currentSpeed;
        movingSamples++;
      } else {
        stopTimeSec++;
      }
    }
    lastStatTime = millis();
  }

  // Update OLED every second
  if (millis() - lastDisplayUpdate > 1000) {
    updateOLED();
    lastDisplayUpdate = millis();
  }

  // --- MAIN PUBLISH CYCLE (every 10 seconds) ---
  if (millis() - lastCloudPublish > PUBLISH_INTERVAL) {
    if (gps.location.isValid() && gps.location.isUpdated()) {
      lastGPSFixTime = millis();
      char payload[100];
      snprintf(payload, sizeof(payload), "%d,%.6f,%.6f,%.2f",
               (int)gps.speed.kmph(), gps.location.lat(), gps.location.lng(), gps.altitude.meters());

      // --- OFFLINE BACKUP (Only if cloud is dead) ---
      if (WiFi.status() != WL_CONNECTED || !mqtt.connected() || isThrottled) {
        char timestamp[32] = "NO_TIME";
        if (gps.date.isValid() && gps.time.isValid()) {
          snprintf(timestamp, sizeof(timestamp), "%04d-%02d-%02dT%02d:%02d:%02dZ",
                   gps.date.year(), gps.date.month(), gps.date.day(),
                   gps.time.hour(), gps.time.minute(), gps.time.second());
        }

        if (logIndex < LOG_BUFFER_SIZE) {
          snprintf(logBuffer[logIndex], 150, "%s,%s\n", timestamp, payload);
          logIndex++;
        }

        if (logIndex >= LOG_BUFFER_SIZE) {
          FSInfo fs_info;
          LittleFS.info(fs_info);
          size_t freeSpace = fs_info.totalBytes - fs_info.usedBytes;

          if (freeSpace < MIN_FREE_SPACE) {
            Serial.println("[LOCAL] WARNING: Flash space critically low!");
          } else {
            if (LittleFS.exists("/gps_log.csv")) {
              File checkSize = LittleFS.open("/gps_log.csv", "r");
              if (checkSize && checkSize.size() > 500000) {
                checkSize.close();
                LittleFS.remove("/gps_log.csv");
                Serial.println("[LOCAL] Log cleared (500KB limit)");
              } else if (checkSize) {
                checkSize.close();
              }
            }
            File logFile = LittleFS.open("/gps_log.csv", "a");
            if (logFile) {
              for (int i = 0; i < logIndex; i++) {
                logFile.print(logBuffer[i]);
              }
              logFile.close();
              Serial.println("[LOCAL] Saved batch to internal memory!");
              logIndex = 0;
            } else {
              Serial.println("[LOCAL] Failed to write backup.");
            }
          }
        }
      } else {
        // Flush remaining buffer when back online
        if (logIndex > 0) {
          File logFile = LittleFS.open("/gps_log.csv", "a");
          if (logFile) {
            for (int i = 0; i < logIndex; i++) { logFile.print(logBuffer[i]); }
            logFile.close();
            logIndex = 0;
          }
        }
      }

      // --- WiFi reconnect check (every 10s) ---
      if (millis() - lastWiFiCheck >= 10000) {
        if (WiFi.status() != WL_CONNECTED) {
          if (wifiMulti.run() != WL_CONNECTED) {
            delay(10);
          }
        }
        lastWiFiCheck = millis();
      }

      // --- CLOUD PUBLISH ---
      if (WiFi.status() == WL_CONNECTED) {
        MQTT_connect();
        if (mqtt.connected()) {
          if (isThrottled) {
            Serial.println("[CLOUD] Throttled - data saved locally.");
          } else {
            Serial.println("\n==================================");
            Serial.println("[CLOUD] Pushing Live Data...");

            Serial.print("  -> Map Payload: "); Serial.println(payload);
            carTracker.publish(payload);

            Serial.print("  -> Speed: "); Serial.println((int32_t)gps.speed.kmph());
            feed_speed.publish((int32_t)gps.speed.kmph());

            // Group stats JSON (every 60s)
            if (millis() - lastStatPublish > STATS_INTERVAL) {
              Serial.println("  -> [STATS] Publishing JSON Metrics...");
              float avgSpeed = movingSamples > 0 ? (sumMovingSpeed / movingSamples) : 0.0;
              char jsonStats[200];
              snprintf(jsonStats, sizeof(jsonStats),
                       "{\"lat\":%.6f,\"lon\":%.6f,\"alt\":%.2f,\"sats\":%d,\"avg-speed\":%.1f,\"max-speed\":%.1f,\"moving-time\":%lu,\"stopped-time\":%lu}",
                       gps.location.lat(), gps.location.lng(), gps.altitude.meters(),
                       gps.satellites.value(), avgSpeed, maxSpeedKmph,
                       (movingTimeSec / 60), (stopTimeSec / 60));
              group_stats.publish(jsonStats);
              lastStatPublish = millis();
            }

            Serial.println("==================================\n");
            lastSuccessfulCloudPublish = millis();
          }
        }
      }
    }
    lastCloudPublish = millis();
  }

  // Sync offline history when connected
  if (WiFi.status() == WL_CONNECTED) {
    syncHistory();
  }

  // Health metrics (every 5 min)
  if (millis() - lastHealthPublish > HEALTH_INTERVAL) {
    if (WiFi.status() == WL_CONNECTED && mqtt.connected() && !isThrottled) {
      FSInfo fs_info;
      LittleFS.info(fs_info);
      uint32_t fsUsedPct = (fs_info.usedBytes * 100) / fs_info.totalBytes;
      uint32_t bufferedPoints = 0;

      if (LittleFS.exists("/gps_log.csv")) {
        File f = LittleFS.open("/gps_log.csv", "r");
        if (f) { bufferedPoints += f.size() / 50; f.close(); }
      }
      if (LittleFS.exists("/sync.csv")) {
        File f = LittleFS.open("/sync.csv", "r");
        if (f) { bufferedPoints += f.size() / 50; f.close(); }
      }

      char jsonHealth[100];
      snprintf(jsonHealth, sizeof(jsonHealth),
               "{\"health-heap\":%lu,\"health-fs\":%lu,\"health-buffered\":%lu}",
               (unsigned long)ESP.getFreeHeap(), (unsigned long)fsUsedPct, (unsigned long)bufferedPoints);
      group_health.publish(jsonHealth);
    }
    lastHealthPublish = millis();
  }

  // Timed buffer flush (offline only)
  static unsigned long lastBufferFlush = 0;
  if (logIndex > 0 && (WiFi.status() != WL_CONNECTED || !mqtt.connected()) && millis() - lastBufferFlush > 30000) {
    File logFile = LittleFS.open("/gps_log.csv", "a");
    if (logFile) {
      for (int i = 0; i < logIndex; i++) { logFile.print(logBuffer[i]); }
      logFile.close();
      logIndex = 0;
      Serial.println("[LOCAL] Timed flush: buffer saved to Flash.");
    }
    lastBufferFlush = millis();
  }

  // GPS freeze reboot (10 min)
  if (lastGPSFixTime > 0 && millis() - lastGPSFixTime > 600000) {
    Serial.println("[GPS] No fix for 10 min -> rebooting.");
    delay(1000);
    ESP.restart();
  }

  yield();
}

// =============================================================
// ADAFRUIT CONNECTION HELPER (NON-BLOCKING)
// =============================================================
void MQTT_connect() {
  if (mqtt.connected()) return;

  if (millis() - lastMQTTReconnectAttempt < mqttBackoffInterval) return;

  lastMQTTReconnectAttempt = millis();

  Serial.print("Connecting to MQTT... ");
  int8_t ret = mqtt.connect();

  if (ret != 0) {
    Serial.println(mqtt.connectErrorString(ret));
    mqtt.disconnect();

    mqttBackoffInterval *= 2;
    if (mqttBackoffInterval > 60000) mqttBackoffInterval = 60000;

    Serial.print("Retrying MQTT in "); Serial.print(mqttBackoffInterval / 1000); Serial.println("s.");
  } else {
    Serial.println("MQTT Connected!");
    mqttBackoffInterval = 5000;
    mqtt.subscribe(&throttle);
  }
}

// =============================================================
// OLED HELPER
// =============================================================
void updateOLED() {
  display.clearDisplay();

  // Screen saver (blank after 5 min no GPS)
  if (lastGPSFixTime > 0 && millis() > 300000 && millis() - lastGPSFixTime > 300000) {
    display.display();
    return;
  }

  if (gps.charsProcessed() < 10) {
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("Waiting for GPS");
    display.setCursor(0, 18);
    display.println("module to respond...");
    display.display();
    return;
  }

  display.setTextSize(1);
  display.setCursor(0, 4);
  display.print("Sats: "); display.print(gps.satellites.value());

  display.setCursor(56, 4);
  if (gps.date.isValid()) {
    if (gps.date.day() < 10) display.print("0");
    display.print(gps.date.day()); display.print("/");
    if (gps.date.month() < 10) display.print("0");
    display.print(gps.date.month()); display.print("/");
    display.println(gps.date.year() % 100);
  } else {
    display.print("--/--/--");
  }

  display.setCursor(105, 4);
  if (WiFi.status() == WL_CONNECTED) display.print("W+");
  else display.print("W-");

  display.drawLine(0, 15, 128, 15, SSD1306_WHITE);

  display.setCursor(0, 18);
  if (!gps.location.isValid() || (millis() - lastGPSFixTime > 10000 && lastGPSFixTime > 0)) {
    display.println(">> GPS SIGNAL LOST <<");
    display.println("Searching...");
  } else if (gps.location.isValid()) {
    display.print("Lat: "); display.println(gps.location.lat(), 6);
    display.print("Lon: "); display.println(gps.location.lng(), 6);
  } else {
    display.println("Lat: ---"); display.println("Lon: ---");
  }

  display.setCursor(0, 36);
  display.print("Alt: ");
  if (gps.altitude.isValid()) {
    display.print((int)gps.altitude.meters()); display.print("m");
  } else {
    display.print("---");
  }
  display.print("  Spd: ");
  if (gps.speed.isValid()) {
    display.print((int)gps.speed.kmph());
  } else {
    display.print("-");
  }

  display.setCursor(0, 52);
  display.drawLine(0, 48, 128, 48, SSD1306_WHITE);

  int toggle = (millis() / 4000) % 3;

  if (toggle == 0) {
    display.print("Time: ");
    if (gps.time.isValid()) {
      int localHour = (gps.time.hour() + utcOffset) % 24;
      if (localHour < 10) display.print("0");
      display.print(localHour); display.print(":");
      if (gps.time.minute() < 10) display.print("0");
      display.print(gps.time.minute()); display.print(":");
      if (gps.time.second() < 10) display.print("0");
      display.println(gps.time.second());
    } else {
      display.println("--:--:--");
    }
  } else if (toggle == 1) {
    float avgSpeed = movingSamples > 0 ? (sumMovingSpeed / movingSamples) : 0.0;
    display.print("Avg:"); display.print((int)avgSpeed);
    display.print(" Max:"); display.println((int)maxSpeedKmph);
  } else {
    display.print("Mov:"); display.print(movingTimeSec / 60); display.print("m");
    display.print(" Stp:"); display.print(stopTimeSec / 60); display.println("m");
  }
  display.display();
}

// =============================================================
// HISTORY SYNC HELPER (BACKFILLING WITH TIMESTAMPS)
// =============================================================
void syncHistory() {
  static uint8_t syncRetries = 0;
  static size_t lastSavedIndexPos = 0;

  if (millis() - lastHistorySyncTime < SYNC_INTERVAL) return;
  if (isThrottled) return;

  if (!isSyncing) {
    if (LittleFS.exists("/sync.csv")) {
      isSyncing = true;
      if (LittleFS.exists("/sync.idx")) {
        File idxFile = LittleFS.open("/sync.idx", "r");
        if (idxFile) {
          String idxStr = idxFile.readStringUntil('\n');
          syncFilePosition = idxStr.toInt();
          lastSavedIndexPos = syncFilePosition;
          idxFile.close();
        }
      } else {
        syncFilePosition = 0;
      }
      Serial.print("\n[SYNC] Resuming sync.csv at byte: "); Serial.println(syncFilePosition);
    } else if (LittleFS.exists("/gps_log.csv")) {
      LittleFS.rename("/gps_log.csv", "/sync.csv");
      isSyncing = true;
      syncFilePosition = 0;
      lastSavedIndexPos = 0;
      LittleFS.remove("/sync.idx");
      Serial.println("\n[SYNC] Found offline history. Starting backfill...");
    } else {
      return;
    }
  }

  if (isSyncing) {
    File sFile = LittleFS.open("/sync.csv", "r");
    if (!sFile) {
      isSyncing = false;
      return;
    }

    sFile.seek(syncFilePosition);
    yield();

    char lineBuffer[150];
    int len = sFile.readBytesUntil('\n', lineBuffer, sizeof(lineBuffer) - 1);
    lineBuffer[len] = '\0';

    if (len > 0) {
      int commaCount = 0;
      for (int i = 0; i < len; i++) {
        if (lineBuffer[i] == ',') commaCount++;
      }

      if (commaCount >= 4) {
        char* firstComma = strchr(lineBuffer, ',');
        if (firstComma != NULL) {
          *firstComma = '\0';
          char* savedTimestamp = lineBuffer;
          char* dataToPush = firstComma + 1;

          MQTT_connect();
          if (mqtt.connected()) {
            char jsonPayload[200];
            if (strlen(savedTimestamp) > 5 && savedTimestamp[0] == '2') {
              snprintf(jsonPayload, sizeof(jsonPayload),
                       "{\"value\":\"%s\",\"created_at\":\"%s\"}",
                       dataToPush, savedTimestamp);
              Serial.print("[SYNC] Uploading: "); Serial.println(jsonPayload);
            } else {
              snprintf(jsonPayload, sizeof(jsonPayload), "%s", dataToPush);
              Serial.print("[SYNC] Uploading (no ts): "); Serial.println(jsonPayload);
            }
            if (carTracker.publish(jsonPayload)) {
              lastHistorySyncTime = millis();
              syncFilePosition = sFile.position();
              syncRetries = 0;

              if (syncFilePosition - lastSavedIndexPos > 1024) {
                File idxFile = LittleFS.open("/sync.idx", "w");
                if (idxFile) {
                  idxFile.print(syncFilePosition);
                  idxFile.close();
                  lastSavedIndexPos = syncFilePosition;
                }
              }
            } else {
              Serial.println("[SYNC] Upload Failed - retrying.");
              syncRetries++;
              if (syncRetries >= 3) {
                Serial.println("[SYNC] Bypassing corrupted line.");
                syncFilePosition = sFile.position();
                syncRetries = 0;
              }
            }
          }
        }
      } else {
        Serial.println("[SYNC] Skipping corrupted line.");
        syncFilePosition = sFile.position();
      }
    }

    if (!sFile.available()) {
      isSyncing = false;
      sFile.close();
      LittleFS.remove("/sync.csv");
      LittleFS.remove("/sync.idx");
      Serial.println("[SYNC] History upload complete!\n");
      return;
    }

    sFile.close();
  }
}
