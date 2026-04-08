//ver3.4 4/8/2026 16:45
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
#include <Wire.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <WebServer.h>

// =============================================================
// ESP32 CAR TRACKER - STABILITY OPTIMIZED
// =============================================================
#include "secrets.h"

#define AIO_SERVER "io.adafruit.com"
#define AIO_SERVERPORT 1883

WiFiClient client;
Adafruit_MQTT_Client mqtt(&client, AIO_SERVER, AIO_SERVERPORT, AIO_USERNAME, AIO_KEY);
Adafruit_MQTT_Publish carTracker = Adafruit_MQTT_Publish(&mqtt, AIO_USERNAME "/feeds/cartracker2.csv");
Adafruit_MQTT_Subscribe throttle = Adafruit_MQTT_Subscribe(&mqtt, AIO_USERNAME "/feeds/cartracker2.throttle");

// Hardware
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
// Dual-color SSD1306: ~16px top is yellow; keep title bar full height so body text starts in blue zone only
#define OLED_COLOR_SPLIT_Y 16
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
TinyGPSPlus gps;
HardwareSerial gpsSerial(2);

#define RELAY_PIN 2
#define NEOPIXEL_PIN 48 // S3 Native RGB

unsigned long lastCloudPublish = 0;
unsigned long lastDisplayUpdate = 0;
unsigned long lastSyncCheck = 0;
unsigned long lastWifiReconnectAttempt = 0;
unsigned long lastWifiPriorityCheck = 0;
unsigned long wifiOfflineSinceMs = 0;
bool showWifiInfoPanel = false;
bool otaReady = false;
int failedReconnectCycles = 0;
// GPS / cloud / LittleFS log cadence (smoother trails vs storage & bandwidth)
const unsigned long PUBLISH_INTERVAL = 5000;
const unsigned long SYNC_INTERVAL = 15000;
size_t lastSyncOffset = 0;

// Reject stale coordinates if NMEA hasn't refreshed location (ms). Tunnel / loss-of-lock guard.
const unsigned long MAX_FIX_AGE_MS = 45000;
const unsigned long WIFI_CONNECT_ATTEMPT_MS = 10000;
const unsigned long WIFI_RECONNECT_INTERVAL_MS = 15000;
const unsigned long WIFI_PRIORITY_RECHECK_MS = 20000;
const unsigned long WIFI_CLOUD_CHECK_TIMEOUT_MS = 3000;
const unsigned long WIFI_FORCE_AP_AFTER_OFFLINE_MS = 60000;
const unsigned long OLED_OFFLINE_HEADER_BLINK_MS = 500;
const int WIFI_MAX_RECONNECT_CYCLES_BEFORE_AP = 2;
const int MAX_CUSTOM_NETWORKS = 3;

Preferences wifiPrefs;
WebServer configServer(80);
String customSsids[MAX_CUSTOM_NETWORKS];
String customPasses[MAX_CUSTOM_NETWORKS];
bool configPortalShouldExit = false;
bool configPortalActive = false;
bool configRoutesInitialized = false;

void MQTT_connect();
void processOfflineSync();
bool pushToSupabase(double lat, double lon, double speed, double alt, int sats, const char* timestamp = nullptr);
void renderDashboardOLED();
bool connectToSsid(const char* ssid, const char* pass, unsigned long timeoutMs);
bool connectWifiWithPriority(unsigned long timeoutPerNetworkMs);
int getScanRssiBySsid(const char* ssid, int scanCount);
void initOta();
bool isCurrentHotspotConnection();
bool hasCloudReachability();
void loadCustomNetworks();
bool saveCustomNetwork(const String& ssid, const String& pass);
bool connectBestCustomNetwork(int scanCount, unsigned long timeoutPerNetworkMs);
bool startConfigPortal();
bool isAnyKnownNetworkVisible();
void showOledStatus(const char* title, const String& line1, const String& line2 = "", const String& line3 = "");

