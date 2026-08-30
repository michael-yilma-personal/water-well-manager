import React, { useState } from 'react';
import { User, UserRole } from '../../types';
import { X, UserCircle2 } from 'lucide-react';
import { ModalShell } from '../../ui/ModalShell';

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (user: User) => void;
  sunlightMode: boolean;
}

export const ProfileModal: React.FC<ProfileModalProps> = ({
  isOpen,
  onClose,
  onSave,
  sunlightMode,
}) => {
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('Driller');
  const [badgeNumber, setBadgeNumber] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    onSave({
      id: `usr-${Date.now()}`,
      name: name.trim(),
      role,
      badgeNumber: badgeNumber.trim() || `${role.slice(0, 3).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`,
    });

    setName('');
    setRole('Driller');
    setBadgeNumber('');
    onClose();
  };

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      sunlightMode={sunlightMode}
      maxWidth="max-w-md"
      zIndex={60}
      label="Create profile"
    >
      <div
        className={`w-full flex flex-col min-h-0 max-h-full rounded-xl border-2 shadow-2xl overflow-hidden ${
          sunlightMode
            ? 'bg-zinc-950 border-[#FFD700] text-[#FFD700]'
            : 'bg-[#1A1A1A] border-[#D1D1D1]/40 text-white'
        }`}
      >
        <div
          className={`px-4 sm:px-6 py-4 border-b-2 flex items-center justify-between ${
            sunlightMode
              ? 'bg-[#FFD700] text-black border-black'
              : 'bg-black text-white border-[#FFD700]/50'
          }`}
        >
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded ${sunlightMode ? 'bg-black text-[#FFD700]' : 'bg-[#FFD700] text-black'}`}>
              <UserCircle2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-black tracking-tight">CREATE PROFILE</h2>
              <p className="text-xs opacity-80 font-bold uppercase">Simple staff profile for field use</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded hover:bg-white/10 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4">
          <div>
            <label className="block text-xs font-black uppercase mb-1 opacity-80">Full name *</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Daniel Otieno"
              className={`w-full p-3 rounded border-2 font-bold ${
                sunlightMode
                  ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                  : 'bg-zinc-900 border-zinc-700 text-white'
              }`}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-black uppercase mb-1 opacity-80">Role</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as UserRole)}
                className={`w-full p-3 rounded border-2 font-bold ${
                  sunlightMode
                    ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                    : 'bg-zinc-900 border-zinc-700 text-white'
                }`}
              >
                <option value="Driller">Driller</option>
                <option value="Supervisor">Supervisor</option>
                <option value="Administrator">Administrator</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-black uppercase mb-1 opacity-80">Badge number</label>
              <input
                type="text"
                value={badgeNumber}
                onChange={(e) => setBadgeNumber(e.target.value)}
                placeholder="Optional"
                className={`w-full p-3 rounded border-2 font-bold ${
                  sunlightMode
                    ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]'
                    : 'bg-zinc-900 border-zinc-700 text-white'
                }`}
              />
            </div>
          </div>

          <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-3 text-sm text-zinc-300">
            This creates a simple field profile so the app can tag entries to the right person without adding extra steps.
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-700 text-white font-bold">
              Cancel
            </button>
            <button type="submit" className={`px-4 py-2 rounded-lg font-black ${sunlightMode ? 'bg-[#FFD700] text-black' : 'bg-cyan-600 text-white'}`}>
              Save Profile
            </button>
          </div>
        </form>
      </div>
    </ModalShell>
  );
};
