import React, { useState } from 'react';
import { AppSettings, Borehole } from '../../types';
import {
  FORMATION_OPTIONS,
  BIT_TYPE_OPTIONS,
  BIT_DIAMETER_OPTIONS,
} from '../../services/storage';
import { X, Settings, Sun, Volume2, HardDrive, RefreshCw, AlertTriangle, Users } from 'lucide-react';
import { ModalShell } from '../../ui/ModalShell';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSaveSettings: (settings: AppSettings) => void;
  activeBorehole: Borehole;
  onUpdateBoreholePipeLength: (length: number) => void;
  sunlightMode: boolean;
  onResetDemoData: () => void;
  onDeleteCurrentProject: () => void;
  onOpenUserManagement: () => void;
  /** Hand the phone to another driller. */
  onSignOut: () => void;
  /** Records still on this device. Signing out is refused while any remain. */
  unsyncedCount: number;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
  activeBorehole,
  onUpdateBoreholePipeLength,
  sunlightMode,
  onResetDemoData,
  onDeleteCurrentProject,
  onOpenUserManagement,
  onSignOut,
  unsyncedCount,
}) => {
  const [defaultPipeLength, setDefaultPipeLength] = useState(
    activeBorehole.defaultPipeLength || settings.defaultPipeLength || 4.55
  );
  const [defaultFormation, setDefaultFormation] = useState(
    settings.defaultFormation
  );
  const [defaultBitType, setDefaultBitType] = useState(settings.defaultBitType);
  const [defaultBitDiameter, setDefaultBitDiameter] = useState(
    settings.defaultBitDiameter
  );
  const [soundEnabled, setSoundEnabled] = useState(settings.soundEnabled);
  const [vibrationEnabled, setVibrationEnabled] = useState(
    settings.vibrationEnabled
  );
  const [sunlight, setSunlight] = useState(settings.sunlightMode);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveSettings({
      ...settings,
      defaultPipeLength: Number(defaultPipeLength),
      defaultFormation,
      defaultBitType,
      defaultBitDiameter: Number(defaultBitDiameter),
      soundEnabled,
      vibrationEnabled,
      sunlightMode: sunlight,
    });
    onUpdateBoreholePipeLength(Number(defaultPipeLength));
    onClose();
  };

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      sunlightMode={sunlightMode}
      maxWidth="max-w-lg"
      zIndex={50}
      label="Rig settings"
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
              RIG-CONFIG
            </div>
            <div>
              <h2 className="text-lg sm:text-xl font-black tracking-tight">
                DRILLING RIG & PIPE SETTINGS
              </h2>
              <p className="text-xs opacity-80 font-bold uppercase">
                Configure Pipe Lengths & Field Preferences
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

        <form onSubmit={handleSave} className="p-4 sm:p-6 space-y-5 flex-1 min-h-0 overflow-y-auto">
          {/* Primary Setting: Drill Pipe Length */}
          <div className="p-4 rounded-lg border-2 border-[#FFD700] bg-black/40 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-black uppercase text-[#FFD700] tracking-wider">
                Drill Pipe Length (Meters) *
              </label>
              <span className="text-xs opacity-75 font-bold">
                Default: 4.55m
              </span>
            </div>
            {/* A flex item defaults to min-width:auto, so this text-2xl input
                refused to shrink and pushed the 3m/4.55m/6m presets ~130px past
                the modal edge on every phone width. min-w-0 lets it shrink;
                flex-wrap drops the presets to their own line when it can't. */}
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="number"
                step="0.05"
                required
                value={defaultPipeLength}
                onChange={(e) => setDefaultPipeLength(Number(e.target.value))}
                className="flex-1 min-w-0 p-3 rounded border-2 border-white/30 bg-black font-black text-2xl text-emerald-400"
              />
              <div className="flex gap-1 shrink-0">
                {[3.0, 4.55, 6.0].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setDefaultPipeLength(val)}
                    className={`px-3 py-3 rounded font-black text-xs uppercase border ${
                      defaultPipeLength === val
                        ? 'bg-[#FFD700] text-black border-[#FFD700]'
                        : 'bg-zinc-800 text-white border-zinc-700'
                    }`}
                  >
                    {val}m
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[11px] opacity-75 font-semibold">
              When you press END PIPE, depth will automatically increment by
              this pipe length.
            </p>
          </div>

          {/* Default Strata / Bit Settings */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-black uppercase mb-1 opacity-80">
                Default Geological Strata
              </label>
              <select
                value={defaultFormation}
                onChange={(e) => setDefaultFormation(e.target.value)}
                className="w-full p-2.5 rounded border-2 bg-zinc-900 border-zinc-700 font-bold"
              >
                {FORMATION_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-black uppercase mb-1 opacity-80">
                Default Bit Diameter (Inches)
              </label>
              <select
                value={defaultBitDiameter}
                onChange={(e) =>
                  setDefaultBitDiameter(Number(e.target.value))
                }
                className="w-full p-2.5 rounded border-2 bg-zinc-900 border-zinc-700 font-bold"
              >
                {BIT_DIAMETER_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}"
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-black uppercase mb-1 opacity-80">
              Default Drill Bit Type
            </label>
            <select
              value={defaultBitType}
              onChange={(e) => setDefaultBitType(e.target.value)}
              className="w-full p-2.5 rounded border-2 bg-zinc-900 border-zinc-700 font-bold"
            >
              {BIT_TYPE_OPTIONS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>

          {/* Audio & Haptic Options */}
          <div className="p-3 rounded border-2 border-zinc-700 bg-zinc-900/40 space-y-3">
            <div className="text-xs font-black uppercase text-gray-400">
              Field Rig Alerts & Glove Mode
            </div>
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm">Industrial Audio Beeps</span>
              <input
                type="checkbox"
                checked={soundEnabled}
                onChange={(e) => setSoundEnabled(e.target.checked)}
                className="w-5 h-5 accent-[#FFD700]"
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm">
                Haptic Vibration on Button Press
              </span>
              <input
                type="checkbox"
                checked={vibrationEnabled}
                onChange={(e) => setVibrationEnabled(e.target.checked)}
                className="w-5 h-5 accent-[#FFD700]"
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="font-bold text-sm">
                High Contrast Sunlight Mode
              </span>
              <input
                type="checkbox"
                checked={sunlight}
                onChange={(e) => setSunlight(e.target.checked)}
                className="w-5 h-5 accent-[#FFD700]"
              />
            </div>
          </div>

          {/* Staff / User Administration */}
          <div className="p-3 rounded border-2 border-zinc-700 bg-zinc-900/40 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-black uppercase text-gray-400">
                Staff Profiles
              </div>
              <div className="text-[11px] opacity-70">
                Add, edit, or remove the crew that logs records.
              </div>
            </div>
            <button
              type="button"
              onClick={onOpenUserManagement}
              className="px-3 py-2 rounded text-xs font-black bg-cyan-600/20 text-cyan-300 border border-cyan-500/50 hover:bg-cyan-600/40 shrink-0"
            >
              <span className="flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5" />
                Manage Users
              </span>
            </button>
          </div>

          {/* Advanced / Destructive Actions */}
          <div className="pt-3 border-t border-zinc-800">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-black uppercase tracking-wider text-rose-400">
              <AlertTriangle className="w-3.5 h-3.5" />
              Advanced / Destructive Actions
            </div>

            <div className="rounded-lg border border-rose-500/40 bg-gradient-to-br from-rose-500/15 to-red-600/10 p-3 space-y-3 shadow-inner">
              <div className="flex justify-between items-center gap-2">
                <div>
                  <div className="text-xs font-black uppercase text-rose-300">Reset Demo Data</div>
                  <div className="text-[11px] opacity-70">Restore factory sample logs.</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(
                        'Reset all drilling data to initial demo borehole sample?'
                      )
                    ) {
                      onResetDemoData();
                      onClose();
                    }
                  }}
                  className="px-3 py-1.5 rounded text-xs font-black bg-red-600/20 text-red-400 border border-red-500/50 hover:bg-red-600/40"
                >
                  Reset Demo Data
                </button>
              </div>

              <div className="flex justify-between items-center gap-2">
                <div>
                  <div className="text-xs font-black uppercase text-rose-300">Sign Out / Switch Driller</div>
                  <div className="text-[11px] opacity-70">
                    {unsyncedCount > 0
                      ? `${unsyncedCount} record(s) still on this phone. Upload them before switching.`
                      : 'Unlinks this phone and clears its records. They stay on the server.'}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={unsyncedCount > 0}
                  onClick={() => {
                    // The transport stamps created_by when a record drains, so
                    // anything still queued here would be credited to whoever
                    // signs in next. The button is disabled in that case; this
                    // second check keeps the guarantee if that ever changes.
                    if (unsyncedCount > 0) return;
                    if (
                      window.confirm(
                        'Sign out and clear this phone? Records already uploaded stay safe on the server and return when you sign in again.'
                      )
                    ) {
                      onSignOut();
                      onClose();
                    }
                  }}
                  className={`px-3 py-1.5 rounded text-xs font-black border ${
                    unsyncedCount > 0
                      ? 'bg-zinc-700/40 text-zinc-500 border-zinc-600/50 cursor-not-allowed'
                      : 'bg-red-600/20 text-red-400 border-red-500/50 hover:bg-red-600/40'
                  }`}
                >
                  Sign Out
                </button>
              </div>

              <div className="flex justify-between items-center gap-2">
                <div>
                  <div className="text-xs font-black uppercase text-rose-300">Delete Current Project</div>
                  <div className="text-[11px] opacity-70">Removes this project and all related records.</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete the current project “${activeBorehole.name}” and all of its records? This cannot be undone.`
                      )
                    ) {
                      onDeleteCurrentProject();
                      onClose();
                    }
                  }}
                  className="px-3 py-1.5 rounded text-xs font-black bg-rose-600/20 text-rose-400 border border-rose-500/50 hover:bg-rose-600/40"
                >
                  Delete Project
                </button>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="pt-2 flex gap-3">
            <button
              type="submit"
              className="flex-1 py-3 px-6 rounded font-black text-base uppercase tracking-wider bg-[#FFD700] text-black border-b-4 border-yellow-700 hover:bg-[#e6c200] active:translate-y-1 transition-colors duration-150"
            >
              SAVE SETTINGS
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