void showOledStatus(const char* title, const String& line1, const String& line2, const String& line3) {
  display.clearDisplay();
  const bool wifiUp = (WiFi.status() == WL_CONNECTED);
  const bool headerLit = wifiUp || (((millis() / OLED_OFFLINE_HEADER_BLINK_MS) % 2) == 0);
  if (headerLit) {
    display.fillRect(0, 0, SCREEN_WIDTH, OLED_COLOR_SPLIT_Y, SSD1306_WHITE);
  }
  display.setTextSize(1);
  display.setTextColor(headerLit ? SSD1306_BLACK : SSD1306_WHITE);
  display.setCursor(3, 3);
  display.print(title);
  display.setTextColor(SSD1306_WHITE);
  int y = OLED_COLOR_SPLIT_Y + 1;
  const int maxCharsPerRow = SCREEN_WIDTH / 6;  // Default 5x7 font with 1px spacing.
  const int lineHeight = 10;
  const int maxY = SCREEN_HEIGHT - 8;

  auto drawWrapped = [&](const String& text) {
    if (text.length() == 0) return;
    int start = 0;
    while (start < text.length() && y <= maxY) {
      int remaining = text.length() - start;
      int take = remaining < maxCharsPerRow ? remaining : maxCharsPerRow;
      display.setCursor(0, y);
      display.print(text.substring(start, start + take));
      y += lineHeight;
      start += take;
    }
  };

  drawWrapped(line1);
  drawWrapped(line2);
  drawWrapped(line3);
  display.display();
}

bool connectToSsid(const char* ssid, const char* pass, unsigned long timeoutMs) {
  if (!ssid || !ssid[0]) return false;
  Serial.printf("\n[WiFi] Trying: %s\n", ssid);
  showOledStatus("WIFI CONNECT", String("Trying: ") + ssid, "Please wait...");
  WiFi.disconnect(true, true);
  delay(100);
  WiFi.begin(ssid, pass);
  const unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(300);
    Serial.print(".");
    yield();
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected: %s RSSI=%ld\n", WiFi.SSID().c_str(), WiFi.RSSI());
    showOledStatus("WIFI CONNECT", "Connected:", WiFi.SSID(), String("RSSI ") + String(WiFi.RSSI()));
    if (!hasCloudReachability()) {
      Serial.println("[WiFi] Connected SSID has no cloud reachability. Trying next network...");
      showOledStatus("WIFI CONNECT", "No cloud on:", WiFi.SSID(), "Trying next...");
      WiFi.disconnect(true, true);
      delay(100);
      return false;
    }
    return true;
  }
  Serial.println("\n[WiFi] Failed");
  return false;
}

bool connectBestCustomNetwork(int scanCount, unsigned long timeoutPerNetworkMs) {
  int bestSlot = -1;
  int bestRssi = -1000;
  for (int i = 0; i < MAX_CUSTOM_NETWORKS; i++) {
    if (customSsids[i].length() == 0) continue;
    const int rssi = (scanCount > 0) ? getScanRssiBySsid(customSsids[i].c_str(), scanCount) : -1000;
    if (rssi > bestRssi) {
      bestRssi = rssi;
      bestSlot = i;
    }
  }
  if (bestSlot >= 0 && bestRssi > -1000) {
    return connectToSsid(customSsids[bestSlot].c_str(), customPasses[bestSlot].c_str(), timeoutPerNetworkMs);
  }
  return false;
}

bool hasCloudReachability() {
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClientSecure secureClient;
  secureClient.setInsecure();
  secureClient.setTimeout(WIFI_CLOUD_CHECK_TIMEOUT_MS / 1000);

  HTTPClient http;
  const String url = String(SUPABASE_URL) + "/rest/v1/";
  if (!http.begin(secureClient, url)) return false;
  http.setTimeout((int)WIFI_CLOUD_CHECK_TIMEOUT_MS);
  http.addHeader("apikey", SUPABASE_ANON_KEY);
  http.addHeader("Authorization", "Bearer " + String(SUPABASE_ANON_KEY));
  const int code = http.GET();
  http.end();
  // 2xx means reachable and accepted. 401/404 also prove internet path to Supabase.
  return (code >= 200 && code < 500);
}

