import React, { useState } from 'react';
import {
  Borehole,
  DrillingEvent,
  EventType,
} from '../../types';
import {
  FORMATION_OPTIONS,
  BIT_TYPE_OPTIONS,
  BIT_DIAMETER_OPTIONS,
} from '../../services/storage';
import { preparePhoto } from '../../services/photos';
import { queuePhotoUpload } from '../../services/photoQueue';
import {
  X,
  CheckCircle2,
  AlertTriangle,
  Wrench,
  Droplets,
  Fuel,
  Camera,
  Layers,
  Link2,
  Clock,
  MapPin,
} from 'lucide-react';

interface EventModalProps {
  isOpen: boolean;
  onClose: () => void;
  eventType: EventType | null;
  borehole: Borehole;
  operator: string;
  onSaveEvent: (event: Omit<DrillingEvent, 'id'>) => void;
  sunlightMode: boolean;
}

export const EventModal: React.FC<EventModalProps> = ({
  isOpen,
  onClose,
  eventType,
  borehole,
  operator,
  onSaveEvent,
  sunlightMode,
}) => {
  const [title, setTitle] = useState<string>('');
  const [durationMinutes, setDurationMinutes] = useState<number>(30);
  const [notes, setNotes] = useState<string>('');
  const [fuelLiters, setFuelLiters] = useState<number>(200);
  const [fuelCost, setFuelCost] = useState<number>(32000);
  const [engineHours, setEngineHours] = useState<number>(
    borehole.currentEngineHours
  );
  const [compressorHours, setCompressorHours] = useState<number>(
    borehole.currentCompressorHours
  );
  const [newBitType, setNewBitType] = useState<string>(
    borehole.bitType || BIT_TYPE_OPTIONS[0]
  );
  const [newBitDiameter, setNewBitDiameter] = useState<number>(
    borehole.bitDiameter || 8.5
  );
  const [newFormation, setNewFormation] = useState<string>(
    FORMATION_OPTIONS[0]
  );
  const [waterStrikeLpm, setWaterStrikeLpm] = useState<number>(180);
  const [staticWaterLevel, setStaticWaterLevel] = useState<number>(22.0);
  // previewUrl is a small data URL for display only. The record stores the
  // photo's filename; the bytes live on the filesystem and upload separately.
  const [photoUrl, setPhotoUrl] = useState<string | undefined>(undefined);
  const [photoPreview, setPhotoPreview] = useState<string | undefined>(undefined);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  // This modal stays mounted between opens, so reset every field each time it
  // opens — not just when the event type changes. Otherwise the previous event's
  // notes and photo are silently saved onto the next event of the same type.
  React.useEffect(() => {
    if (!isOpen || !eventType) return;

    setNotes('');
    setPhotoUrl(undefined);
    setFuelLiters(200);
    setFuelCost(32000);
    setEngineHours(borehole.currentEngineHours);
    setCompressorHours(borehole.currentCompressorHours);
    setNewBitType(borehole.bitType || BIT_TYPE_OPTIONS[0]);
    setNewBitDiameter(borehole.bitDiameter || 8.5);
    setNewFormation(FORMATION_OPTIONS[0]);
    setWaterStrikeLpm(180);
    setStaticWaterLevel(22.0);

    if (eventType) {
      switch (eventType) {
        case 'Breakdown':
          setTitle('Hydraulic / Rig Breakdown');
          setDurationMinutes(45);
          break;
        case 'Rod Connection':
          setTitle('Add drill rod / Pipe Connection');
          setDurationMinutes(8);
          break;
        case 'Bit Change':
          setTitle('Changed Drill Bit');
          setDurationMinutes(40);
          break;
        case 'Refueling':
          setTitle('Rig Diesel Refueling');
          setDurationMinutes(25);
          break;
        case 'Maintenance':
          setTitle('Preventative Rig Maintenance');
          setDurationMinutes(30);
          break;
        case 'Water Strike':
          setTitle('Groundwater Aquifer Strike');
          setDurationMinutes(15);
          break;
        case 'Change Formation':
          setTitle('Geological Strata Change');
          setDurationMinutes(5);
          break;
        case 'Take Photo':
          setTitle('Field Site / Lithology Sample Photo');
          setDurationMinutes(5);
          break;
        default:
          setTitle(eventType);
      }
    }
  }, [isOpen, eventType, borehole.id]);

  if (!isOpen || !eventType) return null;

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      // Downscale and write to the filesystem rather than holding a base64
      // copy in the record: a single 3MB photo would otherwise consume most of
      // the ~5MB localStorage quota and take the rest of the log down with it.
      const prepared = await preparePhoto(file);
      setPhotoUrl(prepared.fileName);
      setPhotoPreview(prepared.previewUrl);
      queuePhotoUpload(prepared);
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : String(err));
    } finally {
      setPhotoBusy(false);
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();

    const isNPT =
      eventType === 'Breakdown' ||
      eventType === 'Bit Change' ||
      eventType === 'Refueling' ||
      eventType === 'Maintenance';

    onSaveEvent({
      boreholeId: borehole.id,
      type: eventType,
      title: title || eventType,
      timestamp: new Date().toISOString(),
      durationMinutes: Number(durationMinutes),
      isNPT,
      operator,
      depthAtEvent: borehole.currentDepth,
      details: {
        fuelLiters: eventType === 'Refueling' ? Number(fuelLiters) : undefined,
        fuelCost: eventType === 'Refueling' ? Number(fuelCost) : undefined,
        engineHours:
          eventType === 'Refueling' ? Number(engineHours) : undefined,
        compressorHours:
          eventType === 'Refueling' ? Number(compressorHours) : undefined,
        newBitType: eventType === 'Bit Change' ? newBitType : undefined,
        newBitDiameter:
          eventType === 'Bit Change' ? Number(newBitDiameter) : undefined,
        newFormation:
          eventType === 'Change Formation' ? newFormation : undefined,
        waterStrikeLpm:
          eventType === 'Water Strike' ? Number(waterStrikeLpm) : undefined,
        waterStrikeDepth:
          eventType === 'Water Strike' ? borehole.currentDepth : undefined,
        staticWaterLevel:
          eventType === 'Water Strike' ? Number(staticWaterLevel) : undefined,
        photoUrl,
        notes,
      },
      synced: false,
    });
    onClose();
  };

  const getEventIcon = () => {
    switch (eventType) {
      case 'Breakdown':
        return <AlertTriangle className="w-6 h-6 text-red-400" />;
      case 'Rod Connection':
        return <Link2 className="w-6 h-6 text-cyan-400" />;
      case 'Bit Change':
        return <Wrench className="w-6 h-6 text-amber-400" />;
      case 'Refueling':
        return <Fuel className="w-6 h-6 text-emerald-400" />;
      case 'Maintenance':
        return <Wrench className="w-6 h-6 text-purple-400" />;
      case 'Water Strike':
        return <Droplets className="w-6 h-6 text-cyan-400 animate-bounce" />;
      case 'Change Formation':
        return <Layers className="w-6 h-6 text-blue-400" />;
      case 'Take Photo':
        return <Camera className="w-6 h-6 text-amber-400" />;
      default:
        return <Clock className="w-6 h-6 text-white" />;
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
      <div
        className={`w-full max-w-xl rounded-2xl border shadow-2xl overflow-hidden transition-colors ${
          sunlightMode
            ? 'bg-zinc-950 border-amber-400 text-amber-300'
            : 'bg-slate-900 border-slate-700 text-white'
        }`}
      >
        {/* Header */}
        <div
          className={`px-4 sm:px-6 py-4 border-b flex items-center justify-between ${
            sunlightMode
              ? 'bg-amber-400 text-black border-amber-500 font-black'
              : 'bg-slate-800 border-slate-700 text-white'
          }`}
        >
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-black/20">{getEventIcon()}</div>
            <div>
              <h2 className="text-lg sm:text-xl font-black leading-tight uppercase">
                {eventType} OPERATION
              </h2>
              <p className="text-xs opacity-80 font-bold">
                Logged at Depth: {borehole.currentDepth.toFixed(2)} m
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg bg-black/20 hover:bg-black/40"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSave} className="p-4 sm:p-6 space-y-4 max-h-[80vh] overflow-y-auto">
          {/* Common Event Title & Duration */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-bold uppercase mb-1">
                Event Title / Description
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className={`w-full p-3 rounded-xl border font-bold ${
                  sunlightMode
                    ? 'bg-zinc-900 border-amber-400 text-amber-300'
                    : 'bg-slate-800 border-slate-600 text-white'
                }`}
              />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase mb-1">
                Est. Duration (min)
              </label>
              <input
                type="number"
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Number(e.target.value))}
                className={`w-full p-3 rounded-xl border font-bold ${
                  sunlightMode
                    ? 'bg-zinc-900 border-amber-400 text-amber-300'
                    : 'bg-slate-800 border-slate-600 text-white'
                }`}
              />
            </div>
          </div>

          {/* Special Field: REFUELING */}
          {eventType === 'Refueling' && (
            <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-950/20 space-y-3">
              <div className="font-black text-sm uppercase text-emerald-400 flex items-center gap-1.5">
                <Fuel className="w-4 h-4" /> Refueling Telemetry
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold uppercase mb-1">
                    Diesel Added (Liters)
                  </label>
                  <input
                    type="number"
                    value={fuelLiters}
                    onChange={(e) => setFuelLiters(Number(e.target.value))}
                    className="w-full p-2.5 rounded-lg border bg-slate-800 border-slate-600 text-white font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase mb-1">
                    Total Cost (KES/USD)
                  </label>
                  <input
                    type="number"
                    value={fuelCost}
                    onChange={(e) => setFuelCost(Number(e.target.value))}
                    className="w-full p-2.5 rounded-lg border bg-slate-800 border-slate-600 text-white font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase mb-1">
                    Rig Engine Hours
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={engineHours}
                    onChange={(e) => setEngineHours(Number(e.target.value))}
                    className="w-full p-2.5 rounded-lg border bg-slate-800 border-slate-600 text-white font-bold"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase mb-1">
                    Compressor Hours
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={compressorHours}
                    onChange={(e) => setCompressorHours(Number(e.target.value))}
                    className="w-full p-2.5 rounded-lg border bg-slate-800 border-slate-600 text-white font-bold"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Special Field: BIT CHANGE */}
          {eventType === 'Bit Change' && (
            <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-950/20 space-y-3">
              <div className="font-black text-sm uppercase text-amber-400 flex items-center gap-1.5">
                <Wrench className="w-4 h-4" /> Drill Bit Replacement
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold uppercase mb-1">
                    New Bit Type
                  </label>
                  <select
                    value={newBitType}
                    onChange={(e) => setNewBitType(e.target.value)}
                    className="w-full p-2.5 rounded-lg border bg-slate-800 border-slate-600 text-white font-bold"
                  >
                    {BIT_TYPE_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase mb-1">
                    Bit Diameter (Inches)
                  </label>
                  <select
                    value={newBitDiameter}
                    onChange={(e) => setNewBitDiameter(Number(e.target.value))}
                    className="w-full p-2.5 rounded-lg border bg-slate-800 border-slate-600 text-white font-bold"
                  >
                    {BIT_DIAMETER_OPTIONS.map((d) => (
                      <option key={d} value={d}>
                        {d}"
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Special Field: WATER STRIKE */}
          {eventType === 'Water Strike' && (
            <div className="p-4 rounded-xl border border-cyan-500/40 bg-cyan-950/20 space-y-3">
              <div className="font-black text-sm uppercase text-cyan-400 flex items-center gap-1.5">
                <Droplets className="w-4 h-4 animate-bounce" /> Aquifer Struck Details
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold uppercase mb-1">
                    Est. Discharge (L/min)
                  </label>
                  <input
                    type="number"
                    value={waterStrikeLpm}
                    onChange={(e) => setWaterStrikeLpm(Number(e.target.value))}
                    className="w-full p-2.5 rounded-lg border bg-slate-800 border-slate-600 text-white font-bold"
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
                    className="w-full p-2.5 rounded-lg border bg-slate-800 border-slate-600 text-white font-bold"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Special Field: CHANGE FORMATION */}
          {eventType === 'Change Formation' && (
            <div className="p-4 rounded-xl border border-blue-500/30 bg-blue-950/20 space-y-3">
              <div className="font-black text-sm uppercase text-blue-400 flex items-center gap-1.5">
                <Layers className="w-4 h-4" /> New Geological Strata
              </div>
              <select
                value={newFormation}
                onChange={(e) => setNewFormation(e.target.value)}
                className="w-full p-3 rounded-xl border bg-slate-800 border-slate-600 text-white font-bold"
              >
                {FORMATION_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Special Field: TAKE PHOTO / ATTACH IMAGE */}
          <div className="p-4 rounded-xl border border-slate-700 space-y-3">
            <label className="flex items-center gap-1.5 text-xs font-bold uppercase">
              <Camera className="w-4 h-4 text-amber-400" />
              Attach Site Photo / Lithology Sample
            </label>
            <div className="flex items-center gap-3">
              <label className="cursor-pointer py-2 px-4 rounded-lg bg-slate-800 border border-slate-600 hover:bg-slate-700 font-bold text-xs">
                Upload / Capture Photo
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handlePhotoUpload}
                  className="hidden"
                />
              </label>
              {photoPreview && (
                <span className="text-xs text-emerald-400 font-bold">
                  ✓ Photo Attached
                </span>
              )}
            </div>
            {photoPreview && (
              <div className="relative mt-2 rounded-lg overflow-hidden border border-slate-700 max-h-48">
                <img
                  src={photoPreview}
                  alt="Site sample"
                  className="w-full h-full object-cover"
                />
                <div className="absolute bottom-0 inset-x-0 bg-black/70 p-1.5 text-[10px] text-white font-mono flex justify-between">
                  <span>Depth: {borehole.currentDepth}m</span>
                  <span>{new Date().toLocaleTimeString()}</span>
                </div>
              </div>
            )}
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs font-bold uppercase mb-1">
              Remarks / Operational Notes
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Enter additional details..."
              className={`w-full p-3 rounded-xl border font-bold text-sm ${
                sunlightMode
                  ? 'bg-zinc-900 border-amber-400 text-amber-300'
                  : 'bg-slate-800 border-slate-600 text-white'
              }`}
            />
          </div>

          {/* Submit Buttons */}
          <div className="pt-2 flex flex-col sm:flex-row gap-3">
            <button
              type="submit"
              className={`flex-1 py-4 px-6 rounded-2xl font-black text-base uppercase tracking-wider flex items-center justify-center gap-2 shadow-lg transition-transform active:scale-95 ${
                sunlightMode
                  ? 'bg-amber-400 text-black hover:bg-amber-300'
                  : 'bg-cyan-500 text-black hover:bg-cyan-400 font-black'
              }`}
            >
              <CheckCircle2 className="w-5 h-5" />
              SAVE FIELD EVENT
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
    </div>
  );
};
