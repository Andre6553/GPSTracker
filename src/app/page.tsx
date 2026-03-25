"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { supabase } from "@/lib/supabase";
import { formatDistanceToNow, format, isWithinInterval, subMinutes } from "date-fns";
import { 
  Truck, Activity, Map as MapIcon, History, Settings, LogOut, 
  Search, Navigation, Gauge, TrendingUp, MapPin, Map as LucideMap,
  Fuel, Tag, AlertTriangle, Zap, Menu, X, Filter, Download, RotateCcw,
  Sun, Moon, Calendar, Play, Pause, SkipForward, Clock, Plus, Route,
  Lock, Unlock
} from "lucide-react";
import { useRouter } from "next/navigation";
import SpeedChart from "@/components/SpeedChart";
import mapboxgl from "mapbox-gl";

// Helper to ensure database timestamps are parsed as UTC
const ensureUTC = (dateStr: string | undefined | null) => {
  if (!dateStr) return new Date();
  const clean = (dateStr.endsWith('Z') || dateStr.includes('+')) ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  return new Date(clean);
};

import type { MapProps } from "@/components/Map";

// Dynamically import map to avoid Next.js Server-Side Rendering errors with Mapbox GL
const LiveMap = dynamic<MapProps>(() => import("@/components/Map").then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-slate-900 animate-pulse rounded-2xl flex items-center justify-center text-slate-500">
      Loading Fleet Map...
    </div>
  ),
});

interface TelemetryPoint {
  id: number;
  lat: number;
  lon: number;
  speed_kmh: number;
  altitude_m: number;
  satellites: number;
  device_id: string;
  created_at: string;
}

interface Geofence {
  id: string;
  user_id: string;
  name: string;
  lat: number;
  lon: number;
  radius_meters: number;
  created_at: string;
}

// Haversine distance in km between two GPS points
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Logic to identify GPS jitter (drift) while stationary
const isJitter = (prev: TelemetryPoint | null, curr: TelemetryPoint) => {
  if (!prev) return false;
  const distM = haversineKm(prev.lat, prev.lon, curr.lat, curr.lon) * 1000;
  // Professional-grade stationary lock: 5m or 5km/h required to move
  return distM < 5 && curr.speed_kmh < 5;
};

// Filter out stationary jitter (GPS drift when parked)
function cleanGPSPoints(points: TelemetryPoint[]): TelemetryPoint[] {
  if (points.length < 2) return points;
  const result: TelemetryPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = result[result.length - 1];
    const curr = points[i];
    if (isJitter(prev, curr)) continue;
    result.push(curr);
  }
  
  // SHORT TRIP SAFEGUARD: If we filtered out almost everything (making the line invisible)
  // but there was original data, return a subset of the raw data to ensure visibility.
  if (result.length < 3 && points.length > 5) {
    console.log("Jitter filter was too aggressive for this short trip. Using raw points.");
    return points.filter((_, i) => i % 2 === 0);
  }
  
  return result;
}