int getScanRssiBySsid(const char* ssid, int scanCount) {
  if (!ssid || !ssid[0] || scanCount <= 0) return -1000;
  int best = -1000;
  for (int i = 0; i < scanCount; i++) {
    if (WiFi.SSID(i) == String(ssid)) {
      const int rssi = WiFi.RSSI(i);
      if (rssi > best) best = rssi;
    }
  }
  return best;
}

bool connectWifiWithPriority(unsigned long timeoutPerNetworkMs) {
  // Rule: if hotspot is available, always use hotspot; otherwise pick strongest home Wi-Fi.
  Serial.println("[WiFi] Scanning nearby networks...");
  showOledStatus("WIFI SCAN", "Looking hotspots...", "Looking known WiFi...");
  const int n = WiFi.scanNetworks(false, true);
  const bool haveScan = n > 0;

  const int rssiSpot1 = haveScan ? getScanRssiBySsid(WIFI_SPOT_SSID, n) : -1000;
  const int rssiSpot2 = haveScan ? getScanRssiBySsid(WIFE_SPOT_SSID, n) : -1000;
  if (rssiSpot1 > -1000 || rssiSpot2 > -1000) {
    const bool useSpot1 = (rssiSpot1 >= rssiSpot2);
    const char* spotSsid = useSpot1 ? WIFI_SPOT_SSID : WIFE_SPOT_SSID;
    const char* spotPass = useSpot1 ? WIFI_SPOT_PASS : WIFE_SPOT_PASS;
    Serial.printf("[WiFi] Hotspot detected. Picking strongest hotspot (%s, %d dBm)\n",
                  spotSsid, useSpot1 ? rssiSpot1 : rssiSpot2);
    WiFi.scanDelete();
    return connectToSsid(spotSsid, spotPass, timeoutPerNetworkMs);
  }

  const char* bestHomeSsid = nullptr;
  const char* bestHomePass = nullptr;
  int bestHomeRssi = -1000;
  const int rssiHome1 = haveScan ? getScanRssiBySsid(WIFI_HOME_SSID, n) : -1000;
  const int rssiHome2 = haveScan ? getScanRssiBySsid(WIFI_HOME2_SSID, n) : -1000;
  if (rssiHome1 > bestHomeRssi) {
    bestHomeRssi = rssiHome1;
    bestHomeSsid = WIFI_HOME_SSID;
    bestHomePass = WIFI_HOME_PASS;
  }
  if (rssiHome2 > bestHomeRssi) {
    bestHomeRssi = rssiHome2;
    bestHomeSsid = WIFI_HOME2_SSID;
    bestHomePass = WIFI_HOME2_PASS;
  }
  #ifdef WIFI_HOME3_SSID
  const int rssiHome3 = haveScan ? getScanRssiBySsid(WIFI_HOME3_SSID, n) : -1000;
  if (rssiHome3 > bestHomeRssi) {
    bestHomeRssi = rssiHome3;
    bestHomeSsid = WIFI_HOME3_SSID;
    bestHomePass = WIFI_HOME3_PASS;
  }
  #endif
  WiFi.scanDelete();

  if (bestHomeSsid) {
    Serial.printf("[WiFi] No hotspot found. Picking strongest home Wi-Fi (%s, %d dBm)\n",
                  bestHomeSsid, bestHomeRssi);
    return connectToSsid(bestHomeSsid, bestHomePass, timeoutPerNetworkMs);
  }

  if (connectBestCustomNetwork(n, timeoutPerNetworkMs)) return true;

  // If none are seen in scan, fallback to sequential attempts.
  Serial.println("[WiFi] Known SSIDs not seen in scan. Trying configured list...");
  if (connectToSsid(WIFI_SPOT_SSID, WIFI_SPOT_PASS, timeoutPerNetworkMs)) return true;
  if (connectToSsid(WIFE_SPOT_SSID, WIFE_SPOT_PASS, timeoutPerNetworkMs)) return true;
  if (connectToSsid(WIFI_HOME_SSID, WIFI_HOME_PASS, timeoutPerNetworkMs)) return true;
  if (connectToSsid(WIFI_HOME2_SSID, WIFI_HOME2_PASS, timeoutPerNetworkMs)) return true;
  #ifdef WIFI_HOME3_SSID
  if (connectToSsid(WIFI_HOME3_SSID, WIFI_HOME3_PASS, timeoutPerNetworkMs)) return true;
  #endif
  for (int i = 0; i < MAX_CUSTOM_NETWORKS; i++) {
    if (customSsids[i].length() == 0) continue;
    if (connectToSsid(customSsids[i].c_str(), customPasses[i].c_str(), timeoutPerNetworkMs)) return true;
  }
  return false;
}

