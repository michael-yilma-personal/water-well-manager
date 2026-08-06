import React from 'react';
import {
  Borehole,
  User,
  UserRole
} from '../types';
import {
  Cloud,
  CloudOff,
  RefreshCw,
  Sun,
  Moon,
  Volume2,
  VolumeX,
  Compass,
  MapPin,
  ChevronDown,
  Plus,
  Shield,
  UserCheck,
  HardHat,
  AlertCircle,
  UserCircle2
} from 'lucide-react';

interface HeaderProps {
  activeBorehole: Borehole;
  allBoreholes: Borehole[];
  onSelectBorehole: (id: string) => void;
  onOpenNewBorehole: () => void;
  onOpenSettings: () => void;
  currentUser: User;
  allUsers: User[];
  onChangeUser: (userId: string) => void;
  sunlightMode: boolean;
  onToggleSunlightMode: () => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
  pendingSyncCount: number;
  isSyncing: boolean;
  onSyncNow: () => void;
  onOpenProfile: () => void;
  onOpenUserManagement: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeBorehole,
  allBoreholes,
  onSelectBorehole,
  onOpenNewBorehole,
  onOpenSettings,
  currentUser,
  allUsers,
  onChangeUser,
  sunlightMode,
  onToggleSunlightMode,
  soundEnabled,
  onToggleSound,
  pendingSyncCount,
  isSyncing,
  onSyncNow,
  onOpenProfile,
  onOpenUserManagement,
}) => {
  const [showBoreholeMenu, setShowBoreholeMenu] = React.useState(false);
  const [showUserMenu, setShowUserMenu] = React.useState(false);

  const getRoleBadgeColor = (role: UserRole) => {
    switch (role) {
      case 'Driller':
        return sunlightMode ? 'bg-amber-400 text-black font-extrabold' : 'bg-amber-500 text-white font-bold';
      case 'Supervisor':
        return sunlightMode ? 'bg-blue-400 text-black font-extrabold' : 'bg-blue-600 text-white font-bold';
      case 'Administrator':
        return sunlightMode ? 'bg-purple-400 text-black font-extrabold' : 'bg-purple-600 text-white font-bold';
    }
  };

  const getRoleIcon = (role: UserRole) => {
    switch (role) {
      case 'Driller':
        return <HardHat className="w-4 h-4 mr-1" />;
      case 'Supervisor':
        return <UserCheck className="w-4 h-4 mr-1" />;
      case 'Administrator':
        return <Shield className="w-4 h-4 mr-1" />;
    }
  };

  return (
    <header
      className={`sticky top-0 z-40 border-b transition-colors ${
        sunlightMode
          ? 'bg-black border-amber-400 text-amber-300 shadow-lg shadow-amber-900/40'
          : 'bg-slate-900 border-slate-700 text-white shadow-md'
      }`}
    >
      <div className="max-w-7xl mx-auto px-2.5 sm:px-4 py-2.5 sm:py-3 flex flex-wrap items-center justify-between gap-2 sm:gap-3">
        {/* Left: Branding & Borehole Selector */}
        {/* A real floor, not min-w-0. min-w-0 let this group shrink below its
            own contents, so the row never overflowed, never wrapped, and the
            two groups collided instead. The floor makes the container wrap the
            controls onto a second row once space runs out. */}
        <div className="flex items-center gap-2 sm:gap-4 flex-1 min-w-[168px]">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className={`w-10 h-10 sm:w-11 sm:h-11 rounded-xl flex items-center justify-center font-extrabold shrink-0 ${
                sunlightMode
                  ? 'bg-amber-400 text-black border-2 border-white'
                  : 'bg-gradient-to-br from-blue-500 to-cyan-500 text-white shadow-sm'
              }`}
            >
              <Compass className="w-6 h-6 animate-pulse" />
            </div>
            {/* Held back to lg: between 640-1024px this wordmark consumed the
                space the borehole selector and sync controls both needed. */}
            <div className="hidden lg:block">
              <h1
                className={`font-black text-base sm:text-lg tracking-tight leading-none ${
                  sunlightMode ? 'text-amber-300' : 'text-white'
                }`}
              >
                PERIPLUS DRILL
              </h1>
              <p
                className={`text-[11px] font-semibold tracking-wider uppercase ${
                  sunlightMode ? 'text-amber-400/80' : 'text-slate-400'
                }`}
              >
                Water Well Systems
              </p>
            </div>
          </div>

          {/* Active Borehole Dropdown */}
          <div className="relative flex-1 min-w-0 max-w-full sm:max-w-[360px]">
            <button
              onClick={() => {
                setShowBoreholeMenu(!showBoreholeMenu);
                setShowUserMenu(false);
              }}
              className={`flex items-center gap-2 w-full px-3 py-2.5 sm:py-2.5 rounded-xl border font-bold text-xs sm:text-sm transition-all min-h-[44px] ${
                sunlightMode
                  ? 'bg-zinc-900 border-amber-400 text-amber-300 hover:bg-zinc-800'
                  : 'bg-slate-800 border-slate-600 text-slate-100 hover:bg-slate-700'
              }`}
            >
              <MapPin className="w-4 h-4 text-cyan-400 shrink-0" />
              <div className="text-left truncate min-w-0 flex-1">
                <div className="truncate font-black">{activeBorehole.name}</div>
                <div className="text-[10px] opacity-75 truncate">{activeBorehole.rigName}</div>
              </div>
              <ChevronDown className="w-4 h-4 shrink-0 opacity-70" />
            </button>

            {/* Borehole Dropdown Menu */}
            {showBoreholeMenu && (
              <div
                className={`absolute left-0 mt-2 w-72 sm:w-80 rounded-xl border shadow-2xl z-50 p-2 ${
                  sunlightMode
                    ? 'bg-zinc-950 border-amber-400 text-amber-300'
                    : 'bg-slate-800 border-slate-600 text-slate-100'
                }`}
              >
                <div className="text-[11px] uppercase tracking-wider font-bold px-2 py-1 opacity-70">
                  Select Active Borehole
                </div>
                <div className="max-h-64 overflow-y-auto space-y-1 my-1">
                  {allBoreholes.map((bh) => (
                    <div
                      key={bh.id}
                      className={`w-full rounded-lg transition-colors ${
                        bh.id === activeBorehole.id
                          ? sunlightMode
                            ? 'bg-amber-400 text-black font-extrabold'
                            : 'bg-blue-600 text-white font-bold'
                          : sunlightMode
                            ? 'hover:bg-zinc-800 text-amber-300'
                            : 'hover:bg-slate-700 text-slate-200'
                      }`}
                    >
                      <button
                        onClick={() => {
                          onSelectBorehole(bh.id);
                          setShowBoreholeMenu(false);
                        }}
                        className="w-full text-left p-2.5 flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0 pr-2">
                          <div className="font-bold text-sm truncate">{bh.name}</div>
                          <div className="text-xs opacity-80 truncate">
                            {bh.project} • {bh.currentDepth}m
                          </div>
                        </div>
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0 ${
                            bh.status === 'active'
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                              : 'bg-slate-500/20 text-slate-400'
                          }`}
                        >
                          {bh.status}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>

                <div className="border-t border-slate-700/60 pt-2 mt-1 flex gap-2">
                  <button
                    onClick={() => {
                      setShowBoreholeMenu(false);
                      onOpenNewBorehole();
                    }}
                    className={`flex-1 py-2 px-3 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 ${
                      sunlightMode
                        ? 'bg-amber-400 text-black hover:bg-amber-300'
                        : 'bg-cyan-600 text-white hover:bg-cyan-500'
                    }`}
                  >
                    <Plus className="w-4 h-4" /> New Borehole
                  </button>
                  <button
                    onClick={() => {
                      setShowBoreholeMenu(false);
                      onOpenSettings();
                    }}
                    className="py-2 px-3 rounded-lg text-xs font-bold bg-slate-700/60 hover:bg-slate-600"
                  >
                    Rig Settings
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Sync Pill, User Role Switcher & High Sunlight Contrast Toggle */}
        <div className="flex items-center flex-wrap justify-end gap-1.5 sm:gap-2.5 ml-auto min-w-0">
          {/* Offline / Sync Status Badge */}
          <button
            onClick={onSyncNow}
            disabled={isSyncing || pendingSyncCount === 0}
            title={
              pendingSyncCount > 0
                ? `${pendingSyncCount} offline changes pending sync. Click to upload now.`
                : 'All drilling records synchronized to cloud'
            }
            className={`flex items-center gap-1.5 px-2.5 py-2 rounded-xl text-xs font-black transition-all min-h-[40px] ${
              isSyncing
                ? 'bg-blue-500/20 text-blue-300 border border-blue-500 animate-pulse'
                : pendingSyncCount > 0
                  ? sunlightMode
                    ? 'bg-amber-400 text-black font-extrabold shadow-md'
                    : 'bg-amber-500/20 text-amber-300 border border-amber-500/50 hover:bg-amber-500/30'
                  : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
            }`}
          >
            {isSyncing ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span className="hidden sm:inline">Syncing...</span>
              </>
            ) : pendingSyncCount > 0 ? (
              <>
                <CloudOff className="w-3.5 h-3.5 text-amber-400" />
                <span>{pendingSyncCount} Offline</span>
              </>
            ) : (
              <>
                <Cloud className="w-3.5 h-3.5 text-emerald-400" />
                <span className="hidden sm:inline">Cloud Synced</span>
              </>
            )}
          </button>

          {/* Sound & Haptic Toggle */}
          <button
            onClick={onToggleSound}
            title={soundEnabled ? 'Audio field beeps ON' : 'Audio field beeps OFF'}
            className={`p-2.5 rounded-xl border transition-colors min-h-[40px] min-w-[40px] flex items-center justify-center ${
              sunlightMode
                ? 'bg-zinc-900 border-amber-400 text-amber-300 hover:bg-zinc-800'
                : 'bg-slate-800 border-slate-600 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {soundEnabled ? <Volume2 className="w-4 h-4 text-cyan-400" /> : <VolumeX className="w-4 h-4 opacity-50" />}
          </button>

          {/* Sunlight / High Contrast Glove Mode Toggle */}
          <button
            onClick={onToggleSunlightMode}
            title="Toggle Sunlight / High Contrast Mode (Optimized for gloves & bright sunlight)"
            className={`flex items-center gap-1.5 px-2.5 py-2 rounded-xl border font-black text-xs transition-all min-h-[40px] ${
              sunlightMode
                ? 'bg-amber-400 text-black border-white shadow-lg animate-pulse'
                : 'bg-slate-800 border-slate-600 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {sunlightMode ? (
              <>
                <Sun className="w-4 h-4 text-black shrink-0" />
                <span className="hidden md:inline">SUNLIGHT MODE ON</span>
              </>
            ) : (
              <>
                <Moon className="w-4 h-4 text-amber-400 shrink-0" />
                <span className="hidden md:inline">Sunlight Mode</span>
              </>
            )}
          </button>

          <button
            onClick={onOpenProfile}
            title="Create or switch profile"
            className={`p-2.5 rounded-xl border transition-colors min-h-[40px] min-w-[40px] flex items-center justify-center ${
              sunlightMode
                ? 'bg-zinc-900 border-amber-400 text-amber-300 hover:bg-zinc-800'
                : 'bg-slate-800 border-slate-600 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <UserCircle2 className="w-4 h-4" />
          </button>

          <button
            onClick={onOpenUserManagement}
            title="Manage staff profiles"
            className={`p-2.5 rounded-xl border transition-colors min-h-[40px] min-w-[40px] flex items-center justify-center ${
              sunlightMode
                ? 'bg-zinc-900 border-amber-400 text-amber-300 hover:bg-zinc-800'
                : 'bg-slate-800 border-slate-600 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <Shield className="w-4 h-4" />
          </button>

          {/* User Role Selector */}
          <div className="relative">
            <button
              onClick={() => {
                setShowUserMenu(!showUserMenu);
                setShowBoreholeMenu(false);
              }}
              className={`flex items-center gap-1.5 px-2.5 py-2 rounded-xl border font-bold text-xs transition-all min-h-[40px] ${
                sunlightMode
                  ? 'bg-zinc-900 border-amber-400 text-amber-300'
                  : 'bg-slate-800 border-slate-600 text-slate-200 hover:bg-slate-700'
              }`}
            >
              <span
                className={`flex items-center px-1.5 py-0.5 rounded text-[11px] font-black uppercase ${getRoleBadgeColor(
                  currentUser.role
                )}`}
              >
                {getRoleIcon(currentUser.role)}
                {currentUser.role}
              </span>
              {/* Shown at every width: this is the name that goes on each pipe record,
                  and a shared phone signed in as the wrong person is exactly the
                  mistake worth catching before a shift, not after. */}
              <span className="font-bold truncate max-w-[72px] sm:max-w-[110px] min-w-0">
                {currentUser.name}
              </span>
              <ChevronDown className="w-3.5 h-3.5 opacity-70" />
            </button>

            {/* Role / User Dropdown */}
            {showUserMenu && (
              <div
                className={`absolute right-0 mt-2 w-64 rounded-xl border shadow-2xl z-50 p-2 ${
                  sunlightMode
                    ? 'bg-zinc-950 border-amber-400 text-amber-300'
                    : 'bg-slate-800 border-slate-600 text-slate-100'
                }`}
              >
                <div className="text-[11px] uppercase tracking-wider font-bold px-2 py-1 opacity-70">
                  Switch User / Role
                </div>
                <div className="space-y-1 my-1">
                  {allUsers.map((user) => (
                    <button
                      key={user.id}
                      onClick={() => {
                        onChangeUser(user.id);
                        setShowUserMenu(false);
                      }}
                      className={`w-full text-left p-2 rounded-lg flex items-center justify-between transition-colors ${
                        user.id === currentUser.id
                          ? sunlightMode
                            ? 'bg-amber-400 text-black font-extrabold'
                            : 'bg-blue-600 text-white font-bold'
                          : sunlightMode
                            ? 'hover:bg-zinc-800 text-amber-300'
                            : 'hover:bg-slate-700 text-slate-200'
                      }`}
                    >
                      <div>
                        <div className="font-bold text-sm">{user.name}</div>
                        <div className="text-xs opacity-80">{user.badgeNumber}</div>
                      </div>
                      <span
                        className={`text-[10px] font-extrabold px-2 py-0.5 rounded uppercase ${
                          user.role === 'Driller'
                            ? 'bg-amber-500/20 text-amber-300'
                            : user.role === 'Supervisor'
                              ? 'bg-blue-500/20 text-blue-300'
                              : 'bg-purple-500/20 text-purple-300'
                        }`}
                      >
                        {user.role}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
