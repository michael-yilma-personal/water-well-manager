import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Pressable } from '../ui/Pressable';
import { SPRING_DEFAULT, motionSafe } from '../ui/springs';
import { useReducedMotion, useReducedTransparency } from '../ui/prefs';
import {
  Borehole,
  User,
  UserRole
} from '../types';
import {
  AlertTriangle,
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
  ClipboardList,
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
  sunlightMode: boolean;
  onToggleSunlightMode: () => void;
  soundEnabled: boolean;
  onToggleSound: () => void;
  pendingSyncCount: number;
  /** Work given up on. Needs a person, not another retry. */
  parkedSyncCount: number;
  isSyncing: boolean;
  onSyncNow: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeBorehole,
  allBoreholes,
  onSelectBorehole,
  onOpenNewBorehole,
  onOpenSettings,
  currentUser,
  sunlightMode,
  onToggleSunlightMode,
  soundEnabled,
  onToggleSound,
  pendingSyncCount,
  parkedSyncCount,
  isSyncing,
  onSyncNow,
}) => {
  const [showBoreholeMenu, setShowBoreholeMenu] = React.useState(false);
  const [showUserMenu, setShowUserMenu] = React.useState(false);
  const reducedMotion = useReducedMotion();
  const solid = useReducedTransparency() || sunlightMode;
  const menuOpen = showBoreholeMenu || showUserMenu;

  const closeMenus = () => {
    setShowBoreholeMenu(false);
    setShowUserMenu(false);
  };

  const getRoleBadgeColor = (role: UserRole) => {
    switch (role) {
      case 'Driller':
        return sunlightMode ? 'bg-amber-400 text-black font-extrabold' : 'bg-amber-500 text-white font-bold';
      case 'Data Logger':
        return sunlightMode ? 'bg-teal-400 text-black font-extrabold' : 'bg-teal-600 text-white font-bold';
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
      case 'Data Logger':
        return <ClipboardList className="w-4 h-4 mr-1" />;
      case 'Supervisor':
        return <UserCheck className="w-4 h-4 mr-1" />;
      case 'Administrator':
        return <Shield className="w-4 h-4 mr-1" />;
    }
  };

  return (
    <header
      className={`material sticky top-0 z-40 border-b pt-safe transition-colors ${
        sunlightMode
          ? 'border-amber-400 text-amber-300 shadow-lg shadow-amber-900/40'
          : 'border-slate-700/80 text-white shadow-md'
      }`}
      style={
        solid
          ? { background: sunlightMode ? '#000000' : '#0F172A' }
          : {
              // Floating chrome with the rig screen visible through it. The
              // saturate keeps the gold from going grey behind the blur.
              background: 'rgba(15, 23, 42, 0.82)',
              backdropFilter: 'blur(24px) saturate(180%)',
              WebkitBackdropFilter: 'blur(24px) saturate(180%)',
              boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.08), 0 8px 24px rgba(0,0,0,0.35)',
            }
      }
    >
      {/* Tapping anywhere else closes an open menu. Without this the only way
          out of the borehole or user list was to hit its trigger again - a
          dead end for anyone who opened it by accident with a glove on. */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-40"
          aria-hidden="true"
          onClick={closeMenus}
        />
      )}

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
              <Compass className="w-6 h-6" />
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
            <Pressable
              onClick={() => {
                setShowBoreholeMenu(!showBoreholeMenu);
                setShowUserMenu(false);
              }}
              aria-expanded={showBoreholeMenu}
              haptic
              className={`flex items-center gap-2 w-full px-3 py-2.5 sm:py-2.5 rounded-xl border font-bold text-xs sm:text-sm min-h-[44px] ${
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
              <motion.span
                animate={{ rotate: showBoreholeMenu ? 180 : 0 }}
                transition={motionSafe(SPRING_DEFAULT, reducedMotion)}
                className="shrink-0 opacity-70"
              >
                <ChevronDown className="w-4 h-4" />
              </motion.span>
            </Pressable>

            {/* Borehole Dropdown Menu */}
            <AnimatePresence>
              {showBoreholeMenu && (
              <motion.div
                // Grown from the control that opened it rather than from its
                // own centre, so the menu and its button read as one object.
                style={{ transformOrigin: 'top left' }}
                initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: -6 }}
                animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
                exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: -4 }}
                transition={motionSafe(SPRING_DEFAULT, reducedMotion)}
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
                      <Pressable
                        onClick={() => {
                          onSelectBorehole(bh.id);
                          setShowBoreholeMenu(false);
                        }}
                        pressScale={0.985}
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
                      </Pressable>
                    </div>
                  ))}
                </div>

                <div className="border-t border-slate-700/60 pt-2 mt-1 flex gap-2">
                  <Pressable
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
                  </Pressable>
                  <Pressable
                    onClick={() => {
                      setShowBoreholeMenu(false);
                      onOpenSettings();
                    }}
                    className="py-2 px-3 rounded-lg text-xs font-bold bg-slate-700/60 hover:bg-slate-600"
                  >
                    Rig Settings
                  </Pressable>
                </div>
              </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Right: Sync Pill, User Role Switcher & High Sunlight Contrast Toggle */}
        <div className="flex items-center flex-wrap justify-end gap-1.5 sm:gap-2.5 ml-auto min-w-0">
          {/* Offline / Sync Status Badge */}
          <Pressable
            onClick={onSyncNow}
            disabled={isSyncing || pendingSyncCount + parkedSyncCount === 0}
            title={
              parkedSyncCount > 0
                ? `${parkedSyncCount} record(s) could not be uploaded and were given up on. Click to try again.`
                : pendingSyncCount > 0
                  ? `${pendingSyncCount} offline changes pending sync. Click to upload now.`
                  : 'All drilling records synchronized to cloud'
            }
            className={`type-data flex items-center gap-1.5 px-2.5 py-2 rounded-xl text-xs font-black min-h-[44px] ${
              isSyncing
                ? 'bg-blue-500/20 text-blue-300 border border-blue-500 animate-pulse'
                : parkedSyncCount > 0
                  ? sunlightMode
                    ? 'bg-red-500 text-white font-extrabold shadow-md'
                    : 'bg-red-500/20 text-red-300 border border-red-500/50 hover:bg-red-500/30'
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
                <span>Syncing…</span>
              </>
            ) : parkedSyncCount > 0 ? (
              /* Retrying on its own has already been tried and has stopped.
                 Saying "Synced" here loses the record silently, so this state
                 stays loud until a person clears it. */
              <>
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>{parkedSyncCount} Not Sent</span>
              </>
            ) : pendingSyncCount > 0 ? (
              <>
                <CloudOff className="w-3.5 h-3.5 text-amber-400" />
                <span>{pendingSyncCount} Offline</span>
              </>
            ) : (
              <>
                <Cloud className="w-3.5 h-3.5 text-emerald-400" />
                {/* A driller needs to read this at a glance, so the phone gets
                    a short word rather than a bare icon. */}
                <span className="sm:hidden">Synced</span>
                <span className="hidden sm:inline">Cloud Synced</span>
              </>
            )}
          </Pressable>

          {/* Sound & Haptic Toggle */}
          <Pressable
            onClick={onToggleSound}
            haptic
            aria-label={soundEnabled ? 'Turn field beeps off' : 'Turn field beeps on'}
            aria-pressed={soundEnabled}
            title={soundEnabled ? 'Audio field beeps ON' : 'Audio field beeps OFF'}
            className={`p-2.5 rounded-xl border min-h-[44px] min-w-[44px] flex items-center justify-center ${
              sunlightMode
                ? 'bg-zinc-900 border-amber-400 text-amber-300 hover:bg-zinc-800'
                : 'bg-slate-800 border-slate-600 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {soundEnabled ? <Volume2 className="w-4 h-4 text-cyan-400" /> : <VolumeX className="w-4 h-4 opacity-50" />}
          </Pressable>

          {/* Sunlight / High Contrast Glove Mode Toggle */}
          <Pressable
            onClick={onToggleSunlightMode}
            haptic
            aria-label="Sunlight mode"
            aria-pressed={sunlightMode}
            title="Toggle Sunlight / High Contrast Mode (Optimized for gloves & bright sunlight)"
            className={`flex items-center gap-1.5 px-2.5 py-2 rounded-xl border font-black text-xs min-h-[44px] ${
              sunlightMode
                ? 'bg-amber-400 text-black border-white shadow-lg'
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
          </Pressable>

          {/* User Role Selector */}
          <div className="relative">
            <Pressable
              onClick={() => {
                setShowUserMenu(!showUserMenu);
                setShowBoreholeMenu(false);
              }}
              aria-expanded={showUserMenu}
              haptic
              className={`flex items-center gap-1.5 px-2.5 py-2 rounded-xl border font-bold text-xs min-h-[44px] ${
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
              <motion.span
                animate={{ rotate: showUserMenu ? 180 : 0 }}
                transition={motionSafe(SPRING_DEFAULT, reducedMotion)}
                className="opacity-70"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </motion.span>
            </Pressable>

            {/* Role / User Dropdown */}
            <AnimatePresence>
              {showUserMenu && (
              <motion.div
                // Anchored top-right: this menu hangs off the right edge, so
                // that is the corner it has to grow from.
                style={{ transformOrigin: 'top right' }}
                initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: -6 }}
                animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
                exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: -4 }}
                transition={motionSafe(SPRING_DEFAULT, reducedMotion)}
                className={`absolute right-0 mt-2 w-64 rounded-xl border shadow-2xl z-50 p-2 ${
                  sunlightMode
                    ? 'bg-zinc-950 border-amber-400 text-amber-300'
                    : 'bg-slate-800 border-slate-600 text-slate-100'
                }`}
              >
                {/*
                  One identity, and it is the account that signed in. The list
                  this replaced was local and invented - ids like `usr-1788`,
                  unable to sign in or own a row - and adopting the real profile
                  wiped it a second after it was created, so the driller watched
                  their entry vanish with no explanation.
                */}
                <div className="text-[11px] uppercase tracking-wider font-bold px-2 py-1 opacity-70">
                  Signed in as
                </div>
                <div className="px-2 pb-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-bold text-sm truncate">{currentUser.name}</div>
                    <div className="text-xs opacity-80">
                      {currentUser.badgeNumber || 'No badge number'}
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-extrabold px-2 py-0.5 rounded uppercase shrink-0 ${
                      currentUser.role === 'Driller'
                        ? 'bg-amber-500/20 text-amber-300'
                        : currentUser.role === 'Data Logger'
                          ? 'bg-teal-500/20 text-teal-300'
                          : currentUser.role === 'Supervisor'
                            ? 'bg-blue-500/20 text-blue-300'
                            : 'bg-purple-500/20 text-purple-300'
                    }`}
                  >
                    {currentUser.role}
                  </span>
                </div>
                <div
                  className={`border-t px-2 pt-2 text-[11px] leading-relaxed opacity-75 ${
                    sunlightMode ? 'border-amber-400/40' : 'border-slate-600'
                  }`}
                >
                  Every record logged here is filed under this account. Crew
                  accounts are managed by an administrator in the dashboard. To
                  hand this phone to another driller, use Rig Settings → Sign Out.
                </div>
              </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </header>
  );
};
