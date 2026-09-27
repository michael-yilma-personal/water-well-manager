import React, { useEffect, useState } from 'react';
import { Droplets, Gauge, Layers, Pencil, Trash2, Wrench, X } from 'lucide-react';
import type { PipeRecord } from '../../types';
import { BIT_TYPE_OPTIONS, FORMATION_OPTIONS } from '../../services/storage';
import { correctionOf, type PipeCorrection } from '../../services/pipeCorrection';
import { ModalShell } from '../../ui/ModalShell';

interface EditPipeModalProps {
  isOpen: boolean;
  onClose: () => void;
  record: PipeRecord | null;
  /** May be async (the dashboard saves to the server); a rejection is shown. */
  onSave: (correction: PipeCorrection) => void | Promise<void>;
  /** Only the author may delete; the office's copy of this sheet omits it. */
  onDelete?: (record: PipeRecord) => void;
  sunlightMode: boolean;
}

/** Keep a value that is not in the list selectable, rather than silently swapping it. */
function withCurrent(options: readonly string[], current: string): string[] {
  return current && !options.includes(current) ? [current, ...options] : [...options];
}

/**
 * Correct a saved pipe record: the fields from the End Pipe sheet. Depth and
 * time are shown for context but cannot be changed here - they are measured,
 * and they back the client's invoice.
 */