export default function Dashboard() {
  const [allData, setAllData] = useState<TelemetryPoint[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [lastHeard, setLastHeard] = useState<Record<string, string>>({}); // Decoupled heartbeat
  const [assignedDevices, setAssignedDevices] = useState<string[]>([]);
  const [deviceConfigs, setDeviceConfigs] = useState<Record<string, { speed_limit: number, fuel_rate: number, fuel_type: string }>>({});

  const [destination, setDestination] = useState("");
  const [etaInfo, setEtaInfo] = useState<{ distance: string; duration: string; arrivalTime: string; summary: string; routeLine: [number, number][] } | null>(null);
  const [isRouting, setIsRouting] = useState(false);
  const [suggestions, setSuggestions] = useState<{ place_name: string; center: [number, number] }[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedCoords, setSelectedCoords] = useState<[number, number] | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [alternativeRoutes, setAlternativeRoutes] = useState<{ 
    distance: string; duration: string; arrivalTime: string; summary: string; routeLine: [number, number][] 
  }[]>([]);
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0);

  const [isDarkMode, setIsDarkMode] = useState(true);

  // Speed Alert
  const [speedLimit, setSpeedLimit] = useState(120);
  const [speedAlerts, setSpeedAlerts] = useState<{ time: string; speed: number; lat: number; lon: number }[]>([]);
  const [speedAlertsEnabled, setSpeedAlertsEnabled] = useState(true);
  const [geofenceAlertsEnabled, setGeofenceAlertsEnabled] = useState(true);

  // Date Filter
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [selectedHistory, setSelectedHistory] = useState<TelemetryPoint[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Trip Playback
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const playbackRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fuel Estimation
  const [fuelRate, setFuelRate] = useState(12); // km/L default
  const [fuelCost, setFuelCost] = useState(22.50); // Cost per litre
  const [fuelType, setFuelType] = useState<"Petrol" | "Diesel">("Petrol");

  // Active Tab
  const [activeTab, setActiveTab] = useState<"live" | "history" | "alerts" | "devices" | "geofences">("live");

  // Geofences
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [isAddingGeofence, setIsAddingGeofence] = useState(false);
  const [newGeofencePos, setNewGeofencePos] = useState<{ lat: number, lon: number } | null>(null);
  const [geofenceName, setGeofenceName] = useState("");
  const [geofenceRadius, setGeofenceRadius] = useState(500);
  const [geofenceAlerts, setGeofenceAlerts] = useState<{ time: string; device_id: string; zone: string; type: "enter" | "exit" }[]>([]);
  const lastStatesRef = useRef<Record<string, Record<string, boolean>>>({}); // { deviceId: { geofenceId: isInside } }
  
  const [authChecked, setAuthChecked] = useState(false);
  const lastSavedSettings = useRef<any>(null);
  const [session, setSession] = useState<any>(null);
  const router = useRouter();

  // Remote Command State
  const [cmdStatus, setCmdStatus] = useState<{ msg: string; type: "success" | "error" | "loading" | null }>({ msg: "", type: null });
  const [killStep, setKillStep] = useState<"idle" | "select" | "confirm">("idle");
  const [killAction, setKillAction] = useState<"LOCK" | "UNLOCK" | null>(null);
  const [killTarget, setKillTarget] = useState<string | null>(null);
  const [killSearch, setKillSearch] = useState("");

  // Telegram Linking State
  const [telegramId, setTelegramId] = useState("");
  const [isLinkingTelegram, setIsLinkingTelegram] = useState(false);

  const sendRemoteCommand = async (command: string, targetId?: string) => {
    const target = targetId || selectedDeviceId;
    if (!target) return;

    setCmdStatus({ msg: `Sending ${command} to ${target}...`, type: "loading" });
    try {
      // Use the new COMMAND:DEVICE_ID format
      const payload = `${command}:${target}`;
      
      const res = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: payload, device_id: target }),
      });
      const data = await res.json();
      if (data.success) {
        setCmdStatus({ msg: `Success: ${command} -> ${target}`, type: "success" });
        setTimeout(() => {
          setCmdStatus({ msg: "", type: null });
          setKillStep("idle");
          setKillTarget(null);
          setKillAction(null);
          setKillSearch("");
        }, 3000);
      } else {
        setCmdStatus({ msg: data.message || "Failed to send", type: "error" });
      }
    } catch (e) {
      setCmdStatus({ msg: "Connection error", type: "error" });
    }
  };

  // Auth Guard
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session: activeSession } }: { data: { session: any } }) => {
      if (!activeSession) {
        router.push("/login");
      } else {
        setSession(activeSession);
        // Fetch user's assigned devices
        const { data: deviceRows } = await supabase
          .from("user_devices")
          .select("device_id, speed_limit, fuel_rate, fuel_type")
          .eq("user_id", activeSession.user.id);

        const myDevices = deviceRows?.map((r: any) => r.device_id) || [];
        const configs: Record<string, any> = {};
        deviceRows?.forEach((r: any) => {
          configs[r.device_id] = {
            speed_limit: r.speed_limit,
            fuel_rate: r.fuel_rate,
            fuel_type: r.fuel_type
          };
        });
        setAssignedDevices(myDevices);
        setDeviceConfigs(configs);

        // Load Global Settings
        const { data: settings } = await supabase
          .from("user_settings")
          .select("*")
          .eq("user_id", activeSession.user.id)
          .maybeSingle();

        if (settings) {
          setSpeedAlertsEnabled(settings.speed_alerts_enabled !== false);
          setGeofenceAlertsEnabled(settings.geofence_alerts_enabled !== false);
          if (settings.fuel_cost) setFuelCost(settings.fuel_cost);
          if (settings.telegram_chat_id) setTelegramId(String(settings.telegram_chat_id));
          lastSavedSettings.current = settings;
        }
        
        setAuthChecked(true);
      }
    });
  }, [router]);

  // PERSISTENCE: Save Global Settings (Fuel Cost)
  useEffect(() => {
    if (!authChecked || !session) return;

    // Only save if something actually changed from what we last loaded/saved
    if (lastSavedSettings.current &&
        fuelCost === lastSavedSettings.current.fuel_cost &&
        telegramId === (lastSavedSettings.current.telegram_chat_id || "") &&
        speedAlertsEnabled === (lastSavedSettings.current.speed_alerts_enabled !== false) &&
        geofenceAlertsEnabled === (lastSavedSettings.current.geofence_alerts_enabled !== false)) {
      return;
    }

    const timer = setTimeout(async () => {
      const { data, error } = await supabase
        .from("user_settings")
        .upsert({ 
          user_id: session.user.id, 
          fuel_cost: fuelCost,
          telegram_chat_id: telegramId,
          speed_alerts_enabled: speedAlertsEnabled,
          geofence_alerts_enabled: geofenceAlertsEnabled
        }, { onConflict: 'user_id' })
        .select()
        .single();
      
      if (!error && data) {
        lastSavedSettings.current = data;
      } else if (error) {
        console.error("Settings save error:", error);
      }
    }, 2000); // 2s debounce

    return () => clearTimeout(timer);
  }, [fuelCost, telegramId, speedAlertsEnabled, geofenceAlertsEnabled, session, authChecked]);

  // PERSISTENCE: Save Device Configs (Speed, Fuel Rate)
  useEffect(() => {
    if (!selectedDeviceId || !authChecked || !session) return;
    
    // Only save if the values are different from what we last loaded/saved for THIS device
    const lastConfig = deviceConfigs[selectedDeviceId];
    if (lastConfig && 
        speedLimit === lastConfig.speed_limit && 
        fuelRate === lastConfig.fuel_rate && 
        fuelType === lastConfig.fuel_type) {
      return; 
    }

    const timer = setTimeout(async () => {
      await supabase
        .from("user_devices")
        .update({ 
          speed_limit: speedLimit, 
          fuel_rate: fuelRate, 
          fuel_type: fuelType 
        })
        .match({ user_id: session.user.id, device_id: selectedDeviceId });
        
      // Update local cache so we don't re-trigger unless it changes again
      setDeviceConfigs(prev => ({
        ...prev,
        [selectedDeviceId]: { 
          speed_limit: speedLimit, 
          fuel_rate: fuelRate, 
          fuel_type: fuelType 
        }
      }));
    }, 1500);

    return () => clearTimeout(timer);
  }, [speedLimit, fuelRate, fuelType, selectedDeviceId, session, authChecked, deviceConfigs]);

  // Sync Device Config to local state when selecting a car
  useEffect(() => {
    if (!selectedDeviceId || !deviceConfigs[selectedDeviceId]) return;
    const config = deviceConfigs[selectedDeviceId];
    setSpeedLimit(config.speed_limit || 120);
    setFuelRate(config.fuel_rate || 12);
    setFuelType(config.fuel_type === "Diesel" ? "Diesel" : "Petrol");
  }, [selectedDeviceId, deviceConfigs]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  // Initialize Data & Realtime Subscription
  useEffect(() => {
    if (!authChecked || assignedDevices.length === 0) return;
    
    async function loadLatestPositions() {
      const { data } = await supabase
        .from("telemetry")
        .select("*")
        .in("device_id", assignedDevices)
        .order("created_at", { ascending: false });

      if (data && data.length > 0) {
        const latestMap: Record<string, TelemetryPoint> = {};
        data.forEach((p: any) => {
          if (!latestMap[p.device_id]) latestMap[p.device_id] = p;
        });
        const latestList = Object.values(latestMap);
        setAllData(latestList);
        
        setLastHeard(prev => {
          const newMap = { ...prev };
          latestList.forEach(p => { newMap[p.device_id] = p.created_at; });
          return newMap;
        });

        if (!selectedDeviceId && latestList.length > 0) {
          setSelectedDeviceId(latestList[0].device_id);
        }
      }
    }
    
    loadLatestPositions();

    const channel = supabase.channel("live-telemetry")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "telemetry" }, (payload: { new: TelemetryPoint }) => {
        const newData = payload.new;
        if (assignedDevices.includes(newData.device_id)) {
          setLastHeard(prev => ({ ...prev, [newData.device_id]: newData.created_at }));
          setAllData(prev => {
            const currentForDevice = prev.find(p => p.device_id === newData.device_id);
            if (isJitter(currentForDevice || null, newData)) return prev;
            const others = prev.filter(p => p.device_id !== newData.device_id);
            return [newData, ...others];
          });
          
          // Do not merge live points into a date-filtered history view (would skew trail / order)
          if (newData.device_id === selectedDeviceId && !startDate && !endDate) {
            setSelectedHistory(prev => {
              const last = prev[prev.length - 1];
              // 1. Skip if it's stationary jitter
              if (isJitter(last || null, newData)) return prev;
              
              // 2. Prevent exact duplicate timestamps (avoiding database double-inserts)
              if (prev.some(p => p.created_at === newData.created_at)) return prev;

              // 3. Add and Sort chronologically (ensures smooth path even if sync arrives out of order)
              const combined = [...prev, newData].sort((a, b) => 
                new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
              );
              
              return combined.slice(-25000);
            });
          }
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [authChecked, assignedDevices, selectedDeviceId, startDate, endDate]);

  // Lazy-load history for selected device (paginate: PostgREST often caps ~1000 rows per request)
  useEffect(() => {
    if (!selectedDeviceId) return;
    let cancelled = false;

    async function fetchDeviceHistory() {
      setIsLoadingHistory(true);
      const pageSize = 1000;
      const maxRows = 50000;
      // Live tab: default trail window = today (midnight → midnight).
      // History tab: user-specified date range (or blank = "recent", if they leave it blank).
      const todayYmd = format(new Date(), "yyyy-MM-dd");
      const effectiveStartDate = activeTab === "live" && !startDate && !endDate ? todayYmd : startDate;
      const effectiveEndDate = activeTab === "live" && !startDate && !endDate ? todayYmd : endDate;
      const hasRange = !!(effectiveStartDate || effectiveEndDate);
      const all: TelemetryPoint[] = [];

      for (let offset = 0; offset < maxRows; offset += pageSize) {
        if (cancelled) return;

        let q = supabase
          .from("telemetry")
          .select("*")
          .eq("device_id", selectedDeviceId)
          .order("created_at", { ascending: hasRange })
          .range(offset, offset + pageSize - 1);

        if (effectiveStartDate) q = q.gte("created_at", `${effectiveStartDate}T00:00:00+02:00`);
        if (effectiveEndDate) q = q.lte("created_at", `${effectiveEndDate}T23:59:59+02:00`);

        const { data, error } = await q;
        if (error) {
          console.error("fetchDeviceHistory:", error);
          if (!cancelled) {
            setSelectedHistory([]);
            setIsLoadingHistory(false);
          }
          return;
        }
        if (!data?.length) break;
        all.push(...(data as TelemetryPoint[]));
        if (data.length < pageSize) break;
      }

      if (cancelled) return;

      if (!all.length) {
        setSelectedHistory([]);
        setIsLoadingHistory(false);
        return;
      }

      const sorted = all
        .slice()
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      console.log(
        `FETCHED HISTORY: ${sorted.length} records for ${selectedDeviceId} (${
          hasRange ? `${effectiveStartDate || "…"} → ${effectiveEndDate || "…"}${activeTab === "live" && !startDate && !endDate ? " (live: today)" : ""}` : "recent"
        })`
      );
      setSelectedHistory(sorted);
      setIsLoadingHistory(false);
    }

    fetchDeviceHistory();
    return () => {
      cancelled = true;
    };
  }, [selectedDeviceId, startDate, endDate, activeTab]);

  // Load Geofences
  useEffect(() => {
    if (!authChecked || !session) return;
    async function loadGeofences() {
      const { data, error } = await supabase.from("geofences").select("*").eq("user_id", session.user.id);
      if (error) {
        console.error("Error loading geofences:", error);
      } else if (data) {
        setGeofences(data as Geofence[]);
      }
    }
    loadGeofences();
  }, [authChecked, session]);

  const handleSaveGeofence = async () => {
    if (!newGeofencePos || !geofenceName || !session) return;
    const { data, error } = await supabase.from("geofences").insert({
      user_id: session.user.id,
      name: geofenceName,
      lat: newGeofencePos.lat,
      lon: newGeofencePos.lon,
      radius_meters: geofenceRadius
    }).select();

    if (error) {
      console.error("Error saving geofence:", error);
      alert(`Failed to save zone: ${error.message}`);
    } else if (data) {
      setGeofences(prev => [...prev, data[0] as Geofence]);
      setIsAddingGeofence(false);
      setNewGeofencePos(null);
      setGeofenceName("");
    }
  };

  const handleDeleteGeofence = async (id: string) => {
    const { error } = await supabase.from("geofences").delete().eq("id", id);
    if (!error) setGeofences(prev => prev.filter(g => g.id !== id));
  };

  const handleClearHistory = async () => {
    if (!selectedDeviceId) return;
    if (!confirm(`Are you sure you want to PERMANENTLY delete all history for ${selectedDeviceId}?`)) return;
    const { error } = await supabase.from("telemetry").delete().eq("device_id", selectedDeviceId);
    if (!error) {
      setSelectedHistory([]);
      // We do NOT filter out selectedDeviceId from allData anymore.
      // This keeps the car's marker on the map at its LAST KNOWN position
      // until the next real-time update arrives from the device.
      alert(`Cloud history for ${selectedDeviceId} purged. Current marker preserved.`);
    }
  };

  const currentPnt = selectedHistory.length > 0 ? selectedHistory[selectedHistory.length - 1] : null;

  // Update ETA and Route when destination or selected car changes
  useEffect(() => {
    if (!selectedCoords || !currentPnt) {
      setAlternativeRoutes([]);
      setEtaInfo(null);
      return;
    }

    async function getRoute() {
      if (!selectedCoords || !currentPnt) return;
      setIsRouting(true);
      try {
        const query = await fetch(
          `https://api.mapbox.com/directions/v5/mapbox/driving/${currentPnt.lon},${currentPnt.lat};${selectedCoords[0]},${selectedCoords[1]}?alternatives=true&geometries=geojson&access_token=${mapboxgl.accessToken}`
        );
        const json = await query.json();
        if (json.routes && json.routes.length > 0) {
          // Calculate a scaling factor: base 120km/h / user's speedLimit
          // e.g. if limit is 150, factor is 0.8 (20% faster)
          const speedFactor = 120 / (speedLimit || 120);
          
          const routes = json.routes.map((r: any) => {
            const adjustedSec = r.duration * speedFactor;
            return {
              distance: (r.distance / 1000).toFixed(1) + " km",
              duration: adjustedSec > 3600 
                ? `${Math.floor(adjustedSec / 3600)}h ${Math.round((adjustedSec % 3600) / 60)}m` 
                : `${Math.round(adjustedSec / 60)} min`,
              arrivalTime: format(new Date(Date.now() + adjustedSec * 1000), "HH:mm"),
              summary: r.summary || "Route",
              routeLine: r.geometry.coordinates.map((c: any) => [c[1], c[0]]) as [number, number][],
            };
          });
          setAlternativeRoutes(routes);
          setEtaInfo(routes[selectedRouteIndex] || routes[0]);
        }
      } catch (e) {
        console.error("Route error:", e);
      } finally {
        setIsRouting(false);
      }
    }
    getRoute();
  }, [selectedCoords, currentPnt, selectedRouteIndex]);

  const activeDevices = assignedDevices;
  const fleetLatest = allData;

  // Stats Calculations
  const totalDistanceKm = useMemo(() => {
    let dist = 0;
    for (let i = 1; i < selectedHistory.length; i++) {
      const segDist = haversineKm(selectedHistory[i-1].lat, selectedHistory[i-1].lon, selectedHistory[i].lat, selectedHistory[i].lon);
      if (segDist < 2) dist += segDist;
    }
    return dist;
  }, [selectedHistory]);

  const avgSpeedVal = selectedHistory.length > 0
    ? selectedHistory.reduce((sum, pt) => sum + pt.speed_kmh, 0) / selectedHistory.length
    : 0;

  const stopStats = useMemo(() => {
    let count = 0;
    let totalSeconds = 0;
    let longestSec = 0;
    for (let i = 0; i < selectedHistory.length - 1; i++) {
      const start = ensureUTC(selectedHistory[i].created_at);
      const end = ensureUTC(selectedHistory[i+1].created_at);
      const diffSec = (end.getTime() - start.getTime()) / 1000;
      
      // A "stop" is defined as a gap > 120s where the vehicle is stationary (< 5km/h)
      // We cap diffSec at 1 hour (3600s) to avoid counting long power-off durations as "idling"
      if (diffSec > 120 && selectedHistory[i].speed_kmh < 5) {
        count++;
        const validGap = Math.min(diffSec, 3600); 
        totalSeconds += validGap;
        if (validGap > longestSec) longestSec = validGap;
      }
    }
    const formatTime = (sec: number) => {
      if (sec <= 0) return "0s";
      if (sec < 60) return `${Math.round(sec)}s`;
      if (sec < 3600) return `${Math.floor(sec/60)}m ${Math.round(sec%60)}s`;
      return `${Math.floor(sec/3600)}h ${Math.floor((sec%3600)/60)}m`;
    };
    return { count, totalTime: formatTime(totalSeconds), longest: formatTime(longestSec) };
  }, [selectedHistory]);

  const estimatedFuel = fuelRate > 0 ? totalDistanceKm / fuelRate : 0;
  const estimatedCost = estimatedFuel * fuelCost;

  // TODAY'S LIVE STATS (from selectedHistory filtered for current day)
  const todayStats = useMemo(() => {
    if (!selectedDeviceId || selectedHistory.length === 0) return null;
    
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const todayPnts = selectedHistory.filter(p => p.created_at.startsWith(todayStr));
    
    if (todayPnts.length === 0) return null;

    let dist = 0;
    let maxSpd = 0;
    let sumSpd = 0;
    let movingSec = 0;
    let stoppedSec = 0;

    for (let i = 0; i < todayPnts.length; i++) {
      const p = todayPnts[i];
      if (p.speed_kmh > maxSpd) maxSpd = p.speed_kmh;
      sumSpd += p.speed_kmh;

      if (i > 0) {
        const prev = todayPnts[i-1];
        const segDist = haversineKm(prev.lat, prev.lon, p.lat, p.lon);
        if (segDist < 2) dist += segDist;

        const start = ensureUTC(prev.created_at);
        const end = ensureUTC(p.created_at);
        const diff = (end.getTime() - start.getTime()) / 1000;
        const validGap = Math.min(diff, 3600);

        if (p.speed_kmh > 5) movingSec += validGap;
        else stoppedSec += validGap;
      }
    }

    const formatTime = (sec: number) => {
      if (sec <= 0) return "0s";
      if (sec < 60) return `${Math.round(sec)}s`;
      if (sec < 3600) return `${Math.floor(sec/60)}m ${Math.round(sec%60)}s`;
      return `${Math.floor(sec/3600)}h ${Math.floor((sec%3600)/60)}m`;
    };

    return {
      distance: dist,
      maxSpeed: maxSpd,
      avgSpeed: sumSpd / todayPnts.length,
      movingTime: formatTime(movingSec),
      stoppedTime: formatTime(stoppedSec),
      totalTime: formatTime(movingSec + stoppedSec)
    };
  }, [selectedHistory, selectedDeviceId]);

  const isOverSpeed = currentPnt ? currentPnt.speed_kmh > speedLimit : false;

  // CSV Export
  const exportCSV = () => {
    if (selectedHistory.length === 0) return;
    const header = "timestamp,device_id,lat,lon,speed_kmh,altitude_m,satellites\n";
    const rows = selectedHistory.map(p => `${p.created_at},${p.device_id},${p.lat},${p.lon},${p.speed_kmh},${p.altitude_m},${p.satellites}`).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `${selectedDeviceId}_fleet_history.csv`);
    document.body.appendChild(link);
    link.click();
    setTimeout(() => { document.body.removeChild(link); URL.revokeObjectURL(url); }, 200);
  };

  // Device Management
  const [newDeviceCode, setNewDeviceCode] = useState("");
  const [deviceStatusMsg, setDeviceStatusMsg] = useState("");
  const handleAddDevice = async () => {
    if (!newDeviceCode.trim()) return;
    const { error } = await supabase.from("user_devices").insert({ user_id: session?.user?.id, device_id: newDeviceCode.trim() });
    if (!error) {
      setAssignedDevices(prev => [...prev, newDeviceCode.trim()]);
      setNewDeviceCode("");
      setDeviceStatusMsg("Device linked successfully!");
    }
  };
  const handleRemoveDevice = async (id: string) => {
    if (!confirm(`Unlink ${id}?`)) return;
    await supabase.from("user_devices").delete().eq("user_id", session?.user?.id).eq("device_id", id);
    setAssignedDevices(prev => prev.filter(d => d !== id));
  };

  const handleLinkTelegram = async () => {
    if (!session) return;
    setIsLinkingTelegram(true);
    const { error } = await supabase
      .from("user_settings")
      .upsert({ 
        user_id: session.user.id, 
        telegram_chat_id: telegramId.trim(),
        speed_alerts_enabled: speedAlertsEnabled, // Preserve other settings
        geofence_alerts_enabled: geofenceAlertsEnabled
      }, { onConflict: 'user_id' });
    
    if (!error) {
      alert("Telegram Link Updated!");
    } else {
      alert("Error linking Telegram: " + error.message);
    }
    setIsLinkingTelegram(false);
  };

  // Playback
  useEffect(() => {
    if (isPlaying && selectedHistory.length > 0) {
      playbackRef.current = setInterval(() => {
        setPlaybackIndex(prev => (prev < selectedHistory.length - 1 ? prev + 1 : (setIsPlaying(false), prev)));
      }, 800 / playbackSpeed);
    }
    return () => { if (playbackRef.current) clearInterval(playbackRef.current); };
  }, [isPlaying, playbackSpeed, selectedHistory.length]);
  const playbackPoint = isPlaying || playbackIndex > 0 ? selectedHistory[playbackIndex] : null;

  if (!authChecked) {
    return <main className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-500 animate-pulse">Checking authentication...</main>;
  }

  return (
    <main className="flex h-[100dvh] w-full bg-slate-950 text-slate-200 overflow-hidden">
      
      {/* Sidebar Dashboard */}
      <div className={`fixed inset-y-0 left-0 z-50 w-80 bg-slate-900 border-r border-slate-800 transition-transform lg:relative lg:translate-x-0 lg:flex lg:w-1/3 lg:min-w-[340px] lg:max-w-[420px] ${isSidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex flex-col h-full w-full p-5 gap-4 overflow-y-auto">
          
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Navigation className="text-blue-500 w-7 h-7" />
              <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">Fleet Tracker</h1>
            </div>
            <div className="flex gap-1.5">
              <button onClick={() => setIsDarkMode(!isDarkMode)} className="p-2 rounded-full bg-slate-800 text-slate-400 hover:text-blue-400"><Sun className="w-4 h-4" /></button>
              <button onClick={exportCSV} className="p-2 rounded-full bg-slate-800 text-slate-400 hover:text-emerald-400"><Download className="w-4 h-4" /></button>
              <button onClick={handleSignOut} className="p-2 rounded-full bg-slate-800 text-slate-400 hover:text-red-400"><LogOut className="w-4 h-4" /></button>
            </div>
          </div>

          {/* DYNAMIC KILL SWITCH */}
          <div className="bg-red-950/20 border-2 border-red-600/50 p-4 rounded-2xl flex flex-col gap-3 animate-in fade-in zoom-in duration-500">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-black text-red-400 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-red-500 animate-pulse" /> 
                DRIVE-TRAIN CONTROL
              </h2>
              {killStep !== "idle" && (
                <button onClick={() => setKillStep("idle")} className="text-[10px] text-red-500 hover:text-white font-bold uppercase">Cancel</button>
              )}
            </div>
            
            {killStep === "idle" && (
              <div className="grid grid-cols-2 gap-3">
                <button 
                  onClick={() => { setKillAction("LOCK"); setKillStep("select"); }}
                  className="group relative flex flex-col items-center justify-center gap-2 py-5 rounded-xl bg-red-600 hover:bg-red-500 text-white transition-all shadow-lg shadow-red-900/40 active:scale-95 border-b-4 border-red-800"
                >
                  <Lock className="w-5 h-5 text-white" />
                  <span className="text-[10px] font-black uppercase">Emergency Kill</span>
                </button>
                <button 
                  onClick={() => { setKillAction("UNLOCK"); setKillStep("select"); }}
                  className="group relative flex flex-col items-center justify-center gap-2 py-5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition-all border border-slate-700 active:scale-95"
                >
                  <Unlock className="w-5 h-5 text-emerald-400" />
                  <span className="text-[10px] font-black uppercase">Restore</span>
                </button>
              </div>
            )}

            {killStep === "select" && (
              <div className="flex flex-col gap-3 animate-in fade-in duration-300">
                <p className="text-[10px] text-slate-500 font-bold uppercase text-center tracking-widest">Select Target Vehicle</p>
                <select 
                  className="w-full bg-slate-900 border border-red-900/30 rounded-xl px-4 py-3 text-xs text-white focus:border-red-500 outline-none appearance-none cursor-pointer"
                  value={killTarget || ""}
                  onChange={(e) => {
                    if (e.target.value) {
                      setKillTarget(e.target.value);
                      setKillStep("confirm");
                    }
                  }}
                >
                  <option value="" disabled className="bg-slate-950">--- Choose vehicle ---</option>
                  {assignedDevices.map(id => (
                    <option key={id} value={id} className="bg-slate-950">{id}</option>
                  ))}
                </select>
                <div className="text-[9px] text-slate-600 text-center italic">
                  Select a vehicle above to proceed to confirmation.
                </div>
              </div>
            )}

            {killStep === "confirm" && killAction && killTarget && (
              <div className="flex flex-col gap-3 animate-in zoom-in duration-200 text-center py-2">
                <p className="text-xs font-bold text-white">
                  Confirm <span className={killAction === 'LOCK' ? 'text-red-500' : 'text-emerald-400'}>{killAction === 'LOCK' ? 'KILL' : 'RESTORE'}</span> on <b>{killTarget}</b>?
                </p>
                <div className="flex gap-2">
                  <button 
                    onClick={() => sendRemoteCommand(killAction, killTarget)}
                    disabled={cmdStatus.type === "loading"}
                    className="flex-1 py-3 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-black shadow-lg shadow-red-900/40 transition-all active:scale-95 border-b-4 border-red-800 disabled:opacity-50"
                  >
                    {cmdStatus.type === "loading" ? "SENDING..." : "YES, PROCEED"}
                  </button>
                  <button 
                    onClick={() => setKillStep("idle")}
                    className="px-4 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 text-xs font-bold border border-slate-700"
                  >
                    NO
                  </button>
                </div>
              </div>
            )}

            {cmdStatus.msg && (
              <div className={`p-2 rounded-lg text-[10px] font-bold flex items-center justify-center gap-2 border ${cmdStatus.type === "success" ? "bg-emerald-950/40 text-emerald-400 border-emerald-800" : cmdStatus.type === "error" ? "bg-red-900/40 text-red-200 border-red-800" : "bg-blue-950/40 text-blue-400 border-blue-800"}`}>
                {cmdStatus.type === "loading" && <Activity className="w-3 h-3 animate-spin" />}
                {cmdStatus.msg}
              </div>
            )}
          </div>

          {/* Vehicle Selector */}
          <div>
            <h2 className="text-[11px] font-semibold text-slate-500 uppercase flex items-center gap-2 mb-2"><Truck className="w-3.5 h-3.5" /> Fleet ({activeDevices.length})</h2>
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
              {activeDevices.map(id => (
                <button key={id} onClick={() => { setSelectedDeviceId(id); setPlaybackIndex(0); setIsPlaying(false); }} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${selectedDeviceId === id ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400'}`}>
                  {id}
                </button>
              ))}
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 bg-slate-800/60 p-1 rounded-lg">
            {[{ key: "live", label: "Live", icon: <Zap className="w-3.5 h-3.5" /> }, { key: "history", label: "History", icon: <Calendar className="w-3.5 h-3.5" /> }, { key: "geofences", label: "Zones", icon: <MapPin className="w-3.5 h-3.5" /> }, { key: "alerts", label: "Alerts", icon: <AlertTriangle className="w-3.5 h-3.5" /> }, { key: "devices", label: "Devices", icon: <Settings className="w-3.5 h-3.5" /> }].map(tab => (
              <button key={tab.key} onClick={() => setActiveTab(tab.key as any)} className={`flex-1 py-1.5 text-xs font-semibold rounded-md flex items-center justify-center gap-1.5 transition ${activeTab === tab.key ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                {tab.icon} <span>{tab.label}</span>
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div className="flex-1 flex flex-col gap-4 overflow-y-auto no-scrollbar">
            
            {/* LIVE TAB */}
            {activeTab === "live" && selectedDeviceId && (
              <div className="flex flex-col gap-4 animate-in fade-in duration-300">
                <div className={`p-4 rounded-xl border flex flex-col items-center justify-center ${isOverSpeed ? 'bg-red-900/40 border-red-500 animate-pulse' : 'bg-slate-800 border-slate-700'}`}>
                  <Gauge className="w-5 h-5 text-slate-400 mb-1" />
                  <span className="text-4xl font-black text-white">{currentPnt?.speed_kmh?.toFixed(0) || "0"}<span className="text-sm font-normal text-slate-400 ml-1">km/h</span></span>
                  <span className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mt-1">Live Speed</span>
                </div>


                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700">
                    <span className="text-[9px] text-slate-500 uppercase font-bold block mb-1">Status</span>
                    <div className="flex items-center gap-2">
                       <div className={`w-2 h-2 rounded-full ${lastHeard[selectedDeviceId] && (new Date().getTime() - ensureUTC(lastHeard[selectedDeviceId]).getTime() < 120000) ? "bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-slate-600"}`} />
                       <span className="text-xs font-bold">{lastHeard[selectedDeviceId] && (new Date().getTime() - ensureUTC(lastHeard[selectedDeviceId]).getTime() < 120000) ? "ONLINE" : "OFFLINE"}</span>
                    </div>
                    {lastHeard[selectedDeviceId] && (
                      <span className="text-[9px] text-slate-500 mt-1 block italic">
                        Seen: {formatDistanceToNow(ensureUTC(lastHeard[selectedDeviceId]), { addSuffix: true })}
                      </span>
                    )}
                  </div>
                  <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700">
                    <span className="text-[9px] text-slate-500 uppercase font-bold block mb-1">Signal</span>
                    <span className="text-xs font-bold">{currentPnt?.satellites || 0} Sats</span>
                  </div>
                </div>

                {/* Today's Summary Section */}
                {todayStats && (
                  <div className="bg-blue-600/5 border border-blue-500/20 p-4 rounded-2xl flex flex-col gap-4 animate-in slide-in-from-bottom-2 duration-500">
                    <div className="flex items-center justify-between border-b border-blue-500/20 pb-2">
                       <h3 className="text-[10px] font-black text-blue-400 uppercase tracking-widest flex items-center gap-2">
                         <TrendingUp className="w-3.5 h-3.5" /> Today's Summary
                       </h3>
                       <span className="text-[9px] text-slate-500 font-bold">{new Date().toLocaleDateString()}</span>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 uppercase font-bold">Trip Distance</span>
                        <span className="text-lg font-black text-white">{todayStats.distance.toFixed(1)} <span className="text-[10px] font-normal text-slate-500">km</span></span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 uppercase font-bold text-red-400">Max Speed</span>
                        <span className="text-lg font-black text-white">{todayStats.maxSpeed.toFixed(0)} <span className="text-[10px] font-normal text-slate-500">km/h</span></span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 uppercase font-bold">Avg Speed</span>
                        <span className="text-lg font-black text-white">{todayStats.avgSpeed.toFixed(0)} <span className="text-[10px] font-normal text-slate-500">km/h</span></span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 uppercase font-bold">Moving Time</span>
                        <span className="text-lg font-black text-white">{todayStats.movingTime}</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 uppercase font-bold text-blue-400">Idle Today</span>
                        <span className="text-lg font-black text-white">{todayStats.stoppedTime}</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 uppercase font-bold">Total Time</span>
                        <span className="text-lg font-black text-white">{todayStats.totalTime}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* ACTIVE ROUTE / TRIP INFO */}
                {alternativeRoutes.length > 0 && etaInfo && (
                  <div className="bg-emerald-600/5 border border-emerald-500/20 p-4 rounded-2xl flex flex-col gap-4 animate-in slide-in-from-bottom-2 duration-500">
                    <div className="flex items-center justify-between border-b border-emerald-500/20 pb-2">
                       <h3 className="text-[10px] font-black text-emerald-400 uppercase tracking-widest flex items-center gap-2">
                         <Route className="w-3.5 h-3.5" /> Active Route
                       </h3>
                       <button onClick={() => { setSelectedCoords(null); setDestination(""); setAlternativeRoutes([]); setEtaInfo(null); }} className="text-[10px] text-emerald-500 hover:text-white font-bold uppercase transition-colors">Clear</button>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 uppercase font-bold">Trip Distance</span>
                        <span className="text-lg font-black text-white">{etaInfo.distance}</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 uppercase font-bold text-emerald-400">ETA / Arrival</span>
                        <span className="text-lg font-black text-white">{etaInfo.arrivalTime}</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 uppercase font-bold">Travel Time</span>
                        <span className="text-lg font-black text-white">{etaInfo.duration}</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 uppercase font-bold text-amber-500">Fuel Estimate</span>
                        <span className="text-lg font-black text-white">R {(parseFloat(etaInfo.distance) / fuelRate * fuelCost).toFixed(2)}</span>
                      </div>
                    </div>

                    {alternativeRoutes.length > 1 && (
                      <div className="pt-2">
                        <p className="text-[9px] text-slate-500 uppercase font-bold mb-2">Alternative Paths</p>
                        <div className="flex flex-col gap-1.5">
                          {alternativeRoutes.map((r, i) => (
                            <button
                              key={i}
                              onClick={() => setSelectedRouteIndex(i)}
                              className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all border ${selectedRouteIndex === i ? 'bg-emerald-600/20 border-emerald-500 text-emerald-400' : 'bg-slate-800/40 border-slate-700/50 text-slate-500 hover:border-slate-600'}`}
                            >
                              <div className="flex justify-between items-center font-bold">
                                <span>Option {i + 1}: {r.summary}</span>
                                <span className="text-emerald-400">{r.distance}</span>
                              </div>
                              <div className="text-[9px] text-slate-500 mt-0.5 font-medium uppercase tracking-tighter">Approx. {r.duration} travel time</div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* TRIP PARAMETERS (Speed Limit, Fuel) moved here for visibility */}
                <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700 mt-2">
                  <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-3">
                    <Settings className="w-3.5 h-3.5 text-blue-400" /> TRIP DEFAULTS
                  </h2>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1.5">
                      <span className="text-[9px] text-slate-500 uppercase font-bold">Max Speed</span>
                      <div className="flex items-center bg-slate-900 border border-slate-700 rounded-lg px-2 py-1">
                        <input type="number" value={speedLimit} onChange={e => setSpeedLimit(Number(e.target.value))} className="w-full bg-transparent text-xs text-white focus:outline-none" />
                        <span className="text-[10px] text-slate-500 ml-1">km/h</span>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <span className="text-[9px] text-slate-500 uppercase font-bold">Fuel Cost</span>
                      <div className="flex items-center bg-slate-900 border border-slate-700 rounded-lg px-2 py-1">
                        <span className="text-[10px] text-slate-500 mr-1">R</span>
                        <input type="number" value={fuelCost} onChange={e => setFuelCost(Number(e.target.value))} className="w-full bg-transparent text-xs text-white focus:outline-none" />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5 col-span-2">
                      <span className="text-[9px] text-slate-500 uppercase font-bold">Consumption (km/L)</span>
                      <input type="number" value={fuelRate} onChange={e => setFuelRate(Number(e.target.value))} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white" />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* HISTORY TAB */}
            {activeTab === "history" && selectedDeviceId && (
              <div className="flex flex-col gap-4 animate-in fade-in duration-300">
                <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700">
                  <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-3">
                    <Filter className="w-3.5 h-3.5 text-blue-400" /> Date Range
                  </h2>
                  <div className="flex flex-col gap-2">
                    <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white" />
                    <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white" />
                    <button
                      type="button"
                      onClick={() => {
                        const d = format(new Date(), "yyyy-MM-dd");
                        setStartDate(d);
                        setEndDate(d);
                      }}
                      className="mt-1 w-full flex items-center justify-center gap-1.5 rounded-lg border border-blue-600/50 bg-blue-600/20 px-2 py-2 text-[11px] font-semibold text-blue-300 hover:bg-blue-600/30 transition-colors"
                    >
                      <Calendar className="w-3.5 h-3.5" />
                      Today (full day)
                    </button>
                    <p className="text-[10px] text-slate-500 leading-snug">
                      Uses your PC&apos;s date for start and end, loads all points for that day in batches (map zooms to full trail).
                    </p>
                    {isLoadingHistory ? (
                      <p className="text-[10px] text-amber-400/90">Loading history…</p>
                    ) : selectedHistory.length > 0 ? (
                      <p className="text-[10px] text-slate-400">
                        <span className="text-emerald-400 font-semibold">{selectedHistory.length.toLocaleString()}</span> GPS points
                        {selectedHistory.length >= 2 && (
                          <>
                            {" "}
                            · {format(ensureUTC(selectedHistory[0].created_at), "HH:mm")} →{" "}
                            {format(
                              ensureUTC(selectedHistory[selectedHistory.length - 1].created_at),
                              "HH:mm"
                            )}{" "}
                            (local display)
                          </>
                        )}
                      </p>
                    ) : startDate || endDate ? (
                      <p className="text-[10px] text-slate-500">No points in this range for this device.</p>
                    ) : null}
                  </div>
                </div>

                {/* Historical Stats / Trip Analytics */}
                <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700">
                  <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-4">
                    <TrendingUp className="w-3.5 h-3.5 text-emerald-400" /> Trip Analytics
                  </h2>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <span className="text-[9px] text-slate-500 uppercase font-bold block">Distance</span>
                      <span className="text-lg font-black text-white">{totalDistanceKm.toFixed(1)} <span className="text-[10px] font-normal text-slate-500">km</span></span>
                    </div>
                    <div>
                      <span className="text-[9px] text-slate-500 uppercase font-bold block">Avg Speed</span>
                      <span className="text-lg font-black text-white">{avgSpeedVal.toFixed(0)} <span className="text-[10px] font-normal text-slate-500">km/h</span></span>
                    </div>
                    <div>
                      <span className="text-[9px] text-slate-500 uppercase font-bold block">Stops</span>
                      <span className="text-lg font-black text-white">{stopStats.count} <span className="text-[10px] font-normal text-slate-500">events</span></span>
                    </div>
                    <div>
                      <span className="text-[9px] text-slate-500 uppercase font-bold block">Idle Time</span>
                      <span className="text-lg font-black text-white">{stopStats.totalTime}</span>
                    </div>
                  </div>
                  <div className="mt-4 pt-4 border-t border-slate-700/50">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[10px] text-slate-400 uppercase font-bold flex items-center gap-1"><Fuel className="w-3 h-3" /> Est. Consumption</span>
                      <span className="text-xs font-bold text-emerald-400">R {estimatedCost.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-[10px] text-slate-500">
                      <span>{estimatedFuel.toFixed(1)} Litres {fuelType}</span>
                      <span>@{fuelCost}/L</span>
                    </div>
                  </div>
                </div>

                {/* Danger Zone */}
                <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50 flex flex-col gap-2">
                  <button 
                    onClick={() => {
                      if(confirm("This will ask the ESP32 to upload all coordinates stored in its internal memory. Continue?")) {
                        sendRemoteCommand("SYNC");
                      }
                    }}
                    className="w-full bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 border border-blue-500/50 py-2.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-2"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> Sync Device Memory
                  </button>
                  <button 
                    onClick={handleClearHistory} 
                    className="w-full bg-red-900/40 hover:bg-red-900/60 text-red-200 border border-red-800 py-2.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-2"
                  >
                    <X className="w-3.5 h-3.5" /> Clear Cloud History
                  </button>
                </div>
              </div>
            )}

            {/* ZONES TAB */}
            {activeTab === "geofences" && (
              <div className="flex flex-col gap-4">
                 <button onClick={() => setIsAddingGeofence(!isAddingGeofence)} className={`w-full py-3 rounded-xl border transition-all flex items-center justify-center gap-2 font-bold text-sm ${isAddingGeofence ? 'bg-red-600 border-red-500 text-white' : 'bg-blue-600 border-blue-500 text-white hover:bg-blue-500'}`}>
                   {isAddingGeofence ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />} {isAddingGeofence ? 'Cancel Recording' : 'Add New Zone'}
                 </button>
                 {isAddingGeofence && (
                   <div className="bg-slate-800 p-4 rounded-xl border border-red-500/30 animate-in slide-in-from-top-2">
                     <p className="text-[10px] text-red-400 italic mb-3">Click on the map to set zone center</p>
                     <input type="text" placeholder="Zone Name" value={geofenceName} onChange={e => setGeofenceName(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white mb-3" />
                     <div className="flex items-center gap-2 mb-4">
                       <span className="text-[10px] text-slate-500 uppercase font-bold">Radius</span>
                       <input type="number" value={geofenceRadius} onChange={e => setGeofenceRadius(Number(e.target.value))} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white" />
                     </div>
                     <button onClick={handleSaveGeofence} className="w-full bg-emerald-600 py-2 rounded-lg text-white font-bold text-xs">Save Zone</button>
                   </div>
                 )}
                 <div className="flex flex-col gap-2">
                   {geofences.map(gf => (
                     <div key={gf.id} className="bg-slate-800/50 border border-slate-700 p-3 rounded-lg flex justify-between items-center">
                       <div><div className="font-bold text-xs text-white">{gf.name}</div><div className="text-[9px] text-slate-500 uppercase">{gf.radius_meters}m radius</div></div>
                       <button onClick={() => handleDeleteGeofence(gf.id)} className="text-slate-500 hover:text-red-400"><X className="w-4 h-4" /></button>
                     </div>
                   ))}
                 </div>
              </div>
            )}

            {/* ALERTS TAB */}
            {activeTab === "alerts" && (
              <div className="flex flex-col gap-3">
                {geofenceAlerts.length === 0 && <p className="text-xs text-slate-500 italic text-center py-10">No recent zone alerts recorded.</p>}
                {geofenceAlerts.map((a, i) => (
                  <div key={i} className={`p-3 rounded-lg border flex items-start gap-3 transition-opacity ${i > 5 ? 'opacity-50' : 'opacity-100'} ${a.type === 'enter' ? 'bg-emerald-900/10 border-emerald-900/30' : 'bg-red-900/10 border-red-900/30'}`}>
                    <div className={`p-1.5 rounded-full mt-0.5 ${a.type === 'enter' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}><MapPin className="w-3.5 h-3.5" /></div>
                    <div className="flex-1">
                      <div className="flex justify-between items-start"><span className="text-xs font-bold text-white">{a.zone}</span><span className="text-[9px] text-slate-500">{formatDistanceToNow(new Date(a.time), { addSuffix: true })}</span></div>
                      <p className="text-[10px] text-slate-400 mt-0.5 uppercase tracking-wide">{a.device_id} - <span className={a.type === 'enter' ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>{a.type.toUpperCase()}ED</span></p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* DEVICES TAB */}
            {activeTab === "devices" && (
              <div className="flex flex-col gap-4">
                <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700">
                  <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-4">Link New Device</h2>
                  <div className="flex gap-2">
                    <input type="text" placeholder="Device Code" value={newDeviceCode} onChange={e => setNewDeviceCode(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
                    <button onClick={handleAddDevice} className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-2 rounded-lg transition"><Plus className="w-4 h-4" /></button>
                  </div>
                  {deviceStatusMsg && <p className={`mt-2 text-[10px] font-bold ${deviceStatusMsg.includes("success") ? "text-emerald-400" : "text-red-400"}`}>{deviceStatusMsg}</p>}
                </div>

                <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700">
                  <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-4">Telegram Control</h2>
                  <div className="flex flex-col gap-3">
                    <p className="text-[10px] text-slate-500 leading-relaxed italic">
                      Paste your Telegram Chat ID here to enable remote commands like /killon. You can get your ID from the bot using /groupid.
                    </p>
                    <div className="flex gap-2">
                       <input 
                        type="text" 
                        placeholder="Telegram Chat ID" 
                        value={telegramId} 
                        onChange={e => setTelegramId(e.target.value)} 
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" 
                      />
                      <button 
                        onClick={handleLinkTelegram} 
                        disabled={isLinkingTelegram}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg text-xs font-bold transition disabled:opacity-50"
                      >
                        {isLinkingTelegram ? "..." : "Link"}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-800/80 p-4 rounded-xl border border-slate-700">
                  <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-3">Linked ({assignedDevices.length})</h2>
                  <div className="flex flex-col gap-2">
                    {assignedDevices.map(id => (
                      <div key={id} className="flex justify-between items-center bg-slate-900/50 border border-slate-700 p-2.5 rounded-lg">
                        <span className="text-sm font-bold text-white">{id}</span>
                        <button onClick={() => handleRemoveDevice(id)} className="text-slate-500 hover:text-red-400"><X className="w-4 h-4" /></button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>

      {/* Map Area */}
      <div className={`flex-1 p-2 lg:p-4 relative h-full ${isDarkMode ? 'bg-slate-950' : 'bg-slate-200'}`}>
        
        {/* Floating Search Bar */}
        <div className="mobile-search-safe absolute top-6 left-1/2 -translate-x-1/2 z-[1000] w-full max-w-md px-4">
          <div className="relative group">
            <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
              <Search className="w-4 h-4 text-slate-400 group-focus-within:text-blue-500 transition-colors" />
            </div>
            <input
              type="text"
              placeholder="Search destination or address..."
              value={destination}
              onChange={(e) => {
                setDestination(e.target.value);
                if (debounceRef.current) clearTimeout(debounceRef.current);
                debounceRef.current = setTimeout(async () => {
                  if (e.target.value.length > 2) {
                    const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(e.target.value)}.json?access_token=${mapboxgl.accessToken}&limit=5`);
                    const data = await res.json();
                    setSuggestions(data.features || []);
                    setShowSuggestions(true);
                  }
                }, 500);
              }}
              className="w-full bg-slate-900/90 backdrop-blur-md border border-slate-700/50 rounded-2xl pl-11 pr-4 py-3.5 text-sm text-white shadow-2xl shadow-black/50 focus:outline-none focus:border-blue-500/50 transition-all"
            />
            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-slate-900/95 backdrop-blur-xl border border-slate-800 rounded-xl overflow-hidden shadow-2xl z-[1001] animate-in fade-in slide-in-from-top-2 duration-200">
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setDestination(s.place_name);
                      setSelectedCoords(s.center);
                      setShowSuggestions(false);
                      setSuggestions([]);
                    }}
                    className="w-full text-left px-4 py-3 text-xs text-slate-300 hover:bg-blue-600 hover:text-white border-b border-slate-800/50 last:border-0 transition-colors flex items-center gap-3"
                  >
                    <MapPin className="w-3.5 h-3.5 text-blue-500" />
                    <span className="truncate">{s.place_name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <LiveMap
          fleetLatest={fleetLatest}
          selectedDeviceId={selectedDeviceId}
          selectedHistory={selectedHistory}
          etaInfo={etaInfo}
          alternativeRoutes={alternativeRoutes}
          selectedRouteIndex={selectedRouteIndex}
          onSelectCar={setSelectedDeviceId}
          playbackPoint={playbackPoint}
          geofences={geofences}
          onMapClick={isAddingGeofence ? (lat: number, lon: number) => setNewGeofencePos({ lat, lon }) : undefined}
          isAddingGeofence={isAddingGeofence}
          isDarkMode={isDarkMode}
        />
      </div>

      {/* Mobile Hamburger Handle (Visual only, to indicate sidebar can open) */}
      {!isSidebarOpen && (
        <button onClick={() => setIsSidebarOpen(true)} className="lg:hidden fixed top-4 left-4 z-40 p-3 rounded-full bg-blue-600 text-white shadow-xl shadow-blue-900/30">
          <Menu className="w-6 h-6" />
        </button>
      )}

    </main>
  );
}
