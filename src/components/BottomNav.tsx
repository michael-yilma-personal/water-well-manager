import React from 'react';
import { motion } from 'motion/react';
import {
  Compass,
  FileText,
  Activity,
  BarChart3,
} from 'lucide-react';
import { Pressable } from '../ui/Pressable';
import { SPRING_DEFAULT, SPRING_MOMENTUM, motionSafe } from '../ui/springs';
import { useReducedMotion, useReducedTransparency } from '../ui/prefs';

export type NavTab = 'rig' | 'logs' | 'npt' | 'analytics';

interface BottomNavProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  sunlightMode: boolean;
  pipeCount?: number;
  nptCount?: number;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  onSelectTab,
  sunlightMode,
  pipeCount = 0,
  nptCount = 0,
}) => {
  const reducedMotion = useReducedMotion();
  const solid = useReducedTransparency() || sunlightMode;

  const tabs: {
    id: NavTab;
    label: string;
    icon: React.ReactNode;
    badge?: number;
  }[] = [
    {
      id: 'rig',
      label: 'Rig Control',
      icon: <Compass className="w-5 h-5 sm:w-6 sm:h-6" />,
    },
    {
      id: 'logs',
      label: 'Pipe Log',
      icon: <FileText className="w-5 h-5 sm:w-6 sm:h-6" />,
      badge: pipeCount > 0 ? pipeCount : undefined,
    },
    {
      id: 'npt',
      label: 'Downtime',
      icon: <Activity className="w-5 h-5 sm:w-6 sm:h-6" />,
      badge: nptCount > 0 ? nptCount : undefined,
    },
    {
      id: 'analytics',
      label: 'Analytics',
      icon: <BarChart3 className="w-5 h-5 sm:w-6 sm:h-6" />,
    },
  ];

  return (
    <nav
      className={`material fixed bottom-0 left-0 right-0 z-40 border-t pb-safe ${
        sunlightMode
          ? 'border-amber-400 text-amber-300 shadow-2xl shadow-amber-900/40'
          : 'border-zinc-700/80 text-white shadow-lg'
      }`}
      style={
        solid
          ? { background: sunlightMode ? '#000000' : '#1A1A1A' }
          : {
              // Content scrolls underneath rather than being walled off by an
              // opaque strip, so the list reads as continuing past the bar.
              background: 'rgba(20, 20, 20, 0.82)',
              backdropFilter: 'blur(24px) saturate(180%)',
              WebkitBackdropFilter: 'blur(24px) saturate(180%)',
              // A bright top edge is light catching the lip of the material.
              // It also does the work the old hard divider did, without
              // drawing a line across the screen.
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10), 0 -8px 24px rgba(0,0,0,0.45)',
            }
      }
    >
      <div className="max-w-7xl mx-auto px-2 flex items-center justify-around">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <Pressable
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              aria-current={isActive ? 'page' : undefined}
              haptic
              pressScale={0.94}
              // A nav target jabbed with a work glove: never below 44px, and
              // the press state is what confirms the hit, not the tab change.
              className={`relative flex-1 min-h-[56px] py-2.5 sm:py-3 px-1 flex flex-col items-center justify-center ${
                isActive
                  ? sunlightMode
                    ? 'text-black font-black'
                    : 'text-[#FFD700] font-extrabold'
                  : sunlightMode
                    ? 'text-[#FFD700]/80 font-bold'
                    : 'text-zinc-400 font-semibold'
              }`}
            >
              {/* One indicator that travels between tabs rather than four that
                  blink on and off. Seeing it move is what tells you where you
                  came from and where you now are. */}
              {isActive && (
                <motion.span
                  layoutId="bottom-nav-indicator"
                  transition={motionSafe(SPRING_DEFAULT, reducedMotion)}
                  className={`absolute inset-x-1 inset-y-0.5 rounded-lg -z-10 ${
                    sunlightMode
                      ? 'bg-[#FFD700]'
                      : 'bg-zinc-800 border-t-2 border-[#FFD700]'
                  }`}
                />
              )}
              <div className="relative">
                {tab.icon}
                {tab.badge !== undefined && (
                  <motion.span
                    // The count arrives with a little bounce because something
                    // actually happened - a pipe was logged, a fault recorded.
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={motionSafe(SPRING_MOMENTUM, reducedMotion)}
                    key={tab.badge}
                    className={`type-data absolute -top-1.5 -right-3.5 px-1.5 py-0.5 rounded-full text-[10px] font-black ${
                      sunlightMode
                        ? 'bg-red-600 text-white'
                        : 'bg-[#FFD700] text-black'
                    }`}
                  >
                    {tab.badge}
                  </motion.span>
                )}
              </div>
              <span className="type-label text-[11px] sm:text-xs mt-1 truncate max-w-full">
                {tab.label}
              </span>
            </Pressable>
          );
        })}
      </div>
    </nav>
  );
};