void initOta() {
  ArduinoOTA.setHostname(DEVICE_ID);
  ArduinoOTA.setPort(3232);
  ArduinoOTA.onStart([]() {
    Serial.println("[OTA] Start");
  });
  ArduinoOTA.onEnd([]() {
    Serial.println("\n[OTA] End");
  });
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    Serial.printf("[OTA] Progress: %u%%\r", (progress * 100U) / total);
  });
  ArduinoOTA.onError([](ota_error_t error) {
    Serial.printf("[OTA] Error[%u]\n", error);
  });
  ArduinoOTA.begin();
  otaReady = true;
  Serial.printf("[OTA] Ready: %s.local:%d\n", DEVICE_ID, 3232);
}

bool isCurrentHotspotConnection() {
  const String current = WiFi.SSID();
  return current == String(WIFI_SPOT_SSID) || current == String(WIFE_SPOT_SSID);
}

void loadCustomNetworks() {
  wifiPrefs.begin("wifi", true);
  for (int i = 0; i < MAX_CUSTOM_NETWORKS; i++) {
    const String ssidKey = "ssid" + String(i);
    const String passKey = "pass" + String(i);
    customSsids[i] = wifiPrefs.getString(ssidKey.c_str(), "");
    customPasses[i] = wifiPrefs.getString(passKey.c_str(), "");
  }
  wifiPrefs.end();
}

bool saveCustomNetwork(const String& ssid, const String& pass) {
  if (ssid.length() == 0) return false;
  int slot = -1;
  for (int i = 0; i < MAX_CUSTOM_NETWORKS; i++) {
    if (customSsids[i] == ssid) {
      slot = i;
      break;
    }
    if (slot < 0 && customSsids[i].length() == 0) slot = i;
  }
  if (slot < 0) slot = 0; // overwrite oldest slot when full

  customSsids[slot] = ssid;
  customPasses[slot] = pass;
  wifiPrefs.begin("wifi", false);
  const String ssidKey = "ssid" + String(slot);
  const String passKey = "pass" + String(slot);
  wifiPrefs.putString(ssidKey.c_str(), ssid);
  wifiPrefs.putString(passKey.c_str(), pass);
  wifiPrefs.end();
  return true;
}

