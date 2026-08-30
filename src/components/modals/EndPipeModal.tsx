import React, { useEffect, useState } from 'react';
import {
  ActivePipeTimer,
  Borehole,
  PipeRecord,
  WaterStrikeDetails,
} from '../../types';
import { FORMATION_OPTIONS, BIT_TYPE_OPTIONS } from '../../services/storage';
import {
  X,
  CheckCircle2,
  Droplets,
  Clock,
  Gauge,
  Layers,
  Wrench,
  AlertTriangle,
} from 'lucide-react';
import { ModalShell } from '../../ui/ModalShell';

interface EndPipeModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeTimer: ActivePipeTimer;
  borehole: Borehole;
  onSavePipe: (record: Omit<PipeRecord, 'id'>) => void;
  sunlightMode: boolean;
}

export const EndPipeModal: React.FC<EndPipeModalProps> = ({
  isOpen,
  onClose,
  activeTimer,
  borehole,
  onSavePipe,
  sunlightMode,
}) => {
  const [formation, setFormation] = useState<string>(
    activeTimer.formation || 'Weathered Basalt'
  );
  const [waterStrike, setWaterStrike] = useState<boolean>(false);
  const [waterFlowRate, setWaterFlowRate] = useState<number>(120);
  const [staticWaterLevel, setStaticWaterLevel] = useState<number>(24.0);
  const [waterNotes, setWaterNotes] = useState<string>(
    'Aquifer strike encountered.'
  );
  const [airPressure, setAirPressure] = useState<number>(
    activeTimer.airPressure || 250
  );
  const [compressorPressure, setCompressorPressure] = useState<number>(
    activeTimer.compressorPressure || 220
  );
  const [bitType, setBitType] = useState<string>(
    activeTimer.bitType || borehole.bitType
  );
  const [bitDiameter, setBitDiameter] = useState<number>(
    activeTimer.bitDiameter || borehole.bitDiameter
  );
  const [remarks, setRemarks] = useState<string>(activeTimer.remarks || '');

  // This modal stays mounted between pipes, so the initialisers above only ever
  // run once. Re-seed the form each time it opens, otherwise the previous pipe's
  // remarks — and a stuck water-strike toggle — get saved onto the next pipe.
  useEffect(() => {
    if (!isOpen) return;
    setFormation(activeTimer.formation || 'Weathered Basalt');
    setWaterStrike(false);
    setWaterFlowRate(120);
    setStaticWaterLevel(24.0);
    setWaterNotes('Aquifer strike encountered.');
    setAirPressure(activeTimer.airPressure || 250);
    setCompressorPressure(activeTimer.compressorPressure || 220);
    setBitType(activeTimer.bitType || borehole.bitType);
    setBitDiameter(activeTimer.bitDiameter || borehole.bitDiameter);
    setRemarks(activeTimer.remarks || '');
  }, [isOpen, activeTimer.pipeNumber]);

  // Calculate automatic metrics
  const endTime = new Date().toISOString();
  const startEpoch = new Date(activeTimer.startTime).getTime();
  const endEpoch = new Date(endTime).getTime();
  const durationSeconds = Math.max(1, Math.round((endEpoch - startEpoch) / 1000));
  const durationHours = durationSeconds / 3600;
  const pipeLength = Number(
    activeTimer.pipeLength ?? borehole.defaultPipeLength ?? 4.55
  );
  const startDepth = Number(activeTimer.startDepth ?? 0);
  const penetrationRate =
    durationHours > 0 ? parseFloat((pipeLength / durationHours).toFixed(2)) : 0;
  const newEndDepth = parseFloat((startDepth + pipeLength).toFixed(2));

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${s}s`;
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const waterDetails: WaterStrikeDetails | undefined = waterStrike
      ? {
          depth: parseFloat(newEndDepth.toFixed(1)),
          flowRateLpm: Number(waterFlowRate),
          staticWaterLevel: Number(staticWaterLevel),
          notes: waterNotes,
        }
      : undefined;

    onSavePipe({
      boreholeId: borehole.id,
      pipeNumber: activeTimer.pipeNumber,
      startDepth,
      endDepth: newEndDepth,
      pipeLength,
      startTime: activeTimer.startTime,
      endTime,
      durationSeconds,
      penetrationRate,
      formation,
      waterStrike,
      waterStrikeDetails: waterDetails,
      airPressure: Number(airPressure),
      compressorPressure: Number(compressorPressure),
      bitType,
      bitDiameter: Number(bitDiameter),
      operator: activeTimer.operator,
      gpsCoordinates: borehole.gpsCoordinates,
      remarks:
        remarks ||
        `Completed Pipe #${activeTimer.pipeNumber} through ${formation} (${penetrationRate} m/hr)`,
      synced: false, // offline first!
    });
    onClose();
  };

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      sunlightMode={sunlightMode}
      maxWidth="max-w-2xl"
      zIndex={50}
      label="End pipe"
    >
      <div
        className={`w-full flex flex-col min-h-0 max-h-full rounded-2xl border shadow-2xl overflow-hidden transition-colors ${
          sunlightMode
            ? 'bg-zinc-950 border-amber-400 text-amber-300'
            : 'bg-slate-900 border-slate-700 text-white'
        }`}
      >
        {/* Header Banner */}
        <div
          className={`px-4 sm:px-6 py-4 border-b flex items-center justify-between ${
            sunlightMode
              ? 'bg-amber-400 text-black border-amber-500 font-black'
              : 'bg-gradient-to-r from-orange-600 to-amber-600 text-white'
          }`}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-black/20 flex items-center justify-center font-black text-lg">
              #{activeTimer.pipeNumber}
            </div>
            <div>
              <h2 className="text-lg sm:text-xl font-black leading-tight">
                END PIPE RECORDING
              </h2>
              <p className="text-xs opacity-90 font-bold">
                Confirm drilling telemetry & save to pipe log
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg bg-black/20 hover:bg-black/40 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSave} className="p-4 sm:p-6 space-y-5 flex-1 min-h-0 overflow-y-auto">
          {/* Automatic Telemetry Card */}
          <div
            className={`p-4 rounded-xl border grid grid-cols-2 sm:grid-cols-4 gap-3 text-center ${
              sunlightMode
                ? 'bg-zinc-900 border-amber-400/50'
                : 'bg-slate-800/80 border-slate-700'
            }`}
          >
            <div>
              <div className="text-xs opacity-75 font-bold uppercase tracking-wider">
                Start Depth
              </div>
              <div className="text-lg sm:text-xl font-black text-cyan-400">
                {activeTimer.startDepth.toFixed(2)} m
              </div>
            </div>
            <div>
              <div className="text-xs opacity-75 font-bold uppercase tracking-wider">
                End Depth
              </div>
              <div className="text-lg sm:text-xl font-black text-emerald-400">
                {newEndDepth.toFixed(2)} m
              </div>
            </div>
            <div>
              <div className="text-xs opacity-75 font-bold uppercase tracking-wider">
                Duration
              </div>
              <div className="text-lg sm:text-xl font-black text-amber-400">
                {formatDuration(durationSeconds)}
              </div>
            </div>
            <div>
              <div className="text-xs opacity-75 font-bold uppercase tracking-wider">
                Rate (m/hr)
              </div>
              <div className="text-lg sm:text-xl font-black text-purple-400">
                {penetrationRate.toFixed(1)} m/hr
              </div>
            </div>
          </div>

          {/* Geological Formation (Lithology) */}
          <div className="space-y-2">
            <label className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider">
              <Layers className="w-4 h-4 text-cyan-400" />
              Geological Formation / Lithology
            </label>
            <select
              value={formation}
              onChange={(e) => setFormation(e.target.value)}
              className={`w-full p-3 rounded-xl border font-bold text-sm sm:text-base ${
                sunlightMode
                  ? 'bg-zinc-900 border-amber-400 text-amber-300'
                  : 'bg-slate-800 border-slate-600 text-white'
              }`}
            >
              {FORMATION_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>

          {/* Water Strike Section */}
          <div
            className={`p-4 rounded-xl border transition-colors ${
              waterStrike
                ? sunlightMode
                  ? 'bg-blue-950/60 border-cyan-400'
                  : 'bg-blue-900/30 border-blue-500'
                : sunlightMode
                  ? 'bg-zinc-900/60 border-amber-400/40'
                  : 'bg-slate-800/40 border-slate-700'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Droplets
                  className={`w-5 h-5 ${
                    waterStrike ? 'text-cyan-400' : 'opacity-60'
                  }`}
                />
                <div>
                  <div className="font-black text-sm uppercase">
                    Water Strike Encountered?
                  </div>
                  <div className="text-xs opacity-75">
                    Toggle if groundwater was struck during this pipe
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setWaterStrike(!waterStrike)}
                className={`px-4 py-2 rounded-xl font-black text-xs tracking-wider uppercase transition-colors duration-150 active:scale-95 ${
                  waterStrike
                    ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/30'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                {waterStrike ? 'YES - STRIKE RECORDED' : 'NO'}
              </button>
            </div>

            {waterStrike && (
              <div className="mt-4 pt-4 border-t border-cyan-500/40 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold uppercase mb-1">
                    Est. Flow Rate (L/min)
                  </label>
                  <input
                    type="number"
                    value={waterFlowRate}
                    onChange={(e) => setWaterFlowRate(Number(e.target.value))}
                    className={`w-full p-2.5 rounded-lg border font-bold ${
                      sunlightMode
                        ? 'bg-zinc-900 border-amber-400 text-amber-300'
                        : 'bg-slate-800 border-slate-600 text-white'
                    }`}
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase mb-1">
                    Static Water Level (m)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={staticWaterLevel}
                    onChange={(e) => setStaticWaterLevel(Number(e.target.value))}
                    className={`w-full p-2.5 rounded-lg border font-bold ${
                      sunlightMode
                        ? 'bg-zinc-900 border-amber-400 text-amber-300'
                        : 'bg-slate-800 border-slate-600 text-white'
                    }`}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Air & Compressor Pressures */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="flex items-center gap-1.5 text-xs font-bold uppercase mb-1">
                <Gauge className="w-4 h-4 text-amber-400" /> Air Pressure (PSI)
              </label>
              <input
                type="number"
                value={airPressure}
                onChange={(e) => setAirPressure(Number(e.target.value))}
                className={`w-full p-2.5 rounded-xl border font-bold ${
                  sunlightMode
                    ? 'bg-zinc-900 border-amber-400 text-amber-300'
                    : 'bg-slate-800 border-slate-600 text-white'
                }`}
              />
            </div>
            <div>
              <label className="flex items-center gap-1.5 text-xs font-bold uppercase mb-1">
                <Gauge className="w-4 h-4 text-orange-400" /> Compressor Pressure (PSI)
              </label>
              <input
                type="number"
                value={compressorPressure}
                onChange={(e) => setCompressorPressure(Number(e.target.value))}
                className={`w-full p-2.5 rounded-xl border font-bold ${
                  sunlightMode
                    ? 'bg-zinc-900 border-amber-400 text-amber-300'
                    : 'bg-slate-800 border-slate-600 text-white'
                }`}
              />
            </div>
          </div>

          {/* Bit specs & Remarks */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="flex items-center gap-1 text-xs font-bold uppercase mb-1">
                <Wrench className="w-4 h-4 text-cyan-400" /> Bit Type
              </label>
              <select
                value={bitType}
                onChange={(e) => setBitType(e.target.value)}
                className={`w-full p-2.5 rounded-xl border font-bold ${
                  sunlightMode
                    ? 'bg-zinc-900 border-amber-400 text-amber-300'
                    : 'bg-slate-800 border-slate-600 text-white'
                }`}
              >
                {BIT_TYPE_OPTIONS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="flex items-center gap-1 text-xs font-bold uppercase mb-1">
                Remarks / Driller Notes
              </label>
              <input
                type="text"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="e.g. Hard Quartzite band, smooth rotation..."
                className={`w-full p-2.5 rounded-xl border font-bold ${
                  sunlightMode
                    ? 'bg-zinc-900 border-amber-400 text-amber-300 placeholder-amber-500/50'
                    : 'bg-slate-800 border-slate-600 text-white placeholder-slate-400'
                }`}
              />
            </div>
          </div>

          {/* Action Buttons */}
          <div className="pt-2 flex flex-col sm:flex-row gap-3">
            <button
              type="submit"
              className={`flex-1 py-4 px-6 rounded-2xl font-black text-base sm:text-lg uppercase tracking-wider flex items-center justify-center gap-2 shadow-lg active:scale-95 ${
                sunlightMode
                  ? 'bg-amber-400 text-black hover:bg-amber-300 shadow-amber-900/40'
                  : 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:from-emerald-500 hover:to-teal-500 shadow-emerald-900/30'
              }`}
            >
              <CheckCircle2 className="w-6 h-6" />
              SAVE PIPE RECORD
            </button>
            <button
              type="button"
              onClick={onClose}
              className="py-4 px-6 rounded-2xl font-bold text-sm bg-slate-800 border border-slate-600 hover:bg-slate-700"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </ModalShell>
  );
};
