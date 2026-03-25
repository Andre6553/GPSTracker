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

// Must match after every style reload (theme toggle); otherwise trail reverts to solid color or breaks.
const HISTORY_TRAIL_LINE_LAYOUT: mapboxgl.LineLayout = {
  "line-join": "round",
  "line-cap": "round",
};

const HISTORY_TRAIL_LINE_PAINT: mapboxgl.LinePaint = {
  "line-color": [
    "step",
    ["to-number", ["get", "speed_kmh"]],
    "#3b82f6",
    30,
    "#10b981",
    60,
    "#f59e0b",
    100,
    "#ef4444",
  ],
  "line-width": 5,
  "line-opacity": 0.85,
};

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

const TRAIL_ARROW_IMAGE_ID = "trail-arrow";

/** Points north (up) in canvas space; rotated by `bearing` in symbol layer. */
function createTrailArrowImageData(): ImageData {
  const s = 64;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const ctx = c.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas not available for trail arrow");
  }
  ctx.clearRect(0, 0, s, s);
  ctx.fillStyle = "#f8fafc";
  ctx.strokeStyle = "#0f172a";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(s / 2, 8);
  ctx.lineTo(s - 10, s - 12);
  ctx.lineTo(s / 2, s - 22);
  ctx.lineTo(10, s - 12);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  return ctx.getImageData(0, 0, s, s);
}

function ensureTrailArrowImage(map: mapboxgl.Map) {
  if (map.hasImage(TRAIL_ARROW_IMAGE_ID)) return;
  map.addImage(TRAIL_ARROW_IMAGE_ID, createTrailArrowImageData(), { pixelRatio: 2 });
}

/**
 * Clockwise degrees from north for the segment as drawn on screen (Mercator projection).
 * Matches Mapbox line rendering so arrows stay parallel to the trail polyline.
 */
