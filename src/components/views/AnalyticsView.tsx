import React from 'react';
import { Borehole, PipeRecord, DrillingEvent } from '../../types';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { TrendingUp, Layers, Activity, Clock, Droplets } from 'lucide-react';

interface AnalyticsViewProps {
  borehole: Borehole;
  pipeRecords: PipeRecord[];
  events: DrillingEvent[];
  sunlightMode: boolean;
}

export const AnalyticsView: React.FC<AnalyticsViewProps> = ({
  borehole,
  pipeRecords,
  events,
  sunlightMode,
}) => {
  // Chart 1: Penetration rate by depth
  const depthChartData = pipeRecords.map((r) => ({
    depth: r.endDepth,
    rate: Number(r.penetrationRate.toFixed(1)),
    pipeNum: r.pipeNumber,
    formation: r.formation,
  }));

  // Chart 2: Total meters drilled per geological formation
  const formationTotals: { [key: string]: number } = {};
  pipeRecords.forEach((r) => {
    formationTotals[r.formation] =
      (formationTotals[r.formation] || 0) + r.pipeLength;
  });
  const formationChartData = Object.keys(formationTotals).map((name) => ({
    name,
    meters: Number(formationTotals[name].toFixed(1)),
  }));

  // Chart 3: Productive vs NPT hours breakdown
  const totalDrillSecs = pipeRecords.reduce(
    (sum, r) => sum + r.durationSeconds,
    0
  );
  const prodHours = Number((totalDrillSecs / 3600).toFixed(1));
  const nptMinutes = events
    .filter((e) => e.isNPT)
    .reduce((sum, e) => sum + (e.durationMinutes || 0), 0);
  const nptHours = Number((nptMinutes / 60).toFixed(1));

  const timeBreakdownData = [
    { name: 'Drilling (Productive)', value: prodHours, color: '#4ADE80' },
    { name: 'NPT (Downtime/Events)', value: nptHours, color: '#F87171' },
  ];

  const FORMATION_COLORS = [
    '#FFD700',
    '#3B82F6',
    '#10B981',
    '#F59E0B',
    '#8B5CF6',
    '#EC4899',
    '#06B6D4',
  ];

  return (
    <div className="flex flex-col flex-1 max-w-7xl mx-auto w-full px-2 sm:px-4 py-3 sm:py-4 gap-4">
      {/* Header Banner */}
      <div
        className={`p-4 rounded-xl border-2 flex items-center justify-between ${
          sunlightMode
            ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
            : 'bg-[#1A1A1A] border-[#D1D1D1]/30 text-white'
        }`}
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-600 text-white flex items-center justify-center font-black">
            <Activity className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-black tracking-tight uppercase">
              STRATA LITHOLOGY & PENETRATION PERFORMANCE ANALYTICS
            </h2>
            <p className="text-xs opacity-75 font-bold">
              Real-Time ROP Trends, Geological Horizons, & Efficiency Metrics
            </p>
          </div>
        </div>
      </div>

      {/* Grid of Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Chart 1: ROP vs Depth */}
        <div
          className={`p-4 rounded-xl border-2 flex flex-col ${
            sunlightMode
              ? 'bg-zinc-950 border-[#FFD700] text-[#FFD700]'
              : 'bg-white border-[#D1D1D1]'
          }`}
        >
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-black text-xs sm:text-sm uppercase tracking-wider flex items-center gap-1.5">
              <TrendingUp className="w-4 h-4 text-[#FFD700]" /> Rate of
              Penetration (m/hr) vs. Depth (m)
            </h3>
            <span className="text-[10px] font-bold opacity-60">
              Pipes #1–#{pipeRecords.length}
            </span>
          </div>

          <div className="h-64 sm:h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={depthChartData}
                margin={{ top: 10, right: 20, left: -10, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={sunlightMode ? '#444' : '#E5E7EB'}
                />
                <XAxis
                  dataKey="depth"
                  unit="m"
                  stroke={sunlightMode ? '#FFD700' : '#1A1A1A'}
                  fontSize={11}
                  fontWeight={800}
                />
                <YAxis
                  unit="m/h"
                  stroke={sunlightMode ? '#FFD700' : '#1A1A1A'}
                  fontSize={11}
                  fontWeight={800}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: sunlightMode ? '#000' : '#1A1A1A',
                    borderColor: '#FFD700',
                    borderRadius: '8px',
                    color: '#FFD700',
                    fontWeight: 800,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="rate"
                  name="ROP (m/hr)"
                  stroke="#FFD700"
                  strokeWidth={3}
                  fill="#FFD700"
                  fillOpacity={0.25}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 2: Meters per Formation */}
        <div
          className={`p-4 rounded-xl border-2 flex flex-col ${
            sunlightMode
              ? 'bg-zinc-950 border-[#FFD700] text-[#FFD700]'
              : 'bg-white border-[#D1D1D1]'
          }`}
        >
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-black text-xs sm:text-sm uppercase tracking-wider flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-blue-500" /> Meters Drilled by
              Geological Formation
            </h3>
            <span className="text-[10px] font-bold opacity-60">
              Lithology Summary
            </span>
          </div>

          <div className="h-64 sm:h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={formationChartData}
                margin={{ top: 10, right: 20, left: -10, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={sunlightMode ? '#444' : '#E5E7EB'}
                />
                <XAxis
                  dataKey="name"
                  stroke={sunlightMode ? '#FFD700' : '#1A1A1A'}
                  fontSize={11}
                  fontWeight={800}
                />
                <YAxis
                  unit="m"
                  stroke={sunlightMode ? '#FFD700' : '#1A1A1A'}
                  fontSize={11}
                  fontWeight={800}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: sunlightMode ? '#000' : '#1A1A1A',
                    borderColor: '#FFD700',
                    borderRadius: '8px',
                    color: '#FFD700',
                    fontWeight: 800,
                  }}
                />
                <Bar
                  dataKey="meters"
                  name="Meters Drilled"
                  fill="#3B82F6"
                  radius={[6, 6, 0, 0]}
                >
                  {formationChartData.map((entry, idx) => (
                    <Cell
                      key={`cell-${idx}`}
                      fill={FORMATION_COLORS[idx % FORMATION_COLORS.length]}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Second Row: Time Efficiency & Stratigraphic Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Time Pie Chart */}
        <div
          className={`p-4 rounded-xl border-2 flex flex-col items-center justify-center ${
            sunlightMode
              ? 'bg-zinc-950 border-[#FFD700] text-[#FFD700]'
              : 'bg-white border-[#D1D1D1]'
          }`}
        >
          <h3 className="font-black text-xs uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Clock className="w-4 h-4 text-emerald-500" /> Rig Efficiency
            (Productive vs NPT)
          </h3>
          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={timeBreakdownData}
                  cx="50%"
                  cy="50%"
                  innerRadius={45}
                  outerRadius={70}
                  paddingAngle={4}
                  dataKey="value"
                >
                  {timeBreakdownData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex gap-4 text-xs font-black mt-2">
            <span className="text-emerald-500">
              ● Productive: {prodHours} hrs
            </span>
            <span className="text-red-500">● NPT: {nptHours} hrs</span>
          </div>
        </div>

        {/* Strata Log List */}
        <div
          className={`lg:col-span-2 p-4 rounded-xl border-2 flex flex-col ${
            sunlightMode
              ? 'bg-zinc-950 border-[#FFD700] text-[#FFD700]'
              : 'bg-white border-[#D1D1D1]'
          }`}
        >
          <h3 className="font-black text-xs uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <Layers className="w-4 h-4 text-amber-500" /> Subsurface Lithology
            Profile ({borehole.name})
          </h3>

          <div className="space-y-2 overflow-y-auto max-h-52 pr-1">
            {pipeRecords.length === 0 ? (
              <p className="text-xs opacity-60">No pipes drilled yet.</p>
            ) : (
              pipeRecords.map((r) => (
                <div
                  key={r.id}
                  className={`p-2.5 rounded-lg border flex items-center justify-between text-xs font-bold ${
                    r.waterStrike
                      ? 'bg-cyan-950/50 border-cyan-400 text-cyan-300'
                      : sunlightMode
                        ? 'bg-zinc-900 border-zinc-700'
                        : 'bg-gray-50 border-gray-200 text-gray-800'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-black px-2 py-0.5 rounded bg-black text-[#FFD700]">
                      #{r.pipeNumber}
                    </span>
                    <span className="font-mono">
                      {r.startDepth}m → {r.endDepth}m
                    </span>
                    <span className="font-extrabold uppercase">
                      {r.formation}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    {r.waterStrike && (
                      <span className="px-2 py-0.5 rounded bg-cyan-400 text-black font-black uppercase text-[10px] flex items-center gap-1">
                        <Droplets className="w-3 h-3" /> Water Strike
                      </span>
                    )}
                    <span className="font-mono opacity-80">
                      {r.penetrationRate.toFixed(1)} m/hr
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