export const EditPipeModal: React.FC<EditPipeModalProps> = ({
  isOpen,
  onClose,
  record,
  onSave,
  onDelete,
  sunlightMode,
}) => {
  const [draft, setDraft] = useState<PipeCorrection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !record) return;
    setDraft(correctionOf(record));
    setError(null);
    setBusy(false);
  }, [isOpen, record?.id]);

  if (!record || !draft) {
    return <ModalShell isOpen={false} onClose={onClose} sunlightMode={sunlightMode}>{null}</ModalShell>;
  }

  const set = <K extends keyof PipeCorrection>(key: K, value: PipeCorrection[K]) =>
    setDraft({ ...draft, [key]: value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave(draft);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const field = `w-full p-2.5 rounded-xl border font-bold ${
    sunlightMode
      ? 'bg-zinc-900 border-amber-400 text-amber-300 placeholder-amber-500/50'
      : 'bg-slate-800 border-slate-600 text-white placeholder-slate-400'
  }`;
  const label = 'flex items-center gap-1.5 text-xs font-black uppercase tracking-wider mb-1';

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      sunlightMode={sunlightMode}
      maxWidth="max-w-2xl"
      zIndex={50}
      label={`Edit pipe ${record.pipeNumber}`}
    >
      <div
        className={`w-full flex flex-col min-h-0 max-h-full rounded-2xl border shadow-2xl overflow-hidden ${
          sunlightMode
            ? 'bg-zinc-950 border-amber-400 text-amber-300'
            : 'bg-slate-900 border-slate-700 text-white'
        }`}
      >
        <div
          className={`px-4 sm:px-6 py-4 border-b flex items-center justify-between ${
            sunlightMode ? 'bg-amber-400 text-black border-amber-500' : 'bg-blue-600 text-white border-blue-700'
          }`}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-black/20 flex items-center justify-center">
              <Pencil className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg sm:text-xl font-black leading-tight">EDIT PIPE #{record.pipeNumber}</h2>
              <p className="text-xs font-bold opacity-90">
                {record.startDepth.toFixed(2)} – {record.endDepth.toFixed(2)} m · {record.operator}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-2 rounded-lg bg-black/20 hover:bg-black/40">
            <X className="w-6 h-6" />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 sm:p-6 space-y-4 flex-1 min-h-0 overflow-y-auto">
          <p className="text-[11px] font-semibold opacity-70">
            Depth, times and drilling rate are measured and cannot be changed.
          </p>

          <div>
            <label className={label}>
              <Layers className="w-4 h-4 text-cyan-400" /> Geological Formation / Lithology
            </label>
            <select value={draft.formation} onChange={(e) => set('formation', e.target.value)} className={field}>
              {withCurrent(FORMATION_OPTIONS, draft.formation).map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className={label}>
                <Wrench className="w-4 h-4 text-cyan-400" /> Bit Type
              </label>
              <select value={draft.bitType} onChange={(e) => set('bitType', e.target.value)} className={field}>
                {withCurrent(BIT_TYPE_OPTIONS, draft.bitType).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={label}>Bit Size (in)</label>
              <input
                type="number"
                step="0.125"
                value={draft.bitDiameter}
                onChange={(e) => set('bitDiameter', Number(e.target.value))}
                className={field}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>
                <Gauge className="w-4 h-4 text-amber-400" /> Air Pressure (PSI)
              </label>
              <input type="number" value={draft.airPressure} onChange={(e) => set('airPressure', Number(e.target.value))} className={field} />
            </div>
            <div>
              <label className={label}>
                <Gauge className="w-4 h-4 text-orange-400" /> Compressor (PSI)
              </label>
              <input
                type="number"
                value={draft.compressorPressure}
                onChange={(e) => set('compressorPressure', Number(e.target.value))}
                className={field}
              />
            </div>
          </div>

          <div className={`p-3 rounded-xl border ${draft.waterStrike ? 'border-cyan-500 bg-blue-900/30' : 'border-slate-700'}`}>
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 font-black text-sm uppercase">
                <Droplets className="w-5 h-5 text-cyan-400" /> Water Strike
              </span>
              <button
                type="button"
                onClick={() =>
                  setDraft({
                    ...draft,
                    waterStrike: !draft.waterStrike,
                    waterStrikeDetails: draft.waterStrikeDetails ?? { depth: record.endDepth, flowRateLpm: 0 },
                  })
                }
                className={`px-4 py-2 rounded-xl font-black text-xs uppercase ${
                  draft.waterStrike ? 'bg-cyan-500 text-black' : 'bg-slate-700 text-slate-300'
                }`}
              >
                {draft.waterStrike ? 'YES' : 'NO'}
              </button>
            </div>
            {draft.waterStrike && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <label className={label}>Flow (L/min)</label>
                  <input
                    type="number"
                    value={draft.waterStrikeDetails?.flowRateLpm ?? 0}
                    onChange={(e) =>
                      set('waterStrikeDetails', {
                        depth: record.endDepth,
                        ...draft.waterStrikeDetails,
                        flowRateLpm: Number(e.target.value),
                      })
                    }
                    className={field}
                  />
                </div>
                <div>
                  <label className={label}>Static Water Level (m)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={draft.waterStrikeDetails?.staticWaterLevel ?? ''}
                    onChange={(e) =>
                      set('waterStrikeDetails', {
                        depth: record.endDepth,
                        flowRateLpm: 0,
                        ...draft.waterStrikeDetails,
                        staticWaterLevel: e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    }
                    className={field}
                  />
                </div>
              </div>
            )}
          </div>

          <div>
            <label className={label}>Remarks</label>
            <textarea
              rows={3}
              value={draft.remarks}
              onChange={(e) => set('remarks', e.target.value)}
              placeholder="e.g. Hard quartzite band at 16 m, smooth rotation after"
              className={field}
            />
          </div>

          {error && (
            <p className="text-xs font-bold text-rose-300 bg-rose-500/10 border border-rose-500/40 rounded-lg p-2">
              Not saved: {error}
            </p>
          )}

          <div className="flex flex-col sm:flex-row gap-3 pt-1">
            <button
              type="submit"
              disabled={busy}
              className={`flex-1 py-3.5 rounded-2xl font-black text-base uppercase tracking-wider disabled:opacity-50 ${
                sunlightMode ? 'bg-amber-400 text-black' : 'bg-blue-600 hover:bg-blue-500 text-white'
              }`}
            >
              {busy ? 'Saving…' : 'Save Changes'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="py-3.5 px-6 rounded-2xl font-bold text-sm bg-slate-800 border border-slate-600 hover:bg-slate-700"
            >
              Cancel
            </button>
          </div>

          {onDelete && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Delete pipe #${record.pipeNumber}? The borehole depth is recalculated without it.`)) {
                  onDelete(record);
                  onClose();
                }
              }}
              className="w-full py-3 rounded-2xl font-black text-xs uppercase tracking-wider flex items-center justify-center gap-1.5 text-red-400 border border-red-500/40 hover:bg-red-500/10"
            >
              <Trash2 className="w-4 h-4" /> Delete this pipe
            </button>
          )}
        </form>
      </div>
    </ModalShell>
  );
};
