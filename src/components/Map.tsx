"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { Crosshair, MapPin, Activity } from "lucide-react";



interface TelemetryPoint {
  device_id: string;
  lat: number;
  lon: number;
  speed_kmh: number;
  altitude_m: number;
  satellites: number;
  created_at: string;
}

interface Geofence {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radius_meters: number;
}

interface MapProps {
  fleetLatest: TelemetryPoint[];
  selectedDeviceId: string | null;
  selectedHistory: TelemetryPoint[];
  etaInfo: { distance: string; duration: string; routeLine: [number, number][] } | null;
  alternativeRoutes?: { distance: string; duration: string; summary: string; routeLine: [number, number][] }[];
  selectedRouteIndex?: number;
  onSelectCar: (id: string) => void;
  playbackPoint?: TelemetryPoint | null;
  geofences: Geofence[];
  onMapClick?: (lat: number, lng: number) => void;
  isAddingGeofence?: boolean;
  isDarkMode?: boolean;
}

// Generate circle polygon coordinates for geofences
function createGeoJSONCircle(center: [number, number], radiusKm: number, points = 64): GeoJSON.Feature<GeoJSON.Polygon> {
  const coords: [number, number][] = [];
  const distanceX = radiusKm / (111.32 * Math.cos((center[1] * Math.PI) / 180));
  const distanceY = radiusKm / 110.574;

  for (let i = 0; i < points; i++) {
    const theta = (i / points) * (2 * Math.PI);
    const x = distanceX * Math.cos(theta);
    const y = distanceY * Math.sin(theta);
    coords.push([center[0] + x, center[1] + y]);
  }
  coords.push(coords[0]); // close the ring

  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [coords] },
  };
}