bool startConfigPortal() {
  if (configPortalActive) {
    Serial.println("[CFG] AP portal already active; skipping re-entry.");
    return WiFi.status() == WL_CONNECTED;
  }
  configPortalActive = true;
  const String apSsid = String(DEVICE_ID) + "-Setup";
  const char* apPass = "setup1234";
  configPortalShouldExit = false;

  // Tear down active network clients before AP transition.
  mqtt.disconnect();
  client.stop();
  configServer.stop();
  WiFi.disconnect(true, true);
  delay(200);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apSsid.c_str(), apPass);
  Serial.printf("[CFG] AP mode: %s  IP=%s\n", apSsid.c_str(), WiFi.softAPIP().toString().c_str());

  if (!configRoutesInitialized) {
    configServer.on("/", HTTP_GET, []() {
      const int n = WiFi.scanNetworks(false, true);
      String options = "";
      for (int i = 0; i < n; i++) {
        const String s = WiFi.SSID(i);
        if (s.length() == 0) continue;
        options += "<option value='" + s + "'>" + s + " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
      }
      WiFi.scanDelete();
      String html =
        "<!doctype html><html><body><h2>ESP32 WiFi Setup</h2>"
        "<p>AP is active because normal WiFi failed.</p>"
        "<form method='POST' action='/save'>"
        "Select SSID:<br><select name='ssid'>" + options + "</select><br>"
        "Or type SSID:<br><input name='ssid_custom' maxlength='64'><br>"
        "Password:<br><input name='pass' type='password' maxlength='64'><br><br>"
        "<button type='submit'>Save & Connect</button>"
        "</form></body></html>";
      configServer.send(200, "text/html", html);
    });

    configServer.on("/save", HTTP_POST, []() {
      String ssid = configServer.arg("ssid_custom");
      if (ssid.length() == 0) ssid = configServer.arg("ssid");
      const String pass = configServer.arg("pass");
      if (saveCustomNetwork(ssid, pass)) {
        configServer.send(200, "text/html", "<h3>Saved. Device is reconnecting...</h3>");
        configPortalShouldExit = true;
      } else {
        configServer.send(400, "text/html", "<h3>Invalid SSID.</h3>");
      }
    });
    configRoutesInitialized = true;
  }

  configServer.stop();
  delay(20);
  configServer.begin();
  const unsigned long start = millis();
  unsigned long lastKnownScanMs = 0;
  showOledStatus("AP MODE ACTIVE", "Connect: 192.168.4.1", String("Pass: ") + apPass, apSsid);
  bool recoveredInPortal = false;
  bool tryReconnectAfterPortal = false;
  while (!configPortalShouldExit && (millis() - start < 300000UL)) {
    configServer.handleClient();
    if (millis() - lastKnownScanMs >= 10000UL) {
      lastKnownScanMs = millis();
      // Only auto-exit AP if nobody is using the setup portal.
      if (WiFi.softAPgetStationNum() == 0 && isAnyKnownNetworkVisible()) {
        Serial.println("[CFG] Known WiFi visible and no AP clients. Leaving AP to reconnect...");
        tryReconnectAfterPortal = true;
        configPortalShouldExit = true;
      }
    }
    delay(10);
    yield();
  }
  configServer.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  delay(200);
  if (tryReconnectAfterPortal) {
    recoveredInPortal = connectWifiWithPriority(WIFI_CONNECT_ATTEMPT_MS);
  }
  loadCustomNetworks();
  configPortalActive = false;
  return recoveredInPortal || (WiFi.status() == WL_CONNECTED);
}

bool isAnyKnownNetworkVisible() {
  const int n = WiFi.scanNetworks(false, true);
  const bool seenHotspot =
    getScanRssiBySsid(WIFI_SPOT_SSID, n) > -1000 || getScanRssiBySsid(WIFE_SPOT_SSID, n) > -1000;
  const bool seenHome =
    getScanRssiBySsid(WIFI_HOME_SSID, n) > -1000 ||
    getScanRssiBySsid(WIFI_HOME2_SSID, n) > -1000
    #ifdef WIFI_HOME3_SSID
    || getScanRssiBySsid(WIFI_HOME3_SSID, n) > -1000
    #endif
    ;
  bool seenCustom = false;
  for (int i = 0; i < MAX_CUSTOM_NETWORKS; i++) {
    if (customSsids[i].length() == 0) continue;
    if (getScanRssiBySsid(customSsids[i].c_str(), n) > -1000) {
      seenCustom = true;
      break;
    }
  }
  WiFi.scanDelete();
  return seenHotspot || seenHome || seenCustom;
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.printf("\n\n--- BOOTING DEVICE: %s ---\n", DEVICE_ID);
  WiFi.setSleep(false);
  loadCustomNetworks();

  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println(F("OLED Failed"));
  }
  // OLED is mounted upside down in enclosure; rotate UI 180 degrees.
  display.setRotation(2);
  display.clearDisplay();
  display.fillRect(0, 0, SCREEN_WIDTH, OLED_COLOR_SPLIT_Y, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setTextSize(1);
  display.setCursor(3, 3);
  display.print(F("CAR TRACKER"));
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, OLED_COLOR_SPLIT_Y + 2);
  display.printf("%.16s", DEVICE_ID);
  display.setCursor(0, OLED_COLOR_SPLIT_Y + 12);
  display.print(F("WiFi / GPS init..."));
  display.display();

  Serial.println("Connecting WiFi...");
  bool wifiOk = connectWifiWithPriority(WIFI_CONNECT_ATTEMPT_MS);
  if (!wifiOk) {
    Serial.println("[CFG] No usable WiFi. Starting setup AP...");
    const bool portalRecovered = startConfigPortal();
    wifiOk = portalRecovered || connectWifiWithPriority(WIFI_CONNECT_ATTEMPT_MS);
  }
  if (wifiOk) {
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
  if (WiFi.status() == WL_CONNECTED) initOta();
}

