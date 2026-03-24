"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { Crosshair, MapPin, Activity } from "lucide-react";

export interface TelemetryPoint {
  id: number;
  device_id: string;
  lat: number;
  lon: number;
  speed_kmh: number;
  altitude_m: number;
  satellites: number;
  created_at: string;
}

export interface Geofence {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radius_meters: number;
}

export interface MapProps {
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
function calculateBearing(lat1: number, lon1: number, lat2: number, lon2: number) {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return ((θ * 180) / Math.PI + 360) % 360;
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
    type: "Feature", properties: {},
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
          "line-color": "#facc15",
          "line-width": 10, // Increased for fail-safe visibility
          "line-opacity": 0.95,
        },
      });

      // Neon Beads (High-visibility marker for every GPS point)
      map.addSource("history-beads", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "history-trail-beads",
        type: "circle",
        source: "history-beads",
        paint: {
          "circle-radius": 6, // Larger beads
          "circle-color": "#ffffff",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#facc15",
        },
      });

      // Directional markers (circles)
      map.addSource("history-arrows", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "history-arrows-layer",
        type: "circle",
        source: "history-arrows",
        paint: {
          "circle-radius": 5,
          "circle-color": "#ffffff",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#facc15",
          "circle-opacity": 1.0,
        },
      });

      // Mapbox real-time traffic layer
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
            "low", "#10b981", "moderate", "#f59e0b", "heavy", "#ef4444", "severe", "#991b1b", "#94a3b8"
          ],
        },
      });

      // Route lines
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
        paint: { "line-color": "#10b981", "line-width": 5, "line-opacity": 0.9, "line-dasharray": [2, 2] },
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
        paint: { "fill-color": "#ef4444", "fill-opacity": 0.25 },
      });
      map.addLayer({
        id: "geofences-border",
        type: "line",
        source: "geofences",
        paint: { "line-color": "#dc2626", "line-width": 3, "line-dasharray": [2, 2] },
      });

      // Stop markers
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

      const stopPopup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false });
      map.on("mouseenter", "stop-circles", (e) => {
        map.getCanvas().style.cursor = "pointer";
        const feat = e.features?.[0];
        if (!feat) return;
        const coords = (feat.geometry as GeoJSON.Point).coordinates as [number, number];
        stopPopup
          .setLngLat(coords)
          .setHTML(`<div style="font-family:system-ui;padding:4px 8px;">
            <div style="font-weight:700;color:#f59e0b;font-size:13px;">Parked</div>
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
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const newStyle = isDarkMode ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/streets-v12";

    map.once("style.load", () => {
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
            "line-color": "#facc15",
            "line-width": 8,
            "line-opacity": 0.95,
          },
        });
      }

      if (!map.getSource("history-beads")) {
        map.addSource("history-beads", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "history-trail-beads",
          type: "circle",
          source: "history-beads",
          paint: {
            "circle-radius": 4,
            "circle-color": "#ffffff",
            "circle-stroke-width": 1.5,
            "circle-stroke-color": "#facc15",
          },
        });
      }

      if (!map.getSource("history-arrows")) {
        map.addSource("history-arrows", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "history-arrows-layer",
          type: "circle",
          source: "history-arrows",
          paint: {
            "circle-radius": 5,
            "circle-color": "#ffffff",
            "circle-stroke-width": 2,
            "circle-stroke-color": "#facc15",
            "circle-opacity": 1.0,
          },
        });
      }

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
              "low", "#10b981", "moderate", "#f59e0b", "heavy", "#ef4444", "severe", "#991b1b", "#94a3b8"
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

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handleClick = (e: mapboxgl.MapMouseEvent) => {
      if (onMapClick) onMapClick(e.lngLat.lat, e.lngLat.lng);
    };
    map.on("click", handleClick);
    if (isAddingGeofence) map.getCanvas().style.cursor = "crosshair";
    else map.getCanvas().style.cursor = "";
    return () => { map.off("click", handleClick); };
  }, [onMapClick, isAddingGeofence]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const currentIds = new Set(fleetLatest.map((c) => c.device_id));
    markersRef.current.forEach((marker, id) => {
      if (!currentIds.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    });

    fleetLatest.forEach((car) => {
      const isSelected = car.device_id === selectedDeviceId;
      const color = isSelected ? "#ef4444" : "#3b82f6";
      const existing = markersRef.current.get(car.device_id);

      if (existing) {
        existing.setLngLat([car.lon, car.lat]);
        const el = existing.getElement();
        const svg = el.querySelector("svg");
        if (svg) {
          const fills = svg.querySelectorAll("[fill]");
          fills.forEach((f) => {
            if (f.getAttribute("fill") !== "white") f.setAttribute("fill", color);
          });
        }
      } else {
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
    } else if (playbackMarkerRef.current) {
      playbackMarkerRef.current.remove();
      playbackMarkerRef.current = null;
    }
  }, [playbackPoint, mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    let target: { lng: number; lat: number } | null = null;
    if (playbackPoint) target = { lng: playbackPoint.lon, lat: playbackPoint.lat };
    else {
      const selected = fleetLatest.find((c) => c.device_id === selectedDeviceId);
      if (selected) target = { lng: selected.lon, lat: selected.lat };
    }
    if (target) map.flyTo({ center: [target.lng, target.lat], speed: 1.2 });
  }, [selectedDeviceId, playbackPoint?.lat, playbackPoint?.lon, mapLoaded, fleetLatest]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const trailSource = map.getSource("history-trail") as mapboxgl.GeoJSONSource | undefined;
    const arrowSource = map.getSource("history-arrows") as mapboxgl.GeoJSONSource | undefined;
    if (!trailSource || !arrowSource) return;

    if (selectedHistory.length > 1) {
      const sortedHistory = [...selectedHistory].sort((a,b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      
      const beadSource = map.getSource("history-beads") as mapboxgl.GeoJSONSource | undefined;
      
      // 1. Log First Coordinate for Audit
      const first = sortedHistory[0];
      console.log("TRACE START COORD:", [Number(first.lon), Number(first.lat)]);

      // 2. Single Continuous LineString wrapped in FeatureCollection
      const coordinates = sortedHistory.map(p => [Number(p.lon), Number(p.lat)]).filter(c => !isNaN(c[0]) && !isNaN(c[1]));
      trailSource.setData({
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          properties: { speed_kmh: Number(sortedHistory[0].speed_kmh) || 0 },
          geometry: { type: "LineString", coordinates } as any
        }]
      });

      // 3. Neon Beads (Individual Points)
      if (beadSource) {
        beadSource.setData({
          type: "FeatureCollection",
          features: sortedHistory.map(p => ({
            type: "Feature",
            properties: { id: p.id },
            geometry: { type: "Point", coordinates: [Number(p.lon), Number(p.lat)] }
          })) as any
        });
      }

      // 4. Directional Arrows
      const arrowFeatures: GeoJSON.Feature<GeoJSON.Point>[] = [];
      for (let i = 0; i < sortedHistory.length - 1; i += 5) {
        const a = sortedHistory[i], b = sortedHistory[i+1];
        const latA = Number(a.lat), lonA = Number(a.lon);
        const latB = Number(b.lat), lonB = Number(b.lon);
        if (isNaN(latA) || isNaN(lonA) || isNaN(latB) || isNaN(lonB)) continue;
        const dx = lonB - lonA, dy = latB - latA;
        const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
        arrowFeatures.push({
          type: "Feature",
          properties: { bearing },
          geometry: { type: "Point", coordinates: [lonA, latA] },
        });
      }
      arrowSource.setData({ type: "FeatureCollection", features: arrowFeatures });
      
      // 5. Force Layers to Top
      ["history-trail-line", "history-trail-beads", "history-arrows-layer"].forEach(id => {
        if (map.getLayer(id)) map.moveLayer(id);
      });

      console.log("MAP UPDATED: 1 line,", sortedHistory.length, "beads,", arrowFeatures.length, "arrows");
    } else {
      trailSource.setData({ type: "FeatureCollection", features: [] });
      arrowSource.setData({ type: "FeatureCollection", features: [] });
      if (map.getSource("history-beads")) (map.getSource("history-beads") as any).setData({ type: "FeatureCollection", features: [] });
    }
  }, [selectedHistory, mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    if (map.getLayer("traffic-layer")) {
      map.setLayoutProperty("traffic-layer", "visibility", showTraffic ? "visible" : "none");
    }
  }, [showTraffic, mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const source = map.getSource("stop-points") as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;

    const STOP_THRESHOLD_MS = 2 * 60 * 1000;
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
    const sortedHistory = [...selectedHistory].sort((a,b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    for (let i = 0; i < sortedHistory.length - 1; i++) {
      const curr = sortedHistory[i], next = sortedHistory[i+1];
      const gapMs = new Date(next.created_at).getTime() - new Date(curr.created_at).getTime();
      if (gapMs >= STOP_THRESHOLD_MS) {
        const gapMin = Math.round(gapMs / 60000);
        const label = gapMin >= 60 ? `${Math.floor(gapMin / 60)}h ${gapMin % 60}m` : `${gapMin} min`;
        features.push({
          type: "Feature",
          properties: { duration_text: `Stopped for ${label}`, label: `P ${label}` },
          geometry: { type: "Point", coordinates: [curr.lon, curr.lat] },
        });
      }
    }

    if (sortedHistory.length > 0) {
      const latest = sortedHistory[sortedHistory.length - 1];
      const idleMs = Date.now() - new Date(latest.created_at).getTime();
      if (idleMs > STOP_THRESHOLD_MS) {
        const idleMin = Math.round(idleMs / 60000);
        const label = idleMin >= 60 ? `${Math.floor(idleMin / 60)}h ${idleMin % 60}m` : `${idleMin} min`;
        features.push({
          type: "Feature",
          properties: { duration_text: `Stationary for ${label}`, label: `P ${label}` },
          geometry: { type: "Point", coordinates: [latest.lon, latest.lat] },
        });
      }
    }
    source.setData({ type: "FeatureCollection", features });
  }, [selectedHistory, mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    for (let i = 0; i < 3; i++) {
      const s = map.getSource(`route-alt-${i}`) as mapboxgl.GeoJSONSource | undefined;
      if (s) s.setData({ type: "FeatureCollection", features: [] });
    }
    const selSource = map.getSource("route-selected") as mapboxgl.GeoJSONSource | undefined;
    if (selSource) {
      selSource.setData({ type: "FeatureCollection", features: [] });
      if (alternativeRoutes.length > 1) {
        alternativeRoutes.forEach((route, i) => {
          if (i === selectedRouteIndex || route.routeLine.length === 0) return;
          const altS = map.getSource(`route-alt-${i}`) as mapboxgl.GeoJSONSource | undefined;
          if (altS) altS.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route.routeLine.map(([lat, lng]) => [lng, lat]) } });
        });
        const sel = alternativeRoutes[selectedRouteIndex];
        if (sel && sel.routeLine.length > 0) {
          map.setPaintProperty("route-selected-line", "line-color", ["#10b981", "#3b82f6", "#f59e0b"][selectedRouteIndex] || "#10b981");
          selSource.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: sel.routeLine.map(([lat, lng]) => [lng, lat]) } });
        }
      } else if (etaInfo && etaInfo.routeLine.length > 0) {
        selSource.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: etaInfo.routeLine.map(([lat, lng]) => [lng, lat]) } });
      }
    }
  }, [etaInfo, alternativeRoutes, selectedRouteIndex, mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const s = map.getSource("geofences") as mapboxgl.GeoJSONSource | undefined;
    if (!s) return;
    if (geofences.length > 0) {
      const features = geofences.map((gf) => createGeoJSONCircle([gf.lon, gf.lat], Number(gf.radius_meters) / 1000));
      s.setData({ type: "FeatureCollection", features });
    } else s.setData({ type: "FeatureCollection", features: [] });
  }, [geofences, mapLoaded]);

  const flyToCar = useCallback(() => {
    const selected = fleetLatest.find((c) => c.device_id === selectedDeviceId);
    if (selected && mapRef.current) mapRef.current.flyTo({ center: [selected.lon, selected.lat], zoom: 16, speed: 1.5 });
  }, [fleetLatest, selectedDeviceId]);

  const flyToDestination = useCallback(() => {
    if (etaInfo && etaInfo.routeLine.length > 0 && mapRef.current) {
      const lastPt = etaInfo.routeLine[etaInfo.routeLine.length - 1];
      mapRef.current.flyTo({ center: [lastPt[1], lastPt[0]], zoom: 16, speed: 1.5 });
    }
  }, [etaInfo]);

  const hasCarPos = !!fleetLatest.find((c) => c.device_id === selectedDeviceId);
  const hasDestPos = !!(etaInfo && etaInfo.routeLine.length > 0);

  return (
    <div className="relative w-full h-full rounded-2xl overflow-hidden border border-slate-700 shadow-xl">
      <div ref={mapContainerRef} className="w-full h-full" />
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
      <div className="absolute bottom-8 right-6 lg:bottom-6 lg:right-6 z-10 flex flex-col gap-2">
        <button
          onClick={() => setShowTraffic(t => !t)}
          className={`p-2 rounded-lg shadow-lg border transition-all active:scale-95 text-[10px] font-bold ${showTraffic ? "bg-amber-500 border-amber-400 text-white" : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"}`}
        >
          LIVE TRAFFIC
        </button>
        {hasCarPos && (
          <button onClick={flyToCar} className="bg-blue-600 text-white p-3 rounded-full shadow-lg border border-blue-500 hover:bg-blue-500 transition-transform active:scale-95">
            <Crosshair className="w-5 h-5" />
          </button>
        )}
        {hasDestPos && (
          <button onClick={flyToDestination} className="bg-emerald-600 text-white p-3 rounded-full shadow-lg border border-emerald-500 hover:bg-emerald-500 transition-transform active:scale-95">
            <MapPin className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  );
}
