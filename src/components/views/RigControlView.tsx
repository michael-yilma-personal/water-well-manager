import React, { useState, useEffect } from 'react';
import {
  ActivePipeTimer,
  Borehole,
  DrillingEvent,
  EventType,
  PipeRecord,
  User,
} from '../../types';
import {
  playStartPipeSound,
  playAlertSound,
  triggerVibration,
} from '../../utils/audio';
import {
  Clock,
  Play,
  Square,
  Wrench,
  AlertTriangle,
  Droplets,
  Layers,
  Fuel,
  Camera,
  Link2,
  CheckCircle,
  FileText,
  Download,
  Settings,
  Flame,
} from 'lucide-react';

interface RigControlViewProps {
  activeBorehole: Borehole;
  activeTimer: ActivePipeTimer;
  onStartPipe: () => void;
  onOpenEndPipeModal: () => void;
  /** Stop a pipe started by mistake; recorded as downtime, never as depth. */
  onCancelPipe: () => void;
  onOpenEventModal: (type: EventType) => void;
  onOpenSettings: () => void;
  pipeRecords: PipeRecord[];
  events: DrillingEvent[];
  currentUser: User;
  sunlightMode: boolean;
  onGenerateShiftReport: () => void;
  onExportExcel: () => void;
}

export const RigControlView: React.FC<RigControlViewProps> = ({
  activeBorehole,
  activeTimer,
  onStartPipe,
  onOpenEndPipeModal,
  onCancelPipe,
  onOpenEventModal,
  onOpenSettings,
  pipeRecords,
  events,
  currentUser,
  sunlightMode,
  onGenerateShiftReport,
  onExportExcel,
}) => {
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  // Live timer update
  useEffect(() => {
    let interval: number | undefined;
    if (activeTimer.isActive) {
      const startEpoch = new Date(activeTimer.startTime).getTime();
      const updateTimer = () => {
        const now = Date.now();
        const diffSec = Math.max(0, Math.floor((now - startEpoch) / 1000));
        setElapsedSeconds(diffSec);
      };
      updateTimer();
      interval = window.setInterval(updateTimer, 1000);
    } else {
      setElapsedSeconds(0);
    }
    return () => clearInterval(interval);
  }, [activeTimer.isActive, activeTimer.startTime]);

  // Calculate Today's Drilled Meters & Rates
  const todayStr = new Date().toISOString().split('T')[0];
  const todayPipes = pipeRecords.filter(
    (r) => r.startTime && r.startTime.startsWith(todayStr)
  );
  const todayMeters = todayPipes.reduce((sum, r) => sum + r.pipeLength, 0);

  const totalSecondsAll = pipeRecords.reduce(
    (sum, r) => sum + r.durationSeconds,
    0
  );
  const avgRateAll =
    totalSecondsAll > 0
      ? (
          activeBorehole.currentDepth /
          (totalSecondsAll / 3600)
        ).toFixed(1)
      : '0.0';

  // Productive vs NPT Time calculation
  const productiveHoursTotal = (totalSecondsAll / 3600).toFixed(1);
  const nptMinutesTotal = events
    .filter((e) => e.isNPT)
    .reduce((sum, e) => sum + (e.durationMinutes || 0), 0);
  const nptHoursTotal = (nptMinutesTotal / 60).toFixed(1);

  // Formatting helper
  const formatTimerDisplay = (totalSec: number) => {
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  };

  const handlePressStart = () => {
    playStartPipeSound(true);
    triggerVibration([60, 40, 80]);
    onStartPipe();
  };

  const handlePressEnd = () => {
    playAlertSound(true);
    triggerVibration([100, 50, 150]);
    onOpenEndPipeModal();
  };

  // Estimate completion date based on targetDepth & avg speed
  const remainingDepth = Math.max(
    0,
    activeBorehole.targetDepth - activeBorehole.currentDepth
  );
  const rateNum = Number(avgRateAll) || 6.0;
  const estDaysLeft = Math.ceil(remainingDepth / (rateNum * 8 || 48));
  const estCompletionDate = new Date(
    Date.now() + estDaysLeft * 24 * 3600 * 1000
  ).toLocaleDateString([], { month: 'short', day: 'numeric' });

  return (
    <div className="flex flex-col flex-1 max-w-7xl mx-auto w-full px-2 sm:px-4 py-2 sm:py-4 gap-3 sm:gap-4 select-none">
      {/* Main Grid container matching Technical Dashboard aesthetic */}
      <div className="flex flex-col lg:flex-row gap-3 sm:gap-4 flex-1">
        {/* Left Column (flex-[3]): Top Metrics, 2 Huge Buttons, Field Event Buttons */}
        <div className="flex-[3] flex flex-col gap-3 sm:gap-4">
          {/* Top 3 Metric Blocks */}
          {/* min-h, not h: on a 320-412px phone the labels wrap to two lines and
              the content needs 127-155px, so a locked 112px box clipped the
              "Target" line and let START PIPE overlap the cards. */}
          <div className="grid grid-cols-3 gap-2 sm:gap-4 min-h-28 sm:min-h-36">
            <div
              className={`border-2 p-2 sm:p-4 flex flex-col justify-center items-center rounded-lg shadow-sm transition-colors ${
                sunlightMode
                  ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                  : 'bg-white border-[#D1D1D1] text-[#1A1A1A]'
              }`}
            >
              <span className="text-[10px] sm:text-[12px] uppercase font-black tracking-wider opacity-70">
                Current Depth
              </span>
              <span className="text-2xl sm:text-5xl font-black mt-0.5 sm:mt-1 whitespace-nowrap">
                {activeBorehole.currentDepth.toFixed(2)}{' '}
                <span className="text-sm sm:text-xl font-extrabold">m</span>
              </span>
              <span className="text-[9px] sm:text-[10px] font-bold opacity-60 mt-1">
                Target: {activeBorehole.targetDepth}m
              </span>
            </div>

            <div
              className={`border-2 p-2 sm:p-4 flex flex-col justify-center items-center rounded-lg shadow-sm transition-colors ${
                sunlightMode
                  ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                  : 'bg-white border-[#D1D1D1] text-[#1A1A1A]'
              }`}
            >
              <span className="text-[10px] sm:text-[12px] uppercase font-black tracking-wider opacity-70">
                Today&apos;s Progress
              </span>
              <span className="text-2xl sm:text-5xl font-black mt-0.5 sm:mt-1 text-emerald-500 whitespace-nowrap">
                {todayMeters.toFixed(1)}{' '}
                <span className="text-sm sm:text-xl font-extrabold">m</span>
              </span>
              <span className="text-[9px] sm:text-[10px] font-bold opacity-60 mt-1">
                {todayPipes.length} pipes today
              </span>
            </div>

            <div
              className={`border-2 p-2 sm:p-4 flex flex-col justify-center items-center rounded-lg shadow-sm transition-colors ${
                sunlightMode
                  ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                  : 'bg-white border-[#D1D1D1] text-[#1A1A1A]'
              }`}
            >
              <span className="text-[10px] sm:text-[12px] uppercase font-black tracking-wider opacity-70">
                Drilling Rate
              </span>
              <span className="text-2xl sm:text-5xl font-black mt-0.5 sm:mt-1 text-blue-500 whitespace-nowrap">
                {avgRateAll}{' '}
                <span className="text-sm sm:text-xl font-extrabold">m/hr</span>
              </span>
              <span className="text-[9px] sm:text-[10px] font-bold opacity-60 mt-1">
                Avg across borehole
              </span>
            </div>
          </div>

          {/* TWO LARGE BUTTONS: START PIPE / END PIPE (Glove Friendly & Bright Sunlight Optimized) */}
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 w-full mt-1">
            {/* START PIPE Button */}
            <button
              onClick={handlePressStart}
              onPointerDown={() => {
                if (!activeTimer.isActive) triggerVibration([12]);
              }}
              disabled={activeTimer.isActive}
              className={`w-full sm:flex-1 touch-manipulation select-none min-h-[180px] sm:min-h-[220px] border-b-8 rounded-2xl flex flex-col items-center justify-center gap-2 sm:gap-4 p-4 active:border-b-0 active:translate-y-1 transition-colors duration-150 ${
                activeTimer.isActive
                  ? 'bg-zinc-300 border-zinc-400 text-zinc-500 cursor-not-allowed opacity-60'
                  : sunlightMode
                    ? 'bg-[#FFD700] hover:bg-[#e6c200] border-yellow-800 text-black shadow-2xl shadow-amber-900/40'
                    : 'bg-[#FFD700] hover:bg-[#e6c200] border-black/20 text-black shadow-xl'
              }`}
            >
              <span className="text-4xl sm:text-6xl md:text-7xl font-black tracking-tighter leading-none">
                START PIPE
              </span>
              <span className="bg-black text-white px-3 sm:px-4 py-1.5 sm:py-2 rounded-full font-extrabold uppercase text-xs sm:text-sm tracking-wider flex items-center gap-1.5">
                <Play className="w-4 h-4 fill-current text-[#FFD700]" />
                {activeTimer.isActive
                  ? 'TIMER ACTIVE...'
                  : `AUTO-TIMER READY (+${activeBorehole.defaultPipeLength}m)`}
              </span>
            </button>

            {/* END PIPE Button */}
            <button
              onClick={handlePressEnd}
              onPointerDown={() => {
                if (activeTimer.isActive) triggerVibration([12]);
              }}
              // Without a running timer there is no start time, so duration and
              // penetration rate would be recorded as NaN.
              disabled={!activeTimer.isActive}
              className={`w-full sm:flex-1 touch-manipulation select-none min-h-[180px] sm:min-h-[220px] border-b-8 rounded-2xl flex flex-col items-center justify-center gap-2 sm:gap-4 p-4 active:border-b-0 active:translate-y-1 transition-colors duration-150 ${
                !activeTimer.isActive
                  ? 'bg-zinc-300 border-zinc-400 text-zinc-500 cursor-not-allowed opacity-60'
                  : sunlightMode
                    ? 'bg-zinc-900 hover:bg-zinc-800 border-amber-400 text-amber-300 shadow-2xl shadow-amber-900/40'
                    : 'bg-[#1A1A1A] hover:bg-[#2a2a2a] border-black/40 text-white shadow-xl'
              }`}
            >
              <span
                className={`text-4xl sm:text-6xl md:text-7xl font-black tracking-tighter leading-none ${
                  activeTimer.isActive ? 'text-[#FFD700]' : 'text-zinc-500'
                }`}
              >
                END PIPE
              </span>
              <span
                className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-full font-extrabold uppercase text-xs sm:text-sm tracking-wider flex items-center gap-1.5 ${
                  activeTimer.isActive ? 'bg-white/20 text-white' : 'bg-black/10 text-zinc-600'
                }`}
              >
                <Square className="w-4 h-4 fill-current text-red-500" />
                {activeTimer.isActive
                  ? `RECORD PIPE #${activeTimer.pipeNumber}`
                  : 'START A PIPE FIRST'}
              </span>
            </button>
          </div>

          {/* Active Live Timer / Current Drill Pipe Banner (if drilling is active) */}
          {activeTimer.isActive && (
            <div
              className={`p-3 sm:p-4 rounded-xl border-2 flex flex-col sm:flex-row items-center justify-between gap-3 ${
                sunlightMode
                  ? 'bg-black border-[#FFD700] text-[#FFD700]'
                  : 'bg-emerald-950/80 border-emerald-500 text-emerald-200'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className="relative w-10 h-10 rounded-full bg-emerald-500 text-black font-black flex items-center justify-center text-lg shrink-0">
                  <Flame className="w-6 h-6" />
                  {/* A small live dot instead of the whole banner pulsing. The
                      thing that is actually moving is the elapsed timer; this
                      just marks the panel as live without swamping it. */}
                  <span className="absolute -top-0.5 -right-0.5 flex h-3 w-3">
                    <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-300 opacity-75" />
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-400 border border-black/40" />
                  </span>
                </div>
                <div>
                  <div className="font-black text-sm sm:text-base uppercase">
                    Drilling Pipe #{activeTimer.pipeNumber} in progress
                  </div>
                  <div className="text-xs opacity-90">
                    Started at: {new Date(activeTimer.startTime).toLocaleTimeString()} •{' '}
                    Strata: {activeTimer.formation}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-4">
                <div className="text-center">
                  <div className="text-[10px] uppercase font-bold opacity-75">
                    Elapsed Duration
                  </div>
                  <div className="text-2xl sm:text-3xl font-mono font-black text-[#FFD700]">
                    {formatTimerDisplay(elapsedSeconds)}
                  </div>
                </div>
                <button
                  onClick={onOpenEndPipeModal}
                  className="px-4 py-2.5 rounded-xl font-black text-xs uppercase bg-[#FFD700] text-black hover:bg-[#e6c200] shadow-lg"
                >
                  End & Save Now →
                </button>
                {/* Without this the only way out of a pipe started by mistake
                    was to save a bogus record, which corrupts the depth log. */}
                <button
                  onClick={onCancelPipe}
                  title="Stop this pipe without recording depth. It is logged as downtime."
                  className="px-3 py-2.5 rounded-xl font-black text-xs uppercase bg-transparent border border-white/40 text-white/90 hover:bg-white/10"
                >
                  Cancel Pipe
                </button>
              </div>
            </div>
          )}

          {/* ADDITIONAL BUTTONS GRID (Breakdown, Rod Connection, Bit Change, Refueling, Maintenance, Water Strike, Change Formation, Take Photo) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <button
              onClick={() => onOpenEventModal('Breakdown')}
              className={`border-2 font-bold text-xs sm:text-sm uppercase flex items-center justify-center p-2.5 rounded-lg transition-colors duration-150 active:scale-95 ${
                sunlightMode
                  ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700] hover:bg-red-950 hover:text-red-300'
                  : 'bg-white border-[#D1D1D1] text-[#1A1A1A] hover:bg-red-50 hover:border-red-500 hover:text-red-700'
              }`}
            >
              <AlertTriangle className="w-4 h-4 mr-1.5 text-red-500 shrink-0" />
              Breakdown
            </button>

            <button
              onClick={() => onOpenEventModal('Rod Connection')}
              className={`border-2 font-bold text-xs sm:text-sm uppercase flex items-center justify-center p-2.5 rounded-lg transition-colors duration-150 active:scale-95 ${
                sunlightMode
                  ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                  : 'bg-white border-[#D1D1D1] text-[#1A1A1A]'
              }`}
            >
              <Link2 className="w-4 h-4 mr-1.5 text-cyan-500 shrink-0" />
              Rod Conn.
            </button>

            <button
              onClick={() => onOpenEventModal('Bit Change')}
              className={`border-2 font-bold text-xs sm:text-sm uppercase flex items-center justify-center p-2.5 rounded-lg transition-colors duration-150 active:scale-95 ${
                sunlightMode
                  ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                  : 'bg-white border-[#D1D1D1] text-[#1A1A1A]'
              }`}
            >
              <Wrench className="w-4 h-4 mr-1.5 text-amber-500 shrink-0" />
              Bit Change
            </button>

            <button
              onClick={() => onOpenEventModal('Refueling')}
              className={`border-2 font-bold text-xs sm:text-sm uppercase flex items-center justify-center p-2.5 rounded-lg transition-colors duration-150 active:scale-95 ${
                sunlightMode
                  ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                  : 'bg-white border-[#D1D1D1] text-[#1A1A1A]'
              }`}
            >
              <Fuel className="w-4 h-4 mr-1.5 text-emerald-500 shrink-0" />
              Refueling
            </button>

            <button
              onClick={() => onOpenEventModal('Maintenance')}
              className={`border-2 font-bold text-xs sm:text-sm uppercase flex items-center justify-center p-2.5 rounded-lg transition-colors duration-150 active:scale-95 ${
                sunlightMode
                  ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                  : 'bg-white border-[#D1D1D1] text-[#1A1A1A]'
              }`}
            >
              <Wrench className="w-4 h-4 mr-1.5 text-purple-500 shrink-0" />
              Maintenance
            </button>

            <button
              onClick={() => onOpenEventModal('Water Strike')}
              className={`border-2 font-extrabold text-xs sm:text-sm uppercase flex items-center justify-center p-2.5 rounded-lg transition-colors duration-150 active:scale-95 ${
                sunlightMode
                  ? 'bg-cyan-950 border-cyan-400 text-cyan-300'
                  : 'bg-green-50 border-[#4ADE80] text-[#166534]'
              }`}
            >
              <Droplets className="w-4 h-4 mr-1.5 text-cyan-400 shrink-0" />
              Water Strike
            </button>

            <button
              onClick={() => onOpenEventModal('Change Formation')}
              className={`border-2 font-bold text-xs sm:text-sm uppercase flex items-center justify-center p-2.5 rounded-lg transition-colors duration-150 active:scale-95 ${
                sunlightMode
                  ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                  : 'bg-white border-[#D1D1D1] text-[#1A1A1A]'
              }`}
            >
              <Layers className="w-4 h-4 mr-1.5 text-blue-500 shrink-0" />
              Formation
            </button>

            <button
              onClick={() => onOpenEventModal('Take Photo')}
              className="bg-[#3B82F6] hover:bg-blue-600 text-white font-bold text-xs sm:text-sm uppercase flex items-center justify-center p-2.5 rounded-lg transition-colors duration-150 active:scale-95 shadow-md"
            >
              <Camera className="w-4 h-4 mr-1.5 shrink-0" />
              Take Photo
            </button>
          </div>
        </div>

        {/* Right Column (flex-1): Production Dashboard & Active Pipe Configuration */}
        <div className="flex-1 flex flex-col gap-3 sm:gap-4 min-w-[280px]">
          {/* Production Dashboard Card */}
          <div
            className={`flex-1 rounded-lg p-4 sm:p-5 flex flex-col justify-between shadow-md ${
              sunlightMode
                ? 'bg-black border-2 border-[#FFD700] text-[#FFD700]'
                : 'bg-[#1A1A1A] text-white'
            }`}
          >
            <div>
              <div className="flex justify-between items-center mb-4 sm:mb-6">
                <h2 className="font-black uppercase tracking-widest text-xs sm:text-sm text-[#FFD700]">
                  Production Dashboard
                </h2>
                <span className="text-[10px] opacity-60 font-bold">
                  UPDATED: {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>

              <div className="space-y-3">
                <div className="flex justify-between border-b border-white/10 pb-2">
                  <span className="text-xs opacity-60 font-bold">
                    TOTAL DEPTH
                  </span>
                  <span className="font-bold">
                    {activeBorehole.currentDepth.toFixed(2)} m
                  </span>
                </div>
                <div className="flex justify-between border-b border-white/10 pb-2">
                  <span className="text-xs opacity-60 font-bold">
                    AVG RATE
                  </span>
                  <span className="font-bold">{avgRateAll} m/hr</span>
                </div>
                <div className="flex justify-between border-b border-white/10 pb-2">
                  <span className="text-xs opacity-60 font-bold">
                    PROD. TIME
                  </span>
                  <span className="font-bold text-[#4ADE80]">
                    {productiveHoursTotal} hrs
                  </span>
                </div>
                <div className="flex justify-between border-b border-white/10 pb-2">
                  <span className="text-xs opacity-60 font-bold">
                    DOWNTIME
                  </span>
                  <span className="font-bold text-red-400">
                    {nptHoursTotal} hrs
                  </span>
                </div>
                <div className="flex justify-between border-b border-white/10 pb-2">
                  <span className="text-xs opacity-60 font-bold">
                    PRIMARY BIT
                  </span>
                  <span className="font-bold truncate max-w-[140px]">
                    {activeBorehole.bitType}
                  </span>
                </div>
                <div className="flex justify-between border-b border-white/10 pb-2">
                  <span className="text-xs opacity-60 font-bold">
                    EST. COMPLETION
                  </span>
                  <span className="font-bold text-[#FFD700]">
                    {estCompletionDate}
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-6 space-y-2">
              <button
                onClick={onGenerateShiftReport}
                className="w-full bg-white/10 hover:bg-white/20 text-xs font-black uppercase py-3 rounded tracking-widest transition-colors flex items-center justify-center gap-1.5"
              >
                <FileText className="w-4 h-4" /> Generate Shift Report (PDF)
              </button>
              <button
                onClick={onExportExcel}
                className="w-full bg-[#FFD700] hover:bg-[#e6c200] text-black text-xs font-black uppercase py-3 rounded tracking-widest transition-colors flex items-center justify-center gap-1.5"
              >
                <Download className="w-4 h-4" /> Export Borehole Log (XLS)
              </button>
            </div>
          </div>

          {/* Active Pipe Configuration Card */}
          <div
            className={`border-2 rounded-lg p-3 sm:p-4 flex flex-col justify-between ${
              sunlightMode
                ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                : 'bg-white border-[#D1D1D1] text-[#1A1A1A]'
            }`}
          >
            <span className="text-[10px] font-black uppercase opacity-60 mb-2">
              Active Pipe Configuration
            </span>
            <div className="flex items-end justify-between">
              <div className="flex flex-col">
                <span className="text-2xl sm:text-3xl font-black">
                  {activeBorehole.defaultPipeLength.toFixed(2)}
                  <span className="text-sm">m</span>
                </span>
                <span className="text-[10px] font-bold opacity-60">
                  DRILL PIPE LENGTH
                </span>
              </div>
              <button
                onClick={onOpenSettings}
                className={`p-2 rounded font-black text-[10px] uppercase border transition-colors flex items-center gap-1 ${
                  sunlightMode
                    ? 'bg-black text-[#FFD700] border-[#FFD700]'
                    : 'bg-gray-100 border-gray-300 text-[#1A1A1A] hover:bg-gray-200'
                }`}
              >
                <Settings className="w-3.5 h-3.5" /> Configure
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* FOOTER BAR: Matches Technical Dashboard / Data Grid footer */}
      <footer
        className={`h-10 px-3 sm:px-4 flex items-center justify-between text-[10px] font-bold uppercase rounded-lg border ${
          sunlightMode
            ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
            : 'bg-[#D1D1D1] text-[#666] border-[#D1D1D1]'
        }`}
      >
        <div className="truncate">
          Rig Hours: {activeBorehole.currentEngineHours.toFixed(1)} | Comp Hours:{' '}
          {activeBorehole.currentCompressorHours.toFixed(1)}
        </div>
        <div className="flex gap-2 sm:gap-4 shrink-0">
          <span className="hidden sm:inline">
            Bit: {activeBorehole.bitDiameter}&quot;
          </span>
          <span className="hidden md:inline">Op: {currentUser.name}</span>
          <span
            className={`font-black ${
              sunlightMode ? 'text-amber-300' : 'text-black'
            }`}
          >
            Strata:{' '}
            {pipeRecords.length > 0
              ? pipeRecords[pipeRecords.length - 1].formation
              : 'Topsoil'}
          </span>
        </div>
      </footer>
    </div>
  );
};