export default function Map({
  fleetLatest,
  selectedDeviceId,
  selectedHistory,
  etaInfo,
  alternativeRoutes = [],
  selectedRouteIndex = 0,
  onSelectCar,
  playbackPoint,
  geofences,
  onMapClick,
  isAddingGeofence,
  isDarkMode = true,
}: MapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<globalThis.Map<string, mapboxgl.Marker>>(new globalThis.Map());
  const playbackMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [showTraffic, setShowTraffic] = useState(false);

  const defaultCenter: [number, number] = [22.0, -34.0]; // [lng, lat]

  // Initialize the map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    // Ensure the token is set before initialization
    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN || "";

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: isDarkMode ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/streets-v12",
      center: defaultCenter,
      zoom: 13,
      attributionControl: false,
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-left");

    map.on("load", () => {
      // Add empty sources for all dynamic layers
      map.addSource("history-trail", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "history-trail-line",
        type: "line",
        source: "history-trail",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          // Speed color bands: 0-60 blue, 60-100 green, 100-130 orange, 130+ red
          "line-color": [
            "step", ["get", "speed_kmh"],
            "#3b82f6",  // default: blue (0-60)
            60,  "#10b981",  // green  (60-100)
            100, "#f59e0b",  // orange (100-130)
            130, "#ef4444"   // red    (130+)
          ],
          "line-width": 4,
          "line-opacity": 0.85,
        },
      });

      // Mapbox real-time traffic layer (toggled by showTraffic state)
      map.addSource("mapbox-traffic", {
        type: "vector",
        url: "mapbox://mapbox.mapbox-traffic-v1",
      });
      map.addLayer({
        id: "traffic-layer",
        type: "line",
        source: "mapbox-traffic",
        "source-layer": "traffic",
        layout: { visibility: "none" },
        paint: {
          "line-width": 3,
          "line-color": [
            "match", ["get", "congestion"],
            "low",    "#10b981",
            "moderate", "#f59e0b",
            "heavy",  "#ef4444",
            "severe", "#991b1b",
            "#94a3b8"
          ],
        },
      });

      // Route lines (up to 3 alternatives + selected)
      for (let i = 0; i < 3; i++) {
        map.addSource(`route-alt-${i}`, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: `route-alt-${i}-line`,
          type: "line",
          source: `route-alt-${i}`,
          paint: {
            "line-color": ["#10b981", "#3b82f6", "#f59e0b"][i],
            "line-width": 3,
            "line-opacity": 0.4,
            "line-dasharray": [2, 2],
          },
        });
      }

      map.addSource("route-selected", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "route-selected-line",
        type: "line",
        source: "route-selected",
        paint: {
          "line-color": "#10b981",
          "line-width": 5,
          "line-opacity": 0.9,
          "line-dasharray": [2, 2],
        },
      });

      // Geofences
      map.addSource("geofences", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "geofences-fill",
        type: "fill",
        source: "geofences",
        paint: {
          "fill-color": "#ef4444",
          "fill-opacity": 0.25,
        },
      });
      map.addLayer({
        id: "geofences-border",
        type: "line",
        source: "geofences",
        paint: {
          "line-color": "#dc2626",
          "line-width": 3,
          "line-dasharray": [2, 2],
        },
      });


      // Stop markers - orange circles where unit paused > 2 min
      map.addSource("stop-points", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "stop-circles",
        type: "circle",
        source: "stop-points",
        paint: {
          "circle-radius": 10,
          "circle-color": "#f59e0b",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
          "circle-opacity": 0.92,
        },
      });
      map.addLayer({
        id: "stop-labels",
        type: "symbol",
        source: "stop-points",
        layout: {
          "text-field": ["get", "label"],
          "text-size": 9,
          "text-offset": [0, 2.2],
          "text-anchor": "top",
        },
        paint: {
          "text-color": "#f59e0b",
          "text-halo-color": "#0f172a",
          "text-halo-width": 1.5,
        },
      });

      // Hover popup for stop circles
      const stopPopup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false });
      map.on("mouseenter", "stop-circles", (e) => {
        map.getCanvas().style.cursor = "pointer";
        const feat = e.features?.[0];
        if (!feat) return;
        const coords = (feat.geometry as GeoJSON.Point).coordinates as [number, number];
        stopPopup
          .setLngLat(coords)
          .setHTML(`<div style="font-family:system-ui;padding:4px 8px;">
            <div style="font-weight:700;color:#f59e0b;font-size:13px;">P Parked</div>
            <div style="color:#475569;font-size:12px;">${feat.properties?.duration_text ?? ""}</div>
          </div>`)
          .addTo(map);
      });
      map.on("mouseleave", "stop-circles", () => {
        map.getCanvas().style.cursor = "";
        stopPopup.remove();
      });
      setMapLoaded(true);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      setMapLoaded(false);
    };
  }, []); // mount once

  // Switch map style on dark/light mode toggle
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const newStyle = isDarkMode ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/streets-v12";

    // Save a flag to re-add sources after style change
    map.once("style.load", () => {
      // Re-add all sources and layers after style switch
      if (!map.getSource("history-trail")) {
        map.addSource("history-trail", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "history-trail-line",
          type: "line",
          source: "history-trail",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": [
              "step", ["get", "speed_kmh"],
              "#3b82f6", 60, "#10b981", 100, "#f59e0b", 130, "#ef4444"
            ],
            "line-width": 4,
            "line-opacity": 0.85,
          },
        });
      }

      // Re-add traffic layer if not present
      if (!map.getSource("mapbox-traffic")) {
        map.addSource("mapbox-traffic", {
          type: "vector",
          url: "mapbox://mapbox.mapbox-traffic-v1",
        });
        map.addLayer({
          id: "traffic-layer",
          type: "line",
          source: "mapbox-traffic",
          "source-layer": "traffic",
          layout: { visibility: showTraffic ? "visible" : "none" },
          paint: {
            "line-width": 3,
            "line-color": [
              "match", ["get", "congestion"],
              "low", "#10b981",
              "moderate", "#f59e0b",
              "heavy", "#ef4444",
              "severe", "#991b1b",
              "#94a3b8"
            ],
          },
        });
      }

      for (let i = 0; i < 3; i++) {
        if (!map.getSource(`route-alt-${i}`)) {
          map.addSource(`route-alt-${i}`, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: `route-alt-${i}-line`,
            type: "line",
            source: `route-alt-${i}`,
            paint: {
              "line-color": ["#10b981", "#3b82f6", "#f59e0b"][i],
              "line-width": 3,
              "line-opacity": 0.4,
              "line-dasharray": [2, 2],
            },
          });
        }
      }

      if (!map.getSource("route-selected")) {
        map.addSource("route-selected", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "route-selected-line",
          type: "line",
          source: "route-selected",
          paint: { "line-color": "#10b981", "line-width": 5, "line-opacity": 0.9, "line-dasharray": [2, 2] },
        });
      }

      if (!map.getSource("geofences")) {
        map.addSource("geofences", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "geofences-fill",
          type: "fill",
          source: "geofences",
          paint: { "fill-color": "#ef4444", "fill-opacity": 0.25 },
        });
        map.addLayer({
          id: "geofences-border",
          type: "line",
          source: "geofences",
          paint: { "line-color": "#dc2626", "line-width": 3, "line-dasharray": [2, 2] },
        });
      }

      if (!map.getSource("stop-points")) {
        map.addSource("stop-points", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "stop-circles",
          type: "circle",
          source: "stop-points",
          paint: {
            "circle-radius": 10,
            "circle-color": "#f59e0b",
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
            "circle-opacity": 0.92,
          },
        });
        map.addLayer({
          id: "stop-labels",
          type: "symbol",
          source: "stop-points",
          layout: {
            "text-field": ["get", "label"],
            "text-size": 9,
            "text-offset": [0, 2.2],
            "text-anchor": "top",
          },
          paint: {
            "text-color": "#f59e0b",
            "text-halo-color": "#0f172a",
            "text-halo-width": 1.5,
          },
        });
      }

      setMapLoaded(true);
    });

    setMapLoaded(false);
    map.setStyle(newStyle);
  }, [isDarkMode]);

  // Handle map click for geofence placement
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleClick = (e: mapboxgl.MapMouseEvent) => {
      if (onMapClick) {
        onMapClick(e.lngLat.lat, e.lngLat.lng);
      }
    };

    map.on("click", handleClick);

    // Change cursor when in geofence-adding mode
    if (isAddingGeofence) {
      map.getCanvas().style.cursor = "crosshair";
    } else {
      map.getCanvas().style.cursor = "";
    }

    return () => {
      map.off("click", handleClick);
    };
  }, [onMapClick, isAddingGeofence]);

  // Update fleet markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const currentIds = new Set(fleetLatest.map((c) => c.device_id));

    // Remove markers for devices no longer in the fleet
    markersRef.current.forEach((marker, id) => {
      if (!currentIds.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    });

    // Add or update markers
    fleetLatest.forEach((car) => {
      const isSelected = car.device_id === selectedDeviceId;
      const color = isSelected ? "#ef4444" : "#3b82f6";
      const existing = markersRef.current.get(car.device_id);

      if (existing) {
        // Update position
        existing.setLngLat([car.lon, car.lat]);
        // Update color by replacing the marker element's style
        const el = existing.getElement();
        const svg = el.querySelector("svg");
        if (svg) {
          const fills = svg.querySelectorAll("[fill]");
          fills.forEach((f) => {
            if (f.getAttribute("fill") !== "white") {
              f.setAttribute("fill", color);
            }
          });
        }
      } else {
        // Create new marker
        const marker = new mapboxgl.Marker({ color, scale: 0.85 })
          .setLngLat([car.lon, car.lat])
          .setPopup(
            new mapboxgl.Popup({ offset: 25, closeButton: false, maxWidth: "200px" }).setHTML(
              `<div style="font-family:system-ui;padding:4px;">
                <div style="font-weight:700;color:#1e293b;font-size:13px;">${car.device_id}</div>
                <div style="color:#64748b;font-size:12px;">Speed: ${car.speed_kmh.toFixed(0)} km/h</div>
              </div>`
            )
          )
          .addTo(map);

        marker.getElement().addEventListener("click", (e) => {
          e.stopPropagation();
          onSelectCar(car.device_id);
        });

        marker.getElement().style.cursor = "pointer";
        markersRef.current.set(car.device_id, marker);
      }
    });
  }, [fleetLatest, selectedDeviceId, mapLoaded, onSelectCar]);

  // Playback ghost marker (purple)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    if (playbackPoint) {
      if (playbackMarkerRef.current) {
        playbackMarkerRef.current.setLngLat([playbackPoint.lon, playbackPoint.lat]);
      } else {
        playbackMarkerRef.current = new mapboxgl.Marker({ color: "#8b5cf6", scale: 0.85 })
          .setLngLat([playbackPoint.lon, playbackPoint.lat])
          .setPopup(
            new mapboxgl.Popup({ offset: 25, closeButton: false, maxWidth: "200px" }).setHTML(
              `<div style="font-family:system-ui;padding:4px;">
                <div style="font-weight:700;color:#6d28d9;font-size:13px;">Playback</div>
                <div style="color:#64748b;font-size:12px;">${playbackPoint.speed_kmh.toFixed(0)} km/h</div>
              </div>`
            )
          )
          .addTo(map);
      }

      // Update popup content
      const popup = playbackMarkerRef.current.getPopup();
      if (popup) {
        popup.setHTML(
          `<div style="font-family:system-ui;padding:4px;">
            <div style="font-weight:700;color:#6d28d9;font-size:13px;">Playback</div>
            <div style="color:#64748b;font-size:12px;">${playbackPoint.speed_kmh.toFixed(0)} km/h</div>
            <div style="color:#94a3b8;font-size:11px;">${new Date(playbackPoint.created_at).toLocaleTimeString()}</div>
          </div>`
        );
      }
    } else {
      if (playbackMarkerRef.current) {
        playbackMarkerRef.current.remove();
        playbackMarkerRef.current = null;
      }
    }
  }, [playbackPoint, mapLoaded]);

  // Fly to selected car or playback point
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    let target: { lng: number; lat: number } | null = null;

    if (playbackPoint) {
      target = { lng: playbackPoint.lon, lat: playbackPoint.lat };
    } else {
      const selected = fleetLatest.find((c) => c.device_id === selectedDeviceId);
      if (selected) {
        target = { lng: selected.lon, lat: selected.lat };
      }
    }

    if (target) {
      map.flyTo({ center: [target.lng, target.lat], speed: 1.2 });
    }
  }, [selectedDeviceId, playbackPoint?.lat, playbackPoint?.lon, mapLoaded, fleetLatest.find(c => c.device_id === selectedDeviceId)?.lat, fleetLatest.find(c => c.device_id === selectedDeviceId)?.lon]);

  // Update history trail - draw per-segment features so each carries a speed value_kmh property
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const source = map.getSource("history-trail") as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;

    if (selectedHistory.length > 1) {
      // Safeguard: Sort history chronologically before drawing segments
      const sortedHistory = [...selectedHistory].sort((a, b) => 
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );

      const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
      for (let i = 0; i < sortedHistory.length - 1; i++) {
        const a = sortedHistory[i];
        const b = sortedHistory[i + 1];
        const avgSpeed = (a.speed_kmh + b.speed_kmh) / 2;
        features.push({
          type: "Feature",
          properties: { speed_kmh: avgSpeed },
          geometry: {
            type: "LineString",
            coordinates: [[a.lon, a.lat], [b.lon, b.lat]],
          },
        });
      }
      source.setData({ type: "FeatureCollection", features });
    } else {
      source.setData({ type: "FeatureCollection", features: [] });
    }
  }, [selectedHistory, mapLoaded]);

  // Toggle traffic layer visibility
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    if (map.getLayer("traffic-layer")) {
      map.setLayoutProperty("traffic-layer", "visibility", showTraffic ? "visible" : "none");
    }
  }, [showTraffic, mapLoaded]);
  // Detect stops (stationary > 2 min) from history gaps and render markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const source = map.getSource("stop-points") as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;

    const STOP_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];

    // Safeguard: Sort history chronologically before calculating stops
    const sortedHistory = [...selectedHistory].sort((a, b) => 
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    for (let i = 0; i < sortedHistory.length - 1; i++) {
      const curr = sortedHistory[i];
      const next = sortedHistory[i + 1];
      const tCurr = new Date(curr.created_at).getTime();
      const tNext = new Date(next.created_at).getTime();
      const gapMs = tNext - tCurr;

      if (gapMs >= STOP_THRESHOLD_MS) {
        const gapMin = Math.round(gapMs / 60000);
        const label = gapMin >= 60
          ? `${Math.floor(gapMin / 60)}h ${gapMin % 60}m`
          : `${gapMin} min`;
        features.push({
          type: "Feature",
          properties: {
            duration_text: `Stopped for ${label}`,
            label: `P ${label}`,
          },
          geometry: { type: "Point", coordinates: [curr.lon, curr.lat] },
        });
      }
    }

    source.setData({ type: "FeatureCollection", features });
  }, [selectedHistory, mapLoaded]);


  // Update route lines
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    // Clear all alt routes
    for (let i = 0; i < 3; i++) {
      const source = map.getSource(`route-alt-${i}`) as mapboxgl.GeoJSONSource | undefined;
      if (source) {
        source.setData({ type: "FeatureCollection", features: [] });
      }
    }

    const selectedSource = map.getSource("route-selected") as mapboxgl.GeoJSONSource | undefined;
    if (selectedSource) {
      selectedSource.setData({ type: "FeatureCollection", features: [] });
    }

    if (alternativeRoutes.length > 1) {
      // Draw non-selected routes as alternatives
      alternativeRoutes.forEach((route, i) => {
        if (i === selectedRouteIndex || route.routeLine.length === 0) return;
        const source = map.getSource(`route-alt-${i}`) as mapboxgl.GeoJSONSource | undefined;
        if (source) {
          const coords: [number, number][] = route.routeLine.map(([lat, lng]) => [lng, lat]);
          source.setData({
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: coords },
          });
        }
      });

      // Draw selected route on top
      const sel = alternativeRoutes[selectedRouteIndex];
      if (sel && sel.routeLine.length > 0 && selectedSource) {
        const coords: [number, number][] = sel.routeLine.map(([lat, lng]) => [lng, lat]);
        const colors = ["#10b981", "#3b82f6", "#f59e0b"];
        map.setPaintProperty("route-selected-line", "line-color", colors[selectedRouteIndex] || "#10b981");
        selectedSource.setData({
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: coords },
        });
      }
    } else if (etaInfo && etaInfo.routeLine.length > 0 && selectedSource) {
      const coords: [number, number][] = etaInfo.routeLine.map(([lat, lng]) => [lng, lat]);
      selectedSource.setData({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: coords },
      });
    }
  }, [etaInfo, alternativeRoutes, selectedRouteIndex, mapLoaded]);

  // Update geofences
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const source = map.getSource("geofences") as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;

    if (geofences.length > 0) {
      console.log(`Map: Updating ${geofences.length} geofences...`);
      const features = geofences.map((gf) =>
        createGeoJSONCircle([gf.lon, gf.lat], Number(gf.radius_meters) / 1000)
      );
      source.setData({ type: "FeatureCollection", features });
    } else {
      console.log("Map: Clearing geofences.");
      source.setData({ type: "FeatureCollection", features: [] });
    }
  }, [geofences, mapLoaded]);

  // Focus helper functions
  const flyToCar = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const selected = fleetLatest.find((c) => c.device_id === selectedDeviceId);
    if (selected) {
      map.flyTo({ center: [selected.lon, selected.lat], zoom: 16, speed: 1.5 });
    }
  }, [fleetLatest, selectedDeviceId]);

  const flyToDestination = useCallback(() => {
    const map = mapRef.current;
    if (!map || !etaInfo || etaInfo.routeLine.length === 0) return;
    const lastPt = etaInfo.routeLine[etaInfo.routeLine.length - 1];
    map.flyTo({ center: [lastPt[1], lastPt[0]], zoom: 16, speed: 1.5 });
  }, [etaInfo]);

  const selectedCarLatest = fleetLatest.find((c) => c.device_id === selectedDeviceId);
  const hasCarPos = !!selectedCarLatest;
  const hasDestPos = !!(etaInfo && etaInfo.routeLine.length > 0);

  return (
    <div className="relative w-full h-full rounded-2xl overflow-hidden border border-slate-700 shadow-xl">
      <div ref={mapContainerRef} className="w-full h-full" />

      {/* Speed Legend */}
      <div className="absolute top-3 left-3 z-10 bg-slate-900/80 backdrop-blur-sm border border-slate-700 rounded-xl p-2.5 flex flex-col gap-1 text-[10px]">
        <div className="text-slate-400 font-bold uppercase tracking-widest mb-0.5">Speed</div>
        {[
          { color: "#3b82f6", label: "0 - 60 km/h" },
          { color: "#10b981", label: "60 - 100 km/h" },
          { color: "#f59e0b", label: "100 - 130 km/h" },
          { color: "#ef4444", label: "130 + km/h" },
        ].map(({ color, label }) => (
          <div key={label} className="flex items-center gap-1.5">
            <div className="w-3 h-1.5 rounded-full" style={{ backgroundColor: color }} />
            <span className="text-slate-300">{label}</span>
          </div>
        ))}
      </div>

      {/* Floating Controls */}
      <div className="absolute bottom-8 right-6 lg:bottom-6 lg:right-6 z-10 flex flex-col gap-2">
        {/* Traffic Toggle */}
        <button
          onClick={() => setShowTraffic(t => !t)}
          className={`p-2 rounded-lg shadow-lg border transition-all active:scale-95 text-[10px] font-bold ${
            showTraffic
              ? "bg-amber-500 border-amber-400 text-white"
              : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
          }`}
          title="Toggle Traffic"
        >
          LIVE TRAFFIC
        </button>
        {hasCarPos && (
          <button
            onClick={flyToCar}
            className="bg-blue-600 text-white p-3 rounded-full shadow-lg border border-blue-500 hover:bg-blue-500 transition-transform active:scale-95"
            title="Focus on Car"
          >
            <Crosshair className="w-5 h-5" />
          </button>
        )}
        {hasDestPos && (
          <button
            onClick={flyToDestination}
            className="bg-emerald-600 text-white p-3 rounded-full shadow-lg border border-emerald-500 hover:bg-emerald-500 transition-transform active:scale-95"
            title="Focus on Destination"
          >
            <MapPin className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  );
}

