import React, { useState } from 'react';
import { Borehole, PipeRecord } from '../../types';
import {
  FileText,
  Trash2,
  Droplets,
  Layers,
  Search,
  Download,
  Filter,
  CheckCircle,
  Clock,
  ArrowUpDown,
} from 'lucide-react';

interface PipeLogViewProps {
  borehole: Borehole;
  pipeRecords: PipeRecord[];
  onDeletePipe: (id: string) => void;
  onExportPDF: () => void;
  onExportExcel: () => void;
  sunlightMode: boolean;
}

export const PipeLogView: React.FC<PipeLogViewProps> = ({
  borehole,
  pipeRecords,
  onDeletePipe,
  onExportPDF,
  onExportExcel,
  sunlightMode,
}) => {
  const [search, setSearch] = useState('');
  const [formationFilter, setFormationFilter] = useState<string>('ALL');
  const [showWaterStrikesOnly, setShowWaterStrikesOnly] = useState(false);

  // Extract all unique geological formations for the filter dropdown
  const uniqueFormations = Array.from(
    new Set(pipeRecords.map((r) => r.formation))
  );

  // Filter records
  const filtered = pipeRecords.filter((rec) => {
    if (showWaterStrikesOnly && !rec.waterStrike) return false;
    if (formationFilter !== 'ALL' && rec.formation !== formationFilter)
      return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        rec.pipeNumber.toString().includes(q) ||
        rec.formation.toLowerCase().includes(q) ||
        rec.operator.toLowerCase().includes(q) ||
        rec.remarks.toLowerCase().includes(q)
      );
    }
    return true;
  });

  // Calculate stats for header bar
  const totalMeters = pipeRecords.reduce((sum, r) => sum + r.pipeLength, 0);
  const totalSeconds = pipeRecords.reduce((sum, r) => sum + r.durationSeconds, 0);
  const avgSpeed =
    totalSeconds > 0
      ? (totalMeters / (totalSeconds / 3600)).toFixed(1)
      : '0.0';
  const strikeCount = pipeRecords.filter((r) => r.waterStrike).length;

  return (
    <div className="flex flex-col flex-1 max-w-7xl mx-auto w-full px-2 sm:px-4 py-3 sm:py-4 gap-4">
      {/* Top Controls & Summary Banner */}
      <div
        className={`p-4 rounded-xl border-2 flex flex-col md:flex-row items-center justify-between gap-4 ${
          sunlightMode
            ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
            : 'bg-[#1A1A1A] border-[#D1D1D1]/30 text-white'
        }`}
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[#FFD700] text-black flex items-center justify-center font-black">
            <FileText className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-black tracking-tight uppercase">
              {borehole.name} — PIPE-BY-PIPE LOG
            </h2>
            <p className="text-xs opacity-75 font-bold">
              Total Pipes: {pipeRecords.length} | Drilled Depth: {totalMeters.toFixed(2)}m | Avg Speed: {avgSpeed} m/hr
            </p>
          </div>
        </div>

        {/* Action Export Buttons */}
        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
          <button
            onClick={onExportPDF}
            className="flex-1 md:flex-initial py-2 px-3 rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow"
          >
            <Download className="w-4 h-4" /> Export PDF Log
          </button>
          <button
            onClick={onExportExcel}
            className="flex-1 md:flex-initial py-2 px-3 rounded-lg bg-[#FFD700] hover:bg-[#e6c200] text-black font-black text-xs flex items-center justify-center gap-1.5 shadow"
          >
            <Download className="w-4 h-4" /> Export Excel
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Search */}
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-3.5 opacity-50" />
          <input
            type="text"
            placeholder="Search pipe #, strata, driller..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`w-full pl-9 pr-3 py-2.5 rounded-lg border-2 font-bold text-xs sm:text-sm ${
              sunlightMode
                ? 'bg-zinc-950 border-[#FFD700] text-[#FFD700]'
                : 'bg-zinc-900 border-zinc-700 text-white'
            }`}
          />
        </div>

        {/* Formation Filter */}
        <div className="relative">
          <Filter className="w-4 h-4 absolute left-3 top-3.5 opacity-50" />
          <select
            value={formationFilter}
            onChange={(e) => setFormationFilter(e.target.value)}
            className={`w-full pl-9 pr-3 py-2.5 rounded-lg border-2 font-bold text-xs sm:text-sm ${
              sunlightMode
                ? 'bg-zinc-950 border-[#FFD700] text-[#FFD700]'
                : 'bg-zinc-900 border-zinc-700 text-white'
            }`}
          >
            <option value="ALL">All Formations ({uniqueFormations.length})</option>
            {uniqueFormations.map((form) => (
              <option key={form} value={form}>
                {form}
              </option>
            ))}
          </select>
        </div>

        {/* Water Strike Quick Switch */}
        <button
          onClick={() => setShowWaterStrikesOnly(!showWaterStrikesOnly)}
          className={`py-2.5 px-3 rounded-lg border-2 font-black text-xs uppercase flex items-center justify-center gap-2 transition-colors ${
            showWaterStrikesOnly
              ? 'bg-cyan-500 text-black border-cyan-400 shadow-lg'
              : sunlightMode
                ? 'bg-zinc-900 border-[#FFD700]/50 text-[#FFD700]'
                : 'bg-zinc-900 border-zinc-700 text-slate-300'
          }`}
        >
          <Droplets
            className={`w-4 h-4 ${
              showWaterStrikesOnly ? 'animate-bounce' : ''
            }`}
          />
          {showWaterStrikesOnly ? 'Showing Water Strikes Only' : `Water Strikes (${strikeCount})`}
        </button>
      </div>

      {/* Technical Dashboard / Data Grid Table */}
      <div
        className={`rounded-xl border-2 overflow-hidden shadow-lg ${
          sunlightMode
            ? 'bg-zinc-950 border-[#FFD700]'
            : 'bg-white border-[#D1D1D1]'
        }`}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr
                className={`border-b-2 text-xs uppercase tracking-wider font-black ${
                  sunlightMode
                    ? 'bg-zinc-900 text-[#FFD700] border-[#FFD700]'
                    : 'bg-[#1A1A1A] text-white border-black'
                }`}
              >
                <th className="p-3">Pipe #</th>
                <th className="p-3">Depth Interval</th>
                <th className="p-3">Length</th>
                <th className="p-3">Duration</th>
                <th className="p-3">Rate (m/hr)</th>
                <th className="p-3">Geological Strata</th>
                <th className="p-3">Water Strike</th>
                <th className="p-3">Air / Comp PSI</th>
                <th className="p-3">Driller & Remarks</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody
              className={`divide-y text-xs sm:text-sm font-bold ${
                sunlightMode
                  ? 'divide-yellow-500/20 text-amber-200'
                  : 'divide-gray-200 text-gray-900'
              }`}
            >
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={10} className="p-8 text-center opacity-60">
                    No pipe records match your search filter.
                  </td>
                </tr>
              ) : (
                filtered.map((rec) => {
                  const isStrike = rec.waterStrike;
                  return (
                    <tr
                      key={rec.id}
                      className={`transition-colors ${
                        isStrike
                          ? sunlightMode
                            ? 'bg-cyan-950/40 hover:bg-cyan-950/70'
                            : 'bg-cyan-50/80 hover:bg-cyan-100/80'
                          : sunlightMode
                            ? 'hover:bg-zinc-900/60'
                            : 'hover:bg-gray-50'
                      }`}
                    >
                      <td className="p-3 font-black text-sm">
                        #{rec.pipeNumber}
                      </td>
                      <td className="p-3 font-mono">
                        {rec.startDepth.toFixed(1)} – {rec.endDepth.toFixed(1)}m
                      </td>
                      <td className="p-3 font-black text-emerald-500">
                        {rec.pipeLength.toFixed(2)}m
                      </td>
                      <td className="p-3">
                        {Math.round(rec.durationSeconds / 60)} min
                      </td>
                      <td className="p-3">
                        <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-500 font-black">
                          {rec.penetrationRate.toFixed(1)} m/hr
                        </span>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-1.5">
                          <Layers className="w-3.5 h-3.5 opacity-60 shrink-0" />
                          <span className="font-extrabold">
                            {rec.formation}
                          </span>
                        </div>
                      </td>
                      <td className="p-3">
                        {isStrike ? (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-cyan-500 text-black font-black text-[11px] uppercase">
                            <Droplets className="w-3.5 h-3.5" /> Strike (
                            {rec.waterStrikeDetails?.flowRateLpm || 120} L/m)
                          </span>
                        ) : (
                          <span className="opacity-40 font-normal">No</span>
                        )}
                      </td>
                      <td className="p-3 font-mono text-xs">
                        {rec.airPressure}/{rec.compressorPressure}
                      </td>
                      <td className="p-3 max-w-xs">
                        <div className="font-black text-xs truncate">
                          {rec.operator}
                        </div>
                        <div className="text-[11px] opacity-75 truncate">
                          {rec.remarks}
                        </div>
                      </td>
                      <td className="p-3 text-right">
                        <button
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete Pipe #${rec.pipeNumber} record?`
                              )
                            ) {
                              onDeletePipe(rec.id);
                            }
                          }}
                          className="p-1.5 rounded hover:bg-red-500/20 text-red-400 transition-colors"
                          title="Delete pipe record"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
