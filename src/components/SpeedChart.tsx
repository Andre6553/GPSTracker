"use client";

import { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

interface TelemetryPoint {
  created_at: string;
  speed_kmh: number;
}

interface SpeedChartProps {
  data: TelemetryPoint[];
}

export default function SpeedChart({ data }: SpeedChartProps) {
  const chartData = useMemo(() => {
    return [...data].reverse().map(pt => ({
      time: new Date(pt.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      speed: Math.round(pt.speed_kmh)
    }));
  }, [data]);

  if (data.length === 0) return null;

  return (
    <div className="w-full h-48 mt-4 bg-slate-800/80 p-4 rounded-xl border border-slate-700">
      <h3 className="text-xs font-bold text-slate-400 mb-2 uppercase tracking-wider">Speed Over Time (km/h)</h3>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="colorSpeed" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8}/>
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
            <XAxis dataKey="time" stroke="#64748b" fontSize={10} tickMargin={10} minTickGap={30} />
            <YAxis stroke="#64748b" fontSize={10} axisLine={false} tickLine={false} />
            <Tooltip 
              contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px' }}
              itemStyle={{ color: '#60a5fa', fontWeight: 'bold' }}
              labelStyle={{ color: '#94a3b8', fontSize: '12px' }}
            />
            <Area type="monotone" dataKey="speed" stroke="#3b82f6" strokeWidth={2} fillOpacity={1} fill="url(#colorSpeed)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