function screenSegmentBearingDeg(
  map: mapboxgl.Map,
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number
): number {
  const p1 = map.project([lon1, lat1]);
  const p2 = map.project([lon2, lat2]);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** GeoJSON-serializable props for trail beads / arrows (popup on click). */
function trailPointFeatureProps(
  p: TelemetryPoint,
  kind: "bead" | "arrow",
  extra: Record<string, string | number> = {}
) {
  return {
    kind,
    id: p.id,
    device_id: String(p.device_id),
    lat: Number(p.lat),
    lon: Number(p.lon),
    speed_kmh: Number(p.speed_kmh) || 0,
    altitude_m: Number(p.altitude_m) || 0,
    satellites: Number(p.satellites) || 0,
    created_at: p.created_at,
    ...extra,
  };
}

function formatTrailPointPopupHtml(props: GeoJSON.GeoJsonProperties): string {
  if (!props || typeof props !== "object") return "";
  const p = props as Record<string, unknown>;
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  const speed = Number(p.speed_kmh);
  const alt = Number(p.altitude_m);
  const sats = Number(p.satellites);
  const device = escapeHtml(String(p.device_id ?? ""));
  const createdRaw = String(p.created_at ?? "");
  const timeStr = escapeHtml(
    createdRaw ? new Date(createdRaw).toLocaleString() : "—"
  );
  const kind = p.kind === "arrow" ? "Direction" : "Point";
  const title = escapeHtml(kind);

  return `<div style="font-family:system-ui,sans-serif;padding:4px;min-width:200px;">
    <div style="font-weight:700;color:#1e293b;font-size:13px;">Trail · ${title}</div>
    <div style="color:#64748b;font-size:11px;margin:4px 0 6px;">${timeStr}</div>
    <div style="color:#475569;font-size:12px;line-height:1.45;">
      <div><strong>Lat</strong> ${Number.isFinite(lat) ? lat.toFixed(6) : "—"}</div>
      <div><strong>Lon</strong> ${Number.isFinite(lon) ? lon.toFixed(6) : "—"}</div>
      <div><strong>Speed</strong> ${Number.isFinite(speed) ? speed.toFixed(1) : "—"} km/h</div>
      <div><strong>Altitude</strong> ${Number.isFinite(alt) ? alt.toFixed(0) : "—"} m</div>
      <div><strong>Satellites</strong> ${Number.isFinite(sats) ? String(Math.round(sats)) : "—"}</div>
      <div style="margin-top:4px;"><strong>Device</strong> ${device}</div>
    </div>
  </div>`;
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
  const skipInitialThemeStyleRef = useRef(true);
  const selectedHistoryRef = useRef<TelemetryPoint[]>([]);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [showTraffic, setShowTraffic] = useState(false);

  selectedHistoryRef.current = selectedHistory;

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
        layout: HISTORY_TRAIL_LINE_LAYOUT,
        paint: HISTORY_TRAIL_LINE_PAINT,
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
          "circle-radius": 3,
          "circle-color": "#ffffff",
          "circle-stroke-width": 1,
          "circle-stroke-color": "#000000",
        },
      });

      // Direction of travel (arrow symbols; bearing = screen-parallel segment angle)
      map.addSource("history-arrows", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      ensureTrailArrowImage(map);
      map.addLayer({
        id: "history-arrows-layer",
        type: "symbol",
        source: "history-arrows",
        layout: {
          "icon-image": TRAIL_ARROW_IMAGE_ID,
          "icon-size": 0.42,
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "viewport",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          "icon-opacity": 0.95,
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
        paint: { "fill-color": "#ef4444", "fill-opacity": 0.5 },
      });
      map.addLayer({
        id: "geofences-border",
        type: "line",
        source: "geofences",
        paint: { "line-color": "#ff0000", "line-width": 4 },
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
      skipInitialThemeStyleRef.current = true;
      map.remove();
      mapRef.current = null;
      setMapLoaded(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const newStyle = isDarkMode ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/streets-v12";

    // First paint already uses newStyle in map constructor; avoid setStyle() which wipes layers
    // and drops speed-based trail until re-fetch — and matched the old bug where re-added trail was solid yellow.
    if (skipInitialThemeStyleRef.current) {
      skipInitialThemeStyleRef.current = false;
      return;
    }

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
          layout: HISTORY_TRAIL_LINE_LAYOUT,
          paint: HISTORY_TRAIL_LINE_PAINT,
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
        ensureTrailArrowImage(map);
        map.addLayer({
          id: "history-arrows-layer",
          type: "symbol",
          source: "history-arrows",
          layout: {
            "icon-image": TRAIL_ARROW_IMAGE_ID,
            "icon-size": 0.42,
            "icon-rotate": ["get", "bearing"],
            "icon-rotation-alignment": "viewport",
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
          paint: {
            "icon-opacity": 0.95,
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
          paint: { "fill-color": "#ef4444", "fill-opacity": 0.5 },
        });
        map.addLayer({
          id: "geofences-border",
          type: "line",
          source: "geofences",
          paint: { "line-color": "#ff0000", "line-width": 4 },
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
    if (!map || !mapLoaded) return;

    const trailPopup = new mapboxgl.Popup({
      closeButton: true,
      closeOnClick: true,
      maxWidth: "320px",
      offset: 12,
    });

    const trailLayers = ["history-trail-beads", "history-arrows-layer"];

    const handleClick = (e: mapboxgl.MapMouseEvent) => {
      if (!isAddingGeofence) {
        const available = trailLayers.filter((id) => map.getLayer(id));
        if (available.length) {
          const feats = map.queryRenderedFeatures(e.point, { layers: available });
          if (feats.length > 0) {
            const f = feats[0];
            const geom = f.geometry;
            if (geom && geom.type === "Point") {
              const coords = geom.coordinates as [number, number];
              trailPopup
                .setLngLat(coords)
                .setHTML(formatTrailPointPopupHtml(f.properties))
                .addTo(map);
              return;
            }
          }
        }
      }
      trailPopup.remove();
      if (onMapClick) onMapClick(e.lngLat.lat, e.lngLat.lng);
    };

    const onEnter = () => {
      if (!isAddingGeofence) map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      if (!isAddingGeofence) map.getCanvas().style.cursor = "";
    };

    map.on("click", handleClick);
    for (const id of trailLayers) {
      if (map.getLayer(id)) {
        map.on("mouseenter", id, onEnter);
        map.on("mouseleave", id, onLeave);
      }
    }

    if (isAddingGeofence) map.getCanvas().style.cursor = "crosshair";
    else map.getCanvas().style.cursor = "";

    return () => {
      map.off("click", handleClick);
      for (const id of trailLayers) {
        if (map.getLayer(id)) {
          map.off("mouseenter", id, onEnter);
          map.off("mouseleave", id, onLeave);
        }
      }
      trailPopup.remove();
    };
  }, [onMapClick, isAddingGeofence, mapLoaded]);

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

  // Fit camera to full history trail when present (otherwise live follow pulls view back to "home")
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !playbackPoint) return;
    map.flyTo({ center: [playbackPoint.lon, playbackPoint.lat], speed: 1.2 });
  }, [playbackPoint?.lat, playbackPoint?.lon, mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || playbackPoint) return;
    if (selectedHistory.length < 2) return;

    const sorted = [...selectedHistory].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    let minLng = Infinity,
      maxLng = -Infinity,
      minLat = Infinity,
      maxLat = -Infinity;
    for (const p of sorted) {
      const lo = Number(p.lon),
        la = Number(p.lat);
      if (Number.isNaN(lo) || Number.isNaN(la)) continue;
      minLng = Math.min(minLng, lo);
      maxLng = Math.max(maxLng, lo);
      minLat = Math.min(minLat, la);
      maxLat = Math.max(maxLat, la);
    }
    if (minLng === Infinity) return;
    const lonSpan = maxLng - minLng;
    const latSpan = maxLat - minLat;
    if (lonSpan < 1e-9 && latSpan < 1e-9) return;

    map.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      { padding: 56, maxZoom: 15, duration: 900 }
    );
  }, [selectedHistory, mapLoaded, playbackPoint, selectedDeviceId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || playbackPoint) return;
    if (selectedHistory.length > 1) return;

    const selected = fleetLatest.find((c) => c.device_id === selectedDeviceId);
    if (selected) map.flyTo({ center: [selected.lon, selected.lat], speed: 1.2 });
  }, [selectedDeviceId, mapLoaded, fleetLatest, selectedHistory.length, playbackPoint]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const trailSource = map.getSource("history-trail") as mapboxgl.GeoJSONSource | undefined;
    const arrowSource = map.getSource("history-arrows") as mapboxgl.GeoJSONSource | undefined;
    if (!trailSource || !arrowSource) return;

    const beadSource = map.getSource("history-beads") as mapboxgl.GeoJSONSource | undefined;

    const applyHistoryTrail = () => {
      if (!map.isStyleLoaded()) return;
      const hist = selectedHistoryRef.current;

      if (hist.length < 2) {
        trailSource.setData({ type: "FeatureCollection", features: [] });
        arrowSource.setData({ type: "FeatureCollection", features: [] });
        if (beadSource) beadSource.setData({ type: "FeatureCollection", features: [] });
        return;
      }

      const sortedHistory = [...hist].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );

      const lineFeatures: GeoJSON.Feature<GeoJSON.LineString>[] = [];
      for (let i = 0; i < sortedHistory.length - 1; i++) {
        const start = sortedHistory[i],
          end = sortedHistory[i + 1];
        const lonA = Number(start.lon),
          latA = Number(start.lat);
        const lonB = Number(end.lon),
          latB = Number(end.lat);
        if (isNaN(lonA) || isNaN(latA) || isNaN(lonB) || isNaN(latB)) continue;

        lineFeatures.push({
          type: "Feature",
          properties: { speed_kmh: Number(end.speed_kmh) || 0 },
          geometry: { type: "LineString", coordinates: [[lonA, latA], [lonB, latB]] },
        });
      }
      trailSource.setData({ type: "FeatureCollection", features: lineFeatures });

      const beadFeatures: GeoJSON.Feature<GeoJSON.Point>[] = [];
      const arrowFeatures: GeoJSON.Feature<GeoJSON.Point>[] = [];
      const n = sortedHistory.length;
      for (let i = 0; i < n; i++) {
        const p = sortedHistory[i];
        const lon = Number(p.lon),
          lat = Number(p.lat);
        if (isNaN(lon) || isNaN(lat)) continue;

        if (i % 3 === 2) {
          let bearing = 0;
          if (i < n - 1) {
            const nx = sortedHistory[i + 1];
            const latN = Number(nx.lat),
              lonN = Number(nx.lon);
            if (!isNaN(latN) && !isNaN(lonN)) {
              bearing = screenSegmentBearingDeg(map, lon, lat, lonN, latN);
            }
          } else if (i > 0) {
            const pv = sortedHistory[i - 1];
            const latP = Number(pv.lat),
              lonP = Number(pv.lon);
            if (!isNaN(latP) && !isNaN(lonP)) {
              bearing = screenSegmentBearingDeg(map, lonP, latP, lon, lat);
            }
          }
          arrowFeatures.push({
            type: "Feature",
            properties: trailPointFeatureProps(p, "arrow", { bearing }),
            geometry: { type: "Point", coordinates: [lon, lat] },
          });
        } else {
          beadFeatures.push({
            type: "Feature",
            properties: trailPointFeatureProps(p, "bead"),
            geometry: { type: "Point", coordinates: [lon, lat] },
          });
        }
      }

      if (beadSource) {
        beadSource.setData({ type: "FeatureCollection", features: beadFeatures } as any);
      }
      arrowSource.setData({ type: "FeatureCollection", features: arrowFeatures });

      ["geofences-fill", "geofences-border", "history-trail-line", "history-trail-beads", "history-arrows-layer", "stop-circles"].forEach((id) => {
        if (map.getLayer(id)) map.moveLayer(id);
      });
    };

    applyHistoryTrail();

    const onCamera = () => applyHistoryTrail();
    map.on("moveend", onCamera);
    map.on("zoomend", onCamera);
    map.on("rotateend", onCamera);
    map.on("pitchend", onCamera);

    return () => {
      map.off("moveend", onCamera);
      map.off("zoomend", onCamera);
      map.off("rotateend", onCamera);
      map.off("pitchend", onCamera);
    };
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
      
      // Ensure geofences are ALWAYS on top immediately after update
      if (map.getLayer("geofences-fill")) map.moveLayer("geofences-fill");
      if (map.getLayer("history-trail-line")) map.moveLayer("history-trail-line"); // Path on top of fill
      if (map.getLayer("geofences-border")) map.moveLayer("geofences-border"); // Border on top of path
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
    <div className="mobile-map-safe relative w-full h-full rounded-2xl overflow-hidden border border-slate-700 shadow-xl">
      <div ref={mapContainerRef} className="w-full h-full" />
      <div className="mobile-speed-legend-safe absolute top-3 left-3 z-10 bg-slate-900/80 backdrop-blur-sm border border-slate-700 rounded-xl p-2.5 flex flex-col gap-1 text-[10px]">
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
