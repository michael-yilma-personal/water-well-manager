import React from 'react';
import {
  Compass,
  FileText,
  Activity,
  BarChart3,
} from 'lucide-react';

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
      label: 'NPT / Events',
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
      className={`fixed bottom-0 left-0 right-0 z-40 border-t transition-colors ${
        sunlightMode
          ? 'bg-black border-amber-400 text-amber-300 shadow-2xl shadow-amber-900/40'
          : 'bg-[#1A1A1A] border-zinc-700 text-white shadow-lg'
      }`}
    >
      <div className="max-w-7xl mx-auto px-2 flex items-center justify-around">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              className={`relative flex-1 py-2.5 sm:py-3 px-1 flex flex-col items-center justify-center transition-all ${
                isActive
                  ? sunlightMode
                    ? 'text-black bg-[#FFD700] font-black shadow-md'
                    : 'text-[#FFD700] bg-zinc-800 font-extrabold border-t-2 border-[#FFD700]'
                  : sunlightMode
                    ? 'text-[#FFD700]/80 hover:bg-zinc-900 font-bold'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800/40 font-semibold'
              }`}
            >
              <div className="relative">
                {tab.icon}
                {tab.badge !== undefined && (
                  <span
                    className={`absolute -top-1.5 -right-3.5 px-1.5 py-0.5 rounded-full text-[10px] font-black ${
                      sunlightMode
                        ? 'bg-red-600 text-white'
                        : 'bg-[#FFD700] text-black'
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
              </div>
              <span className="text-[11px] sm:text-xs mt-1 tracking-tight truncate max-w-full">
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
