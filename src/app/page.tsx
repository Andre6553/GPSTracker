"use client";

import { useEffect, useState, useMemo } from "react";
import dynamic from "next/dynamic";
import { supabase } from "@/lib/supabase";
import { Navigation, Clock, Activity, Gauge, MapPin, Truck } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

// Dynamically import map to avoid Next.js Server-Side Rendering errors with Leaflet
const LiveMap = dynamic(() => import("@/components/Map").then((m) => m.default), {
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

export default function Dashboard() {
  const [allData, setAllData] = useState<TelemetryPoint[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  
  const [destination, setDestination] = useState("");
  const [etaInfo, setEtaInfo] = useState<{ distance: string; duration: string; routeLine: [number, number][] } | null>(null);
  const [isRouting, setIsRouting] = useState(false);

  // Initialize Data & Realtime Subscription
  useEffect(() => {
    async function loadInitialData() {
      // Fetch the last 2000 points across the whole fleet
      const { data, error } = await supabase
        .from("telemetry")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(2000);

      if (data && data.length > 0) {
        setAllData(data as TelemetryPoint[]);
        
        // Auto-select the most recently active device
        const uniqueDevices = Array.from(new Set(data.map((d: any) => d.device_id)));
        if (uniqueDevices.length > 0) {
          setSelectedDeviceId(uniqueDevices[0] as string);
        }
      }
    }

    loadInitialData();

    // Subscribe to fresh rows live for ANY device
    const channel = supabase
      .channel("live_telemetry")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "telemetry" },
        (payload) => {
          const newPoint = payload.new as TelemetryPoint;
          setAllData((prev) => {
            const updated = [newPoint, ...prev];
            return updated.slice(0, 2000); // Keep buffer manageable
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Compute fleet state variables based on raw data
  const activeDevices = useMemo(() => Array.from(new Set(allData.map(d => d.device_id))), [allData]);
  
  const fleetLatest = useMemo(() => {
    return activeDevices.map(id => allData.find(d => d.device_id === id)!);
  }, [activeDevices, allData]);

  const selectedHistory = useMemo(() => {
    if (!selectedDeviceId) return [];
    // Filter to selected car, then reverse so oldest is first for the polyline drawing
    return allData.filter(d => d.device_id === selectedDeviceId).reverse();
  }, [allData, selectedDeviceId]);

  const currentPnt = selectedHistory.length > 0 ? selectedHistory[selectedHistory.length - 1] : null;

  // Calculate generic stats for the Selected Car
  const maxSpeed = selectedHistory.reduce((max, pt) => (pt.speed_kmh > max ? pt.speed_kmh : max), 0);
  const avgSpeed = selectedHistory.length > 0 
    ? selectedHistory.reduce((sum, pt) => sum + pt.speed_kmh, 0) / selectedHistory.length 
    : 0;

  // Handle Routing using Free Nominatim (Geocoding) + OSRM (Routing)
  const calculateRoute = async () => {
    if (!currentPnt || !destination) return;
    setIsRouting(true);

    try {
      // 1. Geocode the address
      const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(destination)}`);
      const geoData = await geoRes.json();
      
      if (!geoData || geoData.length === 0) {
        alert("Could not find destination address!");
        setIsRouting(false);
        return;
      }

      const destLat = parseFloat(geoData[0].lat);
      const destLon = parseFloat(geoData[0].lon);

      // 2. OSRM Routing (Format: lon,lat;lon,lat)
      const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${currentPnt.lon},${currentPnt.lat};${destLon},${destLat}?overview=full&geometries=geojson`;
      const routeRes = await fetch(osrmUrl);
      const routeData = await routeRes.json();

      if (routeData.code === "Ok") {
        const route = routeData.routes[0];
        const polyline: [number, number][] = route.geometry.coordinates.map((c: number[]) => [c[1], c[0]]);
        const mins = Math.round(route.duration / 60);
        const distKm = (route.distance / 1000).toFixed(1);

        setEtaInfo({
          distance: `${distKm} km`,
          duration: mins > 60 ? `${Math.floor(mins/60)}hr ${mins%60}m` : `${mins} min`,
          routeLine: polyline,
        });
      }
    } catch (e) {
      console.error(e);
      alert("Routing failed");
    } finally {
      setIsRouting(false);
    }
  };

  // Clear ETA when changing vehicles
  useEffect(() => {
    setEtaInfo(null);
  }, [selectedDeviceId]);

  return (
    <main className="flex h-screen w-full bg-slate-950 text-slate-200">
      
      {/* Sidebar Dashboard */}
      <div className="w-1/3 min-w-[320px] max-w-sm h-full p-6 flex flex-col gap-6 overflow-y-auto border-r border-slate-800 bg-slate-900/50 backdrop-blur-xl">
        <div className="flex items-center gap-3 mb-2">
          <Navigation className="text-blue-500 w-8 h-8" />
          <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
            Fleet Tracker
          </h1>
        </div>

        {/* Fleet Vehicle Selector (Horizontal Scroll) */}
        <div>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-3">
            <Truck className="w-4 h-4" /> Active Fleet ({activeDevices.length})
          </h2>
          <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
            {activeDevices.map(id => (
              <button 
                key={id}
                onClick={() => setSelectedDeviceId(id)}
                className={`px-4 py-2 rounded-lg text-sm font-bold whitespace-nowrap transition-colors flex flex-col items-start ${
                  selectedDeviceId === id 
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/40 border border-blue-500' 
                    : 'bg-slate-800 text-slate-400 hover:bg-slate-700 border border-slate-700'
                }`}
              >
                <span>{id}</span>
                <span className="text-[10px] font-normal opacity-80 mt-0.5">
                  {(fleetLatest.find(f => f.device_id === id)?.speed_kmh || 0).toFixed(0)} km/h
                </span>
              </button>
            ))}
            {activeDevices.length === 0 && (
              <span className="text-sm text-slate-500 italic">Waiting for cars to connect...</span>
            )}
          </div>
        </div>

        {/* Live Metrics Grid for Selected Vehicle */}
        {selectedDeviceId && (
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-sm flex flex-col justify-center">
              <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-1 flex items-center gap-1">
                <Gauge className="w-3 h-3"/> Speed
              </span>
              <span className="text-3xl font-black text-white">{currentPnt?.speed_kmh?.toFixed(0) || "0"}<span className="text-base font-medium text-slate-400 ml-1">km/h</span></span>
            </div>

            <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-sm flex flex-col justify-center">
              <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-1 flex items-center gap-1">
                <Activity className="w-3 h-3"/> Max Speed
              </span>
              <span className="text-2xl font-bold text-slate-200">{maxSpeed.toFixed(0)}<span className="text-sm text-slate-400 ml-1">km/h</span></span>
            </div>

            <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-sm flex flex-col justify-center">
              <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-1 flex items-center gap-1">
                <Gauge className="w-3 h-3"/> Avg Speed
              </span>
              <span className="text-2xl font-bold text-slate-200">{avgSpeed.toFixed(0)}<span className="text-sm text-slate-400 ml-1">km/h</span></span>
            </div>

            <div className="bg-slate-800 p-4 rounded-xl border border-slate-700 shadow-sm flex flex-col justify-center">
              <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider mb-1 flex items-center gap-1">
                <Activity className="w-3 h-3"/> Altitude
              </span>
              <span className="text-2xl font-bold text-slate-200">{currentPnt?.altitude_m?.toFixed(0) || "0"}<span className="text-sm text-slate-400 ml-1">m</span></span>
            </div>
          </div>
        )}

        {/* Status indicator */}
        {selectedDeviceId && (
          <div className="flex flex-col gap-1 px-2">
            <div className="flex items-center justify-between text-sm text-slate-400">
              <span className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${currentPnt ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></div>
                {currentPnt ? 'Live Tracking' : 'Offline'}
              </span>
              <span>Sats: {currentPnt?.satellites || 0}</span>
            </div>
            {currentPnt && (
              <div className="text-xs text-slate-500">
                Data age: {formatDistanceToNow(new Date(currentPnt.created_at), { addSuffix: true })}
              </div>
            )}
          </div>
        )}

        {/* ETA Calculator Box */}
        {selectedDeviceId && (
          <div className="mt-4 bg-slate-800/80 p-5 rounded-xl border border-slate-700">
            <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-widest flex items-center gap-2 mb-4">
              <MapPin className="w-4 h-4 text-emerald-400" /> Dispatch Route (ETA)
            </h2>
            
            <input 
              type="text" 
              placeholder="Enter destination..." 
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-all placeholder:text-slate-600 mb-3"
            />
            
            <button 
              onClick={calculateRoute}
              disabled={isRouting || !destination || !currentPnt}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-3 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-emerald-900/20"
            >
              {isRouting ? "Calculating..." : "Calculate ETA"}
            </button>

            {etaInfo && (
              <div className="mt-5 p-4 bg-emerald-950/30 border border-emerald-800/50 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-slate-400 text-xs uppercase tracking-wider">Drive Time</span>
                  <span className="text-emerald-400 font-bold flex items-center gap-1"><Clock className="w-3.5 h-3.5"/> {etaInfo.duration}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400 text-xs uppercase tracking-wider">Distance</span>
                  <span className="text-emerald-400 font-bold text-sm bg-emerald-950 px-2 py-0.5 rounded">{etaInfo.distance}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Map Area */}
      <div className="flex-1 p-4 relative h-full">
        {/* Pass all data to Map component (Client Only) */}
        <LiveMap 
          fleetLatest={fleetLatest}
          selectedDeviceId={selectedDeviceId}
          selectedHistory={selectedHistory}
          etaInfo={etaInfo}
          onSelectCar={setSelectedDeviceId}
        />
      </div>

    </main>
  );
}
