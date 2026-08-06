import React, { useState } from 'react';
import { User, UserRole } from '../../types';
import { X, Users, Plus, Trash2, PencilLine } from 'lucide-react';

interface UserManagementModalProps {
  isOpen: boolean;
  onClose: () => void;
  users: User[];
  currentUserId: string;
  onSaveUser: (user: User) => void;
  onDeleteUser: (userId: string) => void;
  onSetCurrentUser: (userId: string) => void;
  sunlightMode: boolean;
}

export const UserManagementModal: React.FC<UserManagementModalProps> = ({
  isOpen,
  onClose,
  users,
  currentUserId,
  onSaveUser,
  onDeleteUser,
  onSetCurrentUser,
  sunlightMode,
}) => {
  const [draftName, setDraftName] = useState('');
  const [draftRole, setDraftRole] = useState<UserRole>('Driller');
  const [draftBadge, setDraftBadge] = useState('');
  const [editingUserId, setEditingUserId] = useState<string | null>(null);

  if (!isOpen) return null;

  const resetForm = () => {
    setDraftName('');
    setDraftRole('Driller');
    setDraftBadge('');
    setEditingUserId(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draftName.trim()) return;

    const nextUser: User = {
      id: editingUserId || `usr-${Date.now()}`,
      name: draftName.trim(),
      role: draftRole,
      badgeNumber: draftBadge.trim() || `${draftRole.slice(0, 3).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`,
    };

    onSaveUser(nextUser);
    resetForm();
  };

  const startEdit = (user: User) => {
    setDraftName(user.name);
    setDraftRole(user.role);
    setDraftBadge(user.badgeNumber);
    setEditingUserId(user.id);
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
      <div className={`w-full max-w-2xl rounded-xl border-2 shadow-2xl overflow-hidden ${sunlightMode ? 'bg-zinc-950 border-[#FFD700] text-[#FFD700]' : 'bg-[#1A1A1A] border-[#D1D1D1]/40 text-white'}`}>
        <div className={`px-4 sm:px-6 py-4 border-b-2 flex items-center justify-between ${sunlightMode ? 'bg-[#FFD700] text-black border-black' : 'bg-black text-white border-[#FFD700]/50'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded ${sunlightMode ? 'bg-black text-[#FFD700]' : 'bg-[#FFD700] text-black'}`}>
              <Users className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-black tracking-tight">USER MANAGEMENT</h2>
              <p className="text-xs opacity-80 font-bold uppercase">Add, edit, and deactivate staff profiles</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded hover:bg-white/10 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 space-y-4 max-h-[80vh] overflow-y-auto">
          <form onSubmit={handleSubmit} className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-3 sm:p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-black uppercase tracking-wider">
              <Plus className="w-4 h-4" />
              {editingUserId ? 'Edit Existing User' : 'Add New User'}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-black uppercase mb-1 opacity-80">Full name *</label>
                <input
                  type="text"
                  required
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  className={`w-full p-2.5 rounded border-2 font-bold ${sunlightMode ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]' : 'bg-zinc-950 border-zinc-700 text-white'}`}
                />
              </div>
              <div>
                <label className="block text-xs font-black uppercase mb-1 opacity-80">Role</label>
                <select
                  value={draftRole}
                  onChange={(e) => setDraftRole(e.target.value as UserRole)}
                  className={`w-full p-2.5 rounded border-2 font-bold ${sunlightMode ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]' : 'bg-zinc-950 border-zinc-700 text-white'}`}
                >
                  <option value="Driller">Driller</option>
                  <option value="Supervisor">Supervisor</option>
                  <option value="Administrator">Administrator</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-black uppercase mb-1 opacity-80">Badge number</label>
              <input
                type="text"
                value={draftBadge}
                onChange={(e) => setDraftBadge(e.target.value)}
                placeholder="Optional"
                className={`w-full p-2.5 rounded border-2 font-bold ${sunlightMode ? 'bg-zinc-900 border-[#FFD700] text-[#FFD700]' : 'bg-zinc-950 border-zinc-700 text-white'}`}
              />
            </div>

            <div className="flex justify-end gap-2">
              {editingUserId && (
                <button type="button" onClick={resetForm} className="px-3 py-2 rounded-lg bg-slate-700 text-white font-bold">
                  Cancel Edit
                </button>
              )}
              <button type="submit" className={`px-3 py-2 rounded-lg font-black ${sunlightMode ? 'bg-[#FFD700] text-black' : 'bg-cyan-600 text-white'}`}>
                {editingUserId ? 'Save Changes' : 'Add User'}
              </button>
            </div>
          </form>

          <div className="rounded-lg border border-zinc-700 bg-zinc-900/40 p-3 space-y-2">
            <div className="text-xs font-black uppercase tracking-wider opacity-70">Current staff</div>
            {users.length === 0 ? (
              <div className="text-sm opacity-60">No users yet.</div>
            ) : (
              users.map((user) => (
                <div key={user.id} className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border p-2.5 ${currentUserId === user.id ? 'border-cyan-500/50 bg-cyan-500/10' : 'border-zinc-700 bg-black/20'}`}>
                  <div>
                    <div className="font-black">{user.name}</div>
                    <div className="text-xs opacity-70">{user.role} • {user.badgeNumber}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onSetCurrentUser(user.id)}
                      className={`px-2.5 py-1.5 rounded text-xs font-black ${currentUserId === user.id ? 'bg-cyan-600 text-white' : 'bg-zinc-800 text-zinc-200'}`}
                    >
                      {currentUserId === user.id ? 'Active' : 'Set Active'}
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(user)}
                      className="px-2.5 py-1.5 rounded text-xs font-black bg-amber-600/20 text-amber-400 border border-amber-500/30"
                    >
                      <span className="flex items-center gap-1"><PencilLine className="w-3.5 h-3.5" /> Edit</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Delete user “${user.name}”?`)) {
                          onDeleteUser(user.id);
                        }
                      }}
                      className="px-2.5 py-1.5 rounded text-xs font-black bg-rose-600/20 text-rose-400 border border-rose-500/30"
                    >
                      <span className="flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" /> Delete</span>
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