void loop() {
  if (otaReady) ArduinoOTA.handle();
  yield(); // Important for OS

  if (WiFi.status() != WL_CONNECTED) {
    if (wifiOfflineSinceMs == 0) wifiOfflineSinceMs = millis();
  } else {
    wifiOfflineSinceMs = 0;
  }

  const bool offlineTooLong =
    (wifiOfflineSinceMs != 0) && (millis() - wifiOfflineSinceMs >= WIFI_FORCE_AP_AFTER_OFFLINE_MS);

  if (offlineTooLong) {
    Serial.println("[CFG] Offline too long. Forcing setup AP mode...");
    const bool portalRecovered = startConfigPortal();
    if (portalRecovered || WiFi.status() == WL_CONNECTED) {
      failedReconnectCycles = 0;
      wifiOfflineSinceMs = 0;
    } else {
      failedReconnectCycles = WIFI_MAX_RECONNECT_CYCLES_BEFORE_AP;
      Serial.println("[CFG] AP mode ended without WiFi recovery; will keep forcing AP mode.");
    }
    lastWifiReconnectAttempt = millis();
  }

  if (WiFi.status() != WL_CONNECTED &&
      !offlineTooLong &&
      (millis() - lastWifiReconnectAttempt >= WIFI_RECONNECT_INTERVAL_MS)) {
    lastWifiReconnectAttempt = millis();
    Serial.println("[WiFi] Reconnect cycle...");
    otaReady = false;
    const bool reconnected = connectWifiWithPriority(WIFI_CONNECT_ATTEMPT_MS);
    if (!reconnected) {
      failedReconnectCycles++;
      Serial.printf("[WiFi] Reconnect failed (%d/%d)\n", failedReconnectCycles, WIFI_MAX_RECONNECT_CYCLES_BEFORE_AP);
      if (failedReconnectCycles >= WIFI_MAX_RECONNECT_CYCLES_BEFORE_AP) {
        Serial.println("[CFG] Extended offline. Starting setup AP...");
        const bool portalRecovered = startConfigPortal();
        if (portalRecovered || WiFi.status() == WL_CONNECTED) {
          failedReconnectCycles = 0;
          wifiOfflineSinceMs = 0;
        } else {
          // Keep threshold reached so we re-enter AP mode on the next cycle until recovered.
          failedReconnectCycles = WIFI_MAX_RECONNECT_CYCLES_BEFORE_AP;
          Serial.println("[CFG] AP mode ended without WiFi recovery; will re-enter AP mode.");
        }
      }
    } else {
      failedReconnectCycles = 0;
    }
  }

  if (WiFi.status() == WL_CONNECTED) {
    failedReconnectCycles = 0;
    if (millis() - lastWifiPriorityCheck >= WIFI_PRIORITY_RECHECK_MS) {
      lastWifiPriorityCheck = millis();
      // If we're on home Wi-Fi and a hotspot appears, switch immediately without reboot.
      if (!isCurrentHotspotConnection()) {
        const int n = WiFi.scanNetworks(false, true);
        const bool haveScan = n > 0;
        const int rssiSpot1 = haveScan ? getScanRssiBySsid(WIFI_SPOT_SSID, n) : -1000;
        const int rssiSpot2 = haveScan ? getScanRssiBySsid(WIFE_SPOT_SSID, n) : -1000;
        if (rssiSpot1 > -1000 || rssiSpot2 > -1000) {
          const bool useSpot1 = (rssiSpot1 >= rssiSpot2);
          const char* targetSpotSsid = useSpot1 ? WIFI_SPOT_SSID : WIFE_SPOT_SSID;
          const char* targetSpotPass = useSpot1 ? WIFI_SPOT_PASS : WIFE_SPOT_PASS;
          Serial.printf("[WiFi] Hotspot became available. Switching to %s\n", targetSpotSsid);
          otaReady = false;
          (void)connectToSsid(targetSpotSsid, targetSpotPass, WIFI_CONNECT_ATTEMPT_MS);
        }
        WiFi.scanDelete();
      }
    }
    if (!otaReady) initOta();
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

  // Periodic Telemetry (valid fix + not stale — avoids isUpdated() missing publishes on long intervals)
  if (millis() - lastCloudPublish > PUBLISH_INTERVAL) {
    if (gps.location.isValid() && gps.location.age() < MAX_FIX_AGE_MS) {
      char tsBuf[32] = {0};
      const bool haveGpsTime = gps.time.isValid() && gps.date.isValid();
      if (haveGpsTime) {
        snprintf(tsBuf, sizeof(tsBuf), "%04d-%02d-%02dT%02d:%02d:%02dZ",
                 gps.date.year(), gps.date.month(), gps.date.day(),
                 gps.time.hour(), gps.time.minute(), gps.time.second());
      }

      if (mqtt.connected()) {
        String csv = String(gps.location.lat(), 6) + "," + String(gps.location.lng(), 6) + "," + String(gps.speed.kmph()) + "," + String(gps.altitude.meters());
        carTracker.publish(csv.c_str());
        Serial.println("[AIO] Published: " + csv);
      }
      // Same GPS timestamp on successful POST keeps Supabase chronological when replaying after dead zones.
      const bool uploaded =
          pushToSupabase(gps.location.lat(), gps.location.lng(), gps.speed.kmph(), gps.altitude.meters(), gps.satellites.value(),
                         haveGpsTime ? tsBuf : nullptr);

      // Queue for /sync.csv only when we could not confirm cloud write (offline or HTTP error) — avoids duplicate rows.
      if (haveGpsTime && !uploaded) {
        File f = LittleFS.open("/history.csv", FILE_APPEND);
        if (f) {
          f.printf("%s,%.6f,%.6f,%.1f,%.1f,%d\n", tsBuf, gps.location.lat(), gps.location.lng(), gps.speed.kmph(), gps.altitude.meters(), (int)gps.satellites.value());
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
    renderDashboardOLED();
    lastDisplayUpdate = millis();
    yield();
  }
}

// Status screen: inverted title bar, fix/SV/HDOP, coords, speed, WiFi RSSI + lock
void renderDashboardOLED() {
  // Alternate views every refresh (~5s): normal telemetry, then Wi-Fi status, then back.
  showWifiInfoPanel = !showWifiInfoPanel;

  if (showWifiInfoPanel) {
    display.clearDisplay();
    const bool wifiUp = (WiFi.status() == WL_CONNECTED);
    const bool headerLit = wifiUp || (((millis() / OLED_OFFLINE_HEADER_BLINK_MS) % 2) == 0);
    if (headerLit) {
      display.fillRect(0, 0, SCREEN_WIDTH, OLED_COLOR_SPLIT_Y, SSD1306_WHITE);
    }
    display.setTextSize(1);
    display.setTextColor(headerLit ? SSD1306_BLACK : SSD1306_WHITE);
    display.setCursor(3, 3);
    display.print(F("NET STATUS"));

    display.setTextColor(SSD1306_WHITE);
    int yInfo = OLED_COLOR_SPLIT_Y + 1;
    display.setCursor(0, yInfo);
    display.print(F("STATE "));
    display.print(wifiUp ? F("ONLINE") : F("OFFLINE"));
    yInfo += 10;

    display.setCursor(0, yInfo);
    display.print(F("SSID  "));
    if (wifiUp) {
      String ssid = WiFi.SSID();
      if (ssid.length() == 0) ssid = F("(hidden)");
      const int firstLineChars = 15;
      if (ssid.length() <= firstLineChars) {
        display.print(ssid);
      } else {
        display.print(ssid.substring(0, firstLineChars));
        yInfo += 8;
        display.setCursor(0, yInfo);
        display.print(ssid.substring(firstLineChars));
      }
    } else {
      display.print(F("-"));
    }
    yInfo += 10;

    display.setCursor(0, yInfo);
    display.print(F("RSSI  "));
    if (wifiUp) display.printf("%ld dBm", WiFi.RSSI());
    else display.print(F("-"));
    yInfo += 10;

    display.setCursor(0, yInfo);
    display.print(F("IP    "));
    if (wifiUp) display.print(WiFi.localIP());
    else display.print(F("-"));

    display.display();
    return;
  }

  const uint8_t hdrH = OLED_COLOR_SPLIT_Y;
  display.clearDisplay();
  const bool wifiUp = (WiFi.status() == WL_CONNECTED);
  const bool headerLit = wifiUp || (((millis() / OLED_OFFLINE_HEADER_BLINK_MS) % 2) == 0);
  if (headerLit) {
    display.fillRect(0, 0, SCREEN_WIDTH, hdrH, SSD1306_WHITE);
  }
  display.setTextSize(1);
  display.setTextColor(headerLit ? SSD1306_BLACK : SSD1306_WHITE);
  display.setCursor(3, 3);
  display.print(F("TRACKER"));
  char idBanner[20];
  snprintf(idBanner, sizeof idBanner, "%.12s", DEVICE_ID);
  int16_t xId = (int16_t)(SCREEN_WIDTH - 3 - (int)strlen(idBanner) * 6);
  if (xId < 52) xId = 52;
  display.setCursor(xId, 3);
  display.print(idBanner);

  display.setTextColor(SSD1306_WHITE);
  // First row of body must start below yellow band to avoid clipped / speckled text
  int y = hdrH + 1;
  const bool fix = gps.location.isValid();
  const uint32_t ageMs = fix ? gps.location.age() : 0;
  const bool stale = fix && (ageMs >= MAX_FIX_AGE_MS);

  display.setCursor(0, y);
  if (!fix) {
    display.print(F("GPS  search"));
  } else if (stale) {
    display.printf("GPS  old %lus", (unsigned long)(ageMs / 1000));
  } else {
    display.printf("GPS  ok %lus", (unsigned long)(ageMs / 1000));
  }
  y += 8;

  display.setCursor(0, y);
  uint8_t sv = gps.satellites.isValid() ? (uint8_t)gps.satellites.value() : 0;
  display.printf("SV %2u", sv);
  if (gps.hdop.isValid()) {
    display.printf("  HDOP %.1f", gps.hdop.hdop());
  }
  y += 8;

  display.setCursor(0, y);
  if (fix && !stale) {
    display.printf("%.5f", gps.location.lat());
  } else {
    display.print(F("LAT  ---"));
  }
  y += 8;

  display.setCursor(0, y);
  if (fix && !stale) {
    display.printf("%.5f", gps.location.lng());
  } else {
    display.print(F("LON  ---"));
  }
  y += 8;

  const bool locked = (digitalRead(RELAY_PIN) == LOW);
  display.setCursor(0, y);
  // One line: speed + RSSI + lock (saves a row so layout fits below 16px header)
  if (fix && !stale) {
    display.printf("%3.0fk ", gps.speed.kmph());
  } else {
    display.print(F("---k "));
  }
  if (WiFi.status() == WL_CONNECTED) {
    display.printf("%+4ld ", WiFi.RSSI());
  } else {
    display.print(F(" --- "));
  }
  display.print(locked ? F("LK") : F("UL"));

  display.display();
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
  // Larger batches drain LittleFS faster after long offline periods (watchdog-safe due to yield()).
  while (f.available() && count < 18) {
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

      (void)pushToSupabase(lt.toDouble(), ln.toDouble(), sp.toDouble(), al.toDouble(), sa.toInt(), ts.c_str());
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

bool pushToSupabase(double lat, double lon, double speed, double alt, int sats, const char* timestamp) {
  if (WiFi.status() != WL_CONNECTED) return false;
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
  const bool ok = (code >= 200 && code < 300);
  if (!ok) {
    Serial.println("  -> [SUPABASE] POST failed; point remains in /history.csv or /sync.csv for later sync.");
  }
  http.end();
  yield();
  return ok;
}

void MQTT_connect() {
  if (mqtt.connected()) return;
  Serial.print("Connecting MQTT...");
  if (mqtt.connect() == 0) Serial.println("OK");
  else { Serial.println("FAIL"); mqtt.disconnect(); }
  yield();
}
