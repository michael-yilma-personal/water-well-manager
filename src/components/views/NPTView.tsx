import React, { useState } from 'react';
import { Borehole, DrillingEvent, EventType } from '../../types';
import {
  AlertTriangle,
  Clock,
  Wrench,
  Droplets,
  Plus,
  Trash2,
  FileText,
  Filter,
} from 'lucide-react';

interface NPTViewProps {
  borehole: Borehole;
  events: DrillingEvent[];
  onOpenEventModal: (type?: EventType) => void;
  onDeleteEvent: (id: string) => void;
  sunlightMode: boolean;
}

export const NPTView: React.FC<NPTViewProps> = ({
  borehole,
  events,
  onOpenEventModal,
  onDeleteEvent,
  sunlightMode,
}) => {
  const [typeFilter, setTypeFilter] = useState<string>('ALL');

  const uniqueTypes = Array.from(new Set(events.map((e) => e.type)));

  const filtered = events.filter((e) => {
    if (typeFilter !== 'ALL' && e.type !== typeFilter) return false;
    return true;
  });

  const totalNPTMinutes = events
    .filter((e) => e.isNPT)
    .reduce((sum, e) => sum + (e.durationMinutes || 0), 0);
  const totalNPTHours = (totalNPTMinutes / 60).toFixed(1);

  const breakdownCount = events.filter((e) => e.type === 'Breakdown').length;
  const bitChangeCount = events.filter((e) => e.type === 'Bit Change').length;
  const waterStrikeCount = events.filter((e) => e.type === 'Water Strike').length;

  return (
    <div className="flex flex-col flex-1 max-w-7xl mx-auto w-full px-2 sm:px-4 py-3 sm:py-4 gap-4">
      {/* Header / Summary Card */}
      <div
        className={`p-4 sm:p-5 rounded-xl border-2 flex flex-col md:flex-row items-center justify-between gap-4 ${
          sunlightMode
            ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
            : 'bg-[#1A1A1A] border-[#D1D1D1]/30 text-white'
        }`}
      >
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-lg bg-red-600 text-white flex items-center justify-center font-black">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg sm:text-xl font-black uppercase tracking-tight">
              NON-PRODUCTIVE TIME (NPT) & RIG EVENT REGISTER
            </h2>
            <p className="text-xs opacity-80 font-bold">
              Track Mechanical Breakdowns, Tool Replacements, Strata Shifts, & Water Strikes
            </p>
          </div>
        </div>

        <button
          onClick={() => onOpenEventModal('Breakdown')}
          className="w-full md:w-auto px-4 py-2.5 rounded-lg bg-[#FFD700] hover:bg-[#e6c200] text-black font-black text-xs uppercase flex items-center justify-center gap-1.5 shadow-lg"
        >
          <Plus className="w-4 h-4" /> Log Field Event / Breakdown
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div
          className={`border-2 p-3 rounded-lg flex flex-col justify-between ${
            sunlightMode
              ? 'bg-black border-[#FFD700] text-[#FFD700]'
              : 'bg-white border-[#D1D1D1] text-black'
          }`}
        >
          <span className="text-[10px] uppercase font-black opacity-60">
            Total Downtime (NPT)
          </span>
          <span className="text-3xl font-black text-red-500 mt-1">
            {totalNPTHours} <span className="text-base font-bold">hrs</span>
          </span>
          <span className="text-[10px] font-bold opacity-60">
            {totalNPTMinutes} mins total
          </span>
        </div>

        <div
          className={`border-2 p-3 rounded-lg flex flex-col justify-between ${
            sunlightMode
              ? 'bg-black border-[#FFD700] text-[#FFD700]'
              : 'bg-white border-[#D1D1D1] text-black'
          }`}
        >
          <span className="text-[10px] uppercase font-black opacity-60">
            Breakdowns Recorded
          </span>
          <span className="text-3xl font-black mt-1">
            {breakdownCount}
          </span>
          <span className="text-[10px] font-bold opacity-60">
            Mechanical / Hydraulics
          </span>
        </div>

        <div
          className={`border-2 p-3 rounded-lg flex flex-col justify-between ${
            sunlightMode
              ? 'bg-black border-[#FFD700] text-[#FFD700]'
              : 'bg-white border-[#D1D1D1] text-black'
          }`}
        >
          <span className="text-[10px] uppercase font-black opacity-60">
            Bit Replacements
          </span>
          <span className="text-3xl font-black text-amber-500 mt-1">
            {bitChangeCount}
          </span>
          <span className="text-[10px] font-bold opacity-60">
            Bit wear & inspections
          </span>
        </div>

        <div
          className={`border-2 p-3 rounded-lg flex flex-col justify-between ${
            sunlightMode
              ? 'bg-black border-[#FFD700] text-[#FFD700]'
              : 'bg-white border-[#D1D1D1] text-black'
          }`}
        >
          <span className="text-[10px] uppercase font-black opacity-60">
            Water Strikes Logged
          </span>
          <span className="text-3xl font-black text-cyan-500 mt-1">
            {waterStrikeCount}
          </span>
          <span className="text-[10px] font-bold opacity-60">
            Yield / Aquifer alerts
          </span>
        </div>
      </div>

      {/* Event Filter & Table */}
      <div
        className={`rounded-xl border-2 overflow-hidden shadow-lg ${
          sunlightMode
            ? 'bg-zinc-950 border-[#FFD700]'
            : 'bg-white border-[#D1D1D1]'
        }`}
      >
        <div className="p-3 border-b-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-black uppercase">
            <Filter className="w-4 h-4 opacity-60" /> Filter Event Type:
          </div>
          <div className="flex gap-1.5 flex-wrap">
            <button
              onClick={() => setTypeFilter('ALL')}
              className={`px-3 py-1 rounded text-xs font-black uppercase border ${
                typeFilter === 'ALL'
                  ? 'bg-[#FFD700] text-black border-[#FFD700]'
                  : 'bg-zinc-800 text-white border-zinc-700'
              }`}
            >
              All ({events.length})
            </button>
            {uniqueTypes.map((type) => (
              <button
                key={type}
                onClick={() => setTypeFilter(type)}
                className={`px-3 py-1 rounded text-xs font-black uppercase border ${
                  typeFilter === type
                    ? 'bg-[#FFD700] text-black border-[#FFD700]'
                    : 'bg-zinc-800 text-white border-zinc-700'
                }`}
              >
                {type}
              </button>
            ))}
          </div>
        </div>

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
                <th className="p-3">Time & Date</th>
                <th className="p-3">Event Type</th>
                <th className="p-3">NPT Downtime</th>
                <th className="p-3">Depth (m)</th>
                <th className="p-3">Description & Action Taken</th>
                <th className="p-3">Logged By</th>
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
                  <td colSpan={7} className="p-8 text-center opacity-60">
                    No events or downtime incidents recorded.
                  </td>
                </tr>
              ) : (
                filtered.map((evt) => (
                  <tr
                    key={evt.id}
                    className={`transition-colors ${
                      sunlightMode
                        ? 'hover:bg-zinc-900/60'
                        : 'hover:bg-gray-50'
                    }`}
                  >
                    <td className="p-3 font-mono text-xs">
                      {evt.timestamp.replace('T', ' ').slice(0, 16)}
                    </td>
                    <td className="p-3">
                      <span
                        className={`px-2 py-1 rounded font-black text-xs uppercase ${
                          evt.type === 'Breakdown'
                            ? 'bg-red-500/20 text-red-500 border border-red-500/40'
                            : evt.type === 'Water Strike'
                              ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/40'
                              : 'bg-amber-500/20 text-amber-500 border border-amber-500/40'
                        }`}
                      >
                        {evt.type}
                      </span>
                    </td>
                    <td className="p-3 font-black">
                      {evt.isNPT ? (
                        <span className="text-red-500">
                          {evt.durationMinutes} mins (NPT)
                        </span>
                      ) : (
                        <span className="opacity-40">0 mins</span>
                      )}
                    </td>
                    <td className="p-3 font-mono">
                      {evt.depthAtEvent ? `${evt.depthAtEvent}m` : '—'}
                    </td>
                    <td className="p-3 max-w-sm">
                      <div className="font-bold">{evt.title}</div>
                      {evt.details?.notes && (
                        <div className="text-xs opacity-75 mt-0.5">
                          {evt.details.notes}
                        </div>
                      )}
                    </td>
                    <td className="p-3 font-semibold">{evt.operator}</td>
                    <td className="p-3 text-right">
                      <button
                        onClick={() => {
                          if (
                            window.confirm(
                              `Remove ${evt.type} log entry?`
                            )
                          ) {
                            onDeleteEvent(evt.id);
                          }
                        }}
                        className="p-1.5 rounded hover:bg-red-500/20 text-red-400 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
