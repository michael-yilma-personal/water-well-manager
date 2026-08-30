import React, { useState } from 'react';
import { Borehole } from '../../types';
import {
  BIT_TYPE_OPTIONS,
  BIT_DIAMETER_OPTIONS,
  createRecordId,
} from '../../services/storage';
import { X, Plus, MapPin, Compass, Wrench, Building2 } from 'lucide-react';
import { ModalShell } from '../../ui/ModalShell';

interface NewBoreholeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (borehole: Borehole) => void;
  sunlightMode: boolean;
}

export const NewBoreholeModal: React.FC<NewBoreholeModalProps> = ({
  isOpen,
  onClose,
  onSave,
  sunlightMode,
}) => {
  const [name, setName] = useState('');
  const [project, setProject] = useState('');
  const [client, setClient] = useState('');
  const [rigName, setRigName] = useState('Rig #4 - Schramm T685WS');
  const [targetDepth, setTargetDepth] = useState(160);
  const [defaultPipeLength, setDefaultPipeLength] = useState(4.55);
  const [bitDiameter, setBitDiameter] = useState(8.5);
  const [bitType, setBitType] = useState(BIT_TYPE_OPTIONS[0]);
  const [lat, setLat] = useState(-1.3142);
  const [lng, setLng] = useState(36.7845);
  const [elevation, setElevation] = useState(1680);
  const [engineHoursStart, setEngineHoursStart] = useState(4120.0);
  const [compressorHoursStart, setCompressorHoursStart] = useState(3080.0);

  const handleGetLocation = () => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setLat(parseFloat(pos.coords.latitude.toFixed(5)));
          setLng(parseFloat(pos.coords.longitude.toFixed(5)));
          if (pos.coords.altitude) {
            setElevation(Math.round(pos.coords.altitude));
          }
        },
        () => {
          // Keep defaults if failed
        }
      );
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !project) return;

    const newBh: Borehole = {
      // Must be a real UUID: the server's primary key is a uuid column, so a
      // timestamp-shaped id is rejected outright and the borehole - along with
      // every pipe record referencing it - can never sync.
      id: createRecordId('bh'),
      name,
      project,
      client: client || 'Private Water Well',
      rigName,
      targetDepth: Number(targetDepth),
      currentDepth: 0,
      defaultPipeLength: Number(defaultPipeLength),
      bitDiameter: Number(bitDiameter),
      bitType,
      gpsCoordinates: {
        lat: Number(lat),
        lng: Number(lng),
        elevation: Number(elevation),
      },
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      engineHoursStart: Number(engineHoursStart),
      compressorHoursStart: Number(compressorHoursStart),
      currentEngineHours: Number(engineHoursStart),
      currentCompressorHours: Number(compressorHoursStart),
      casingInstalledDepth: 0,
    };

    onSave(newBh);
    onClose();
  };

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      sunlightMode={sunlightMode}
      maxWidth="max-w-2xl"
      zIndex={50}
      label="New borehole"
    >
      <div
        className={`w-full flex flex-col min-h-0 max-h-full rounded-xl border-2 shadow-2xl overflow-hidden ${
          sunlightMode
            ? 'bg-zinc-950 border-[#FFD700] text-[#FFD700]'
            : 'bg-[#1A1A1A] border-[#D1D1D1]/40 text-white'
        }`}
      >
        {/* Header */}
        <div
          className={`px-4 sm:px-6 py-4 border-b-2 flex items-center justify-between ${
            sunlightMode
              ? 'bg-[#FFD700] text-black border-black'
              : 'bg-black text-white border-[#FFD700]/50'
          }`}
        >
          <div className="flex items-center gap-3">
            <div
              className={`p-2 rounded font-black text-sm ${
                sunlightMode
                  ? 'bg-black text-[#FFD700]'
                  : 'bg-[#FFD700] text-black'
              }`}
            >
              NEW WELL
            </div>
            <div>
              <h2 className="text-lg sm:text-xl font-black tracking-tight">
                REGISTER NEW BOREHOLE
              </h2>
              <p className="text-xs opacity-80 font-bold uppercase">
                Initialize Rig & Lithology Logging Site
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded hover:bg-white/10 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-4 sm:p-6 space-y-4 flex-1 min-h-0 overflow-y-auto">
          {/* Project & Client */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-black uppercase mb-1 opacity-80">
                Borehole ID / Number *
              </label>
              <input
                type="text"
                required
                placeholder="e.g. BH-2026-08 (Kajiado Well)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={`w-full p-3 rounded border-2 font-bold ${
                  sunlightMode
                    ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                    : 'bg-zinc-900 border-zinc-700 text-white'
                }`}
              />
            </div>
            <div>
              <label className="block text-xs font-black uppercase mb-1 opacity-80">
                Project Name *
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Rift Valley Water Project"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                className={`w-full p-3 rounded border-2 font-bold ${
                  sunlightMode
                    ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                    : 'bg-zinc-900 border-zinc-700 text-white'
                }`}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-black uppercase mb-1 opacity-80">
                Client / Community
              </label>
              <input
                type="text"
                placeholder="e.g. Nairobi Water Authority"
                value={client}
                onChange={(e) => setClient(e.target.value)}
                className={`w-full p-3 rounded border-2 font-bold ${
                  sunlightMode
                    ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                    : 'bg-zinc-900 border-zinc-700 text-white'
                }`}
              />
            </div>
            <div>
              <label className="block text-xs font-black uppercase mb-1 opacity-80">
                Drilling Rig Unit
              </label>
              <input
                type="text"
                value={rigName}
                onChange={(e) => setRigName(e.target.value)}
                className={`w-full p-3 rounded border-2 font-bold ${
                  sunlightMode
                    ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                    : 'bg-zinc-900 border-zinc-700 text-white'
                }`}
              />
            </div>
          </div>

          {/* Targets & Pipe Length */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-black uppercase mb-1 opacity-80">
                Target Depth (m)
              </label>
              <input
                type="number"
                value={targetDepth}
                onChange={(e) => setTargetDepth(Number(e.target.value))}
                className={`w-full p-3 rounded border-2 font-black text-lg ${
                  sunlightMode
                    ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                    : 'bg-zinc-900 border-zinc-700 text-white'
                }`}
              />
            </div>
            <div>
              <label className="block text-xs font-black uppercase mb-1 opacity-80">
                Pipe Length (m)
              </label>
              <input
                type="number"
                step="0.05"
                value={defaultPipeLength}
                onChange={(e) => setDefaultPipeLength(Number(e.target.value))}
                className={`w-full p-3 rounded border-2 font-black text-lg text-emerald-400 ${
                  sunlightMode
                    ? 'bg-zinc-900 border-[#FFD700]'
                    : 'bg-zinc-900 border-zinc-700'
                }`}
              />
            </div>
            <div>
              <label className="block text-xs font-black uppercase mb-1 opacity-80">
                Bit Diameter (in)
              </label>
              <select
                value={bitDiameter}
                onChange={(e) => setBitDiameter(Number(e.target.value))}
                className={`w-full p-3 rounded border-2 font-black text-base ${
                  sunlightMode
                    ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                    : 'bg-zinc-900 border-zinc-700 text-white'
                }`}
              >
                {BIT_DIAMETER_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}"
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Initial Bit Type */}
          <div>
            <label className="block text-xs font-black uppercase mb-1 opacity-80">
              Primary Drill Bit Type
            </label>
            <select
              value={bitType}
              onChange={(e) => setBitType(e.target.value)}
              className={`w-full p-3 rounded border-2 font-bold ${
                sunlightMode
                  ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                  : 'bg-zinc-900 border-zinc-700 text-white'
              }`}
            >
              {BIT_TYPE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>

          {/* GPS Coordinates */}
          <div className="p-3 rounded border-2 border-zinc-700 bg-zinc-900/50 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-black uppercase tracking-wider text-cyan-400 flex items-center gap-1">
                <MapPin className="w-4 h-4" /> GPS Field Coordinates
              </span>
              <button
                type="button"
                onClick={handleGetLocation}
                className="px-2.5 py-1 rounded bg-[#FFD700] text-black font-black text-xs uppercase hover:bg-[#e6c200]"
              >
                Auto-Detect GPS
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[10px] uppercase font-bold text-gray-400">
                  Latitude
                </label>
                <input
                  type="number"
                  step="0.00001"
                  value={lat}
                  onChange={(e) => setLat(Number(e.target.value))}
                  className="w-full p-2 rounded bg-black border border-zinc-700 text-white font-mono text-sm"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase font-bold text-gray-400">
                  Longitude
                </label>
                <input
                  type="number"
                  step="0.00001"
                  value={lng}
                  onChange={(e) => setLng(Number(e.target.value))}
                  className="w-full p-2 rounded bg-black border border-zinc-700 text-white font-mono text-sm"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase font-bold text-gray-400">
                  Elevation (m ASL)
                </label>
                <input
                  type="number"
                  value={elevation}
                  onChange={(e) => setElevation(Number(e.target.value))}
                  className="w-full p-2 rounded bg-black border border-zinc-700 text-white font-mono text-sm"
                />
              </div>
            </div>
          </div>

          {/* Rig Hours Initial */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-black uppercase mb-1 opacity-80">
                Rig Engine Hours Start
              </label>
              <input
                type="number"
                step="0.1"
                value={engineHoursStart}
                onChange={(e) => setEngineHoursStart(Number(e.target.value))}
                className={`w-full p-2.5 rounded border-2 font-bold ${
                  sunlightMode
                    ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                    : 'bg-zinc-900 border-zinc-700 text-white'
                }`}
              />
            </div>
            <div>
              <label className="block text-xs font-black uppercase mb-1 opacity-80">
                Compressor Hours Start
              </label>
              <input
                type="number"
                step="0.1"
                value={compressorHoursStart}
                onChange={(e) =>
                  setCompressorHoursStart(Number(e.target.value))
                }
                className={`w-full p-2.5 rounded border-2 font-bold ${
                  sunlightMode
                    ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                    : 'bg-zinc-900 border-zinc-700 text-white'
                }`}
              />
            </div>
          </div>

          {/* Action buttons */}
          <div className="pt-2 flex flex-col sm:flex-row gap-3">
            <button
              type="submit"
              className={`flex-1 py-3 px-6 rounded font-black text-base uppercase tracking-wider shadow-lg active:scale-95 border-b-4 ${
                sunlightMode
                  ? 'bg-[#FFD700] text-black border-black hover:bg-[#e6c200]'
                  : 'bg-[#FFD700] text-black border-yellow-700 hover:bg-[#e6c200]'
              }`}
            >
              CREATE BOREHOLE SITE
            </button>
            <button
              type="button"
              onClick={onClose}
              className="py-3 px-6 rounded font-bold text-sm bg-zinc-800 border-2 border-zinc-700 hover:bg-zinc-700"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </ModalShell>
  );
};
