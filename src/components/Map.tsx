"use client";

import { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

// Default Blue Icon for unselected cars
const defaultIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

// Red Icon for the currently selected car
const selectedIcon = L.icon({
  iconUrl: "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

interface TelemetryPoint {
  device_id: string;
  lat: number;
  lon: number;
  speed_kmh: number;
  created_at: string;
}

interface MapProps {
  fleetLatest: TelemetryPoint[];
  selectedDeviceId: string | null;
  selectedHistory: TelemetryPoint[];
  etaInfo: { distance: string; duration: string; routeLine: [number, number][] } | null;
  onSelectCar: (id: string) => void;
}

export default function Map({ fleetLatest, selectedDeviceId, selectedHistory, etaInfo, onSelectCar }: MapProps) {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!isMounted) return <div className="w-full h-full bg-slate-900 animate-pulse rounded-2xl"></div>;

  // Center map on the selected car, or the first car in the fleet, or a fallback
  const selectedCarLatest = fleetLatest.find(c => c.device_id === selectedDeviceId);
  const defaultCenter = { lat: -34.0, lng: 22.0 };
  const center = selectedCarLatest ? { lat: selectedCarLatest.lat, lng: selectedCarLatest.lon } : defaultCenter;

  const pathPositions: [number, number][] = selectedHistory.map((pt) => [pt.lat, pt.lon]);

  return (
    <MapContainer center={center} zoom={13} className="w-full h-full rounded-2xl z-0 border border-slate-700 shadow-xl">
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        className="map-tiles"
      />
      
      {/* Draw all cars in the fleet */}
      {fleetLatest.map((car) => (
        <Marker 
          key={car.device_id} 
          position={[car.lat, car.lon]} 
          icon={car.device_id === selectedDeviceId ? selectedIcon : defaultIcon}
          eventHandlers={{
            click: () => onSelectCar(car.device_id),
          }}
        >
          <Popup>
            <div className="font-bold text-slate-800">{car.device_id}</div>
            <div className="text-sm text-slate-600">Speed: {car.speed_kmh.toFixed(0)} km/h</div>
          </Popup>
        </Marker>
      ))}

      {/* History Trail for the selected car */}
      {pathPositions.length > 1 && (
        <Polyline positions={pathPositions} color="#ef4444" weight={4} opacity={0.7} />
      )}

      {/* Predicted Route to Destination */}
      {etaInfo && etaInfo.routeLine.length > 0 && (
        <Polyline positions={etaInfo.routeLine} color="#10b981" weight={5} dashArray="10, 10" />
      )}
    </MapContainer>
  );
}
