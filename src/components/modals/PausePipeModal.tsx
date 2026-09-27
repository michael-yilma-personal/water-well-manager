import React, { useEffect, useState } from 'react';
import { Pause, X } from 'lucide-react';
import { ModalShell } from '../../ui/ModalShell';
import { PAUSE_REASONS } from '../../services/pipePause';

interface PausePipeModalProps {
  isOpen: boolean;
  onClose: () => void;
  pipeNumber: number;
  onPause: (reason: string, note: string) => void;
  sunlightMode: boolean;
}

/**
 * Why is the rig stopping? One tap on a reason pauses the pipe - a second
 * "confirm" button is one more target for a gloved hand, and a pause taken by
 * mistake costs nothing: Resume is right there.
 */
export const PausePipeModal: React.FC<PausePipeModalProps> = ({
  isOpen,
  onClose,
  pipeNumber,
  onPause,
  sunlightMode,
}) => {
  const [note, setNote] = useState('');

  // Stays mounted between pauses; do not carry the last note onto the next.
  useEffect(() => {
    if (isOpen) setNote('');
  }, [isOpen]);

  const choose = (reason: string) => {
    onPause(reason, note);
    onClose();
  };

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      sunlightMode={sunlightMode}
      maxWidth="max-w-lg"
      zIndex={50}
      label="Pause drilling"
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
            sunlightMode
              ? 'bg-amber-400 text-black border-amber-500'
              : 'bg-amber-500 text-black border-amber-600'
          }`}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-black/15 flex items-center justify-center">
              <Pause className="w-5 h-5 fill-current" />
            </div>
            <div>
              <h2 className="text-lg sm:text-xl font-black leading-tight">
                PAUSE PIPE #{pipeNumber}
              </h2>
              <p className="text-xs font-bold opacity-80">
                The drilling timer stops until you resume
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-2 rounded-lg bg-black/15 hover:bg-black/30 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-4 flex-1 min-h-0 overflow-y-auto">
          <div>
            <label className="block text-xs font-black uppercase tracking-wider mb-1.5">
              Note (optional)
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Fuel bowser 30 min out"
              className={`w-full p-3 rounded-xl border font-bold ${
                sunlightMode
                  ? 'bg-zinc-900 border-amber-400 text-amber-300 placeholder-amber-500/50'
                  : 'bg-slate-800 border-slate-600 text-white placeholder-slate-400'
              }`}
            />
          </div>

          <div>
            <div className="text-xs font-black uppercase tracking-wider mb-1.5">
              Reason - tap to pause
            </div>
            <div className="grid grid-cols-2 gap-2">
              {PAUSE_REASONS.map((reason) => (
                <button
                  key={reason}
                  type="button"
                  onClick={() => choose(reason)}
                  className={`min-h-[64px] px-3 py-3 rounded-xl border-2 font-black text-sm text-left leading-tight active:scale-95 transition-colors ${
                    sunlightMode
                      ? 'bg-zinc-900 border-amber-400 text-amber-300 hover:bg-zinc-800'
                      : 'bg-slate-800 border-slate-600 hover:border-amber-400 hover:bg-slate-700'
                  }`}
                >
                  {reason}
                </button>
              ))}
            </div>
          </div>

          <p className="text-[11px] opacity-70 font-semibold">
            Paused time is logged as downtime and left out of this pipe&apos;s
            drilling time and penetration rate.
          </p>
        </div>
      </div>
    </ModalShell>
  );
};
