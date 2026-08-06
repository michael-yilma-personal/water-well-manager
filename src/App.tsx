/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  ActivePipeTimer,
  AppSettings,
  Borehole,
  DrillingEvent,
  EventType,
  PipeRecord,
  User,
} from './types';
import { DrillingStorage, SAMPLE_USERS, createRecordId } from './services/storage';
import { Header } from './components/Header';
import { BottomNav, NavTab } from './components/BottomNav';
import { RigControlView } from './components/views/RigControlView';
import { PipeLogView } from './components/views/PipeLogView';
import { NPTView } from './components/views/NPTView';
import { AnalyticsView } from './components/views/AnalyticsView';
import { EndPipeModal } from './components/modals/EndPipeModal';
import { EventModal } from './components/modals/EventModal';
import { NewBoreholeModal } from './components/modals/NewBoreholeModal';
import { SettingsModal } from './components/modals/SettingsModal';
import { ProfileModal } from './components/modals/ProfileModal';
import { UserManagementModal } from './components/modals/UserManagementModal';
import {
  generateShiftReportPDF,
  generateBoreholeExcelReport,
} from './utils/reports';
import { playAlertSound, triggerVibration } from './utils/audio';
import { useAndroidBackButton } from './utils/useAndroidBackButton';
import { getOutbox } from './services/storage';
import { SyncWorker } from './services/syncWorker';
import { createSupabaseTransport } from './services/syncTransport';
import { createCompositeTransport, createPhotoTransport } from './services/photoTransport';
import { getSupabase, isSupabaseConfigured } from './services/supabaseClient';
import { getCurrentUserId, isProvisioned } from './services/auth';
import { SignInScreen } from './components/SignInScreen';

export default function App() {
  // Storage instance
  const [storage] = useState(() => new DrillingStorage());

  // Application state
  const [settings, setSettings] = useState<AppSettings>(() =>
    storage.getSettings()
  );
  const [currentUser, setCurrentUser] = useState<User>(
    () => storage.getCurrentUser() || SAMPLE_USERS[0]
  );
  const [users, setUsers] = useState<User[]>(() => storage.getUsers());
  const [boreholes, setBoreholes] = useState<Borehole[]>(() =>
    storage.getBoreholes()
  );
  const [activeBoreholeId, setActiveBoreholeId] = useState<string>(() => {
    const active = storage.getActiveBorehole();
    return active?.id || storage.getBoreholes()[0]?.id || '';
  });

  const activeBorehole =
    boreholes.find((b) => b.id === activeBoreholeId) || boreholes[0];

  const [pipeRecords, setPipeRecords] = useState<PipeRecord[]>(() =>
    activeBorehole ? storage.getPipeRecords(activeBorehole.id) : []
  );
  const [events, setEvents] = useState<DrillingEvent[]>(() =>
    activeBorehole ? storage.getEvents(activeBorehole.id) : []
  );

  // Active pipe timer
  const [activeTimer, setActiveTimer] = useState<ActivePipeTimer>(() =>
    activeBorehole
      ? storage.getActiveTimer(activeBorehole.id)
      : {
          boreholeId: '',
          pipeNumber: 1,
          startTime: '',
          startDepth: 0,
          formation: 'Topsoil',
          isActive: false,
        }
  );

  // Active navigation tab
  const [activeTab, setActiveTab] = useState<NavTab>('rig');

  // Modals state
  const [isEndPipeModalOpen, setIsEndPipeModalOpen] = useState(false);
  const [isEventModalOpen, setIsEventModalOpen] = useState(false);
  const [selectedEventType, setSelectedEventType] =
    useState<EventType>('Breakdown');
  const [isNewBoreholeModalOpen, setIsNewBoreholeModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isUserManagementOpen, setIsUserManagementOpen] = useState(false);

  // Sync state
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingSync, setPendingSync] = useState(() =>
    DrillingStorage.getPendingSyncCount()
  );
  const [syncError, setSyncError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(() => isProvisioned());

  const [syncWorker] = useState(
    () =>
      new SyncWorker({
        outbox: getOutbox(),
        // Photos go to object storage, records go to tables, but they share
        // one queue so ordering and retry behaviour stay consistent.
        transport: createCompositeTransport(
          createSupabaseTransport({
            getClient: getSupabase,
            getUserId: getCurrentUserId,
          }),
          createPhotoTransport({
            getClient: getSupabase,
            getUserId: getCurrentUserId,
          })
        ),
        onChange: () => setPendingSync(DrillingStorage.getPendingSyncCount()),
      })
  );

  // The worker listens for network-regained and app-resume, so a device that
  // spent the day out of coverage uploads as soon as it is opened in range.
  useEffect(() => {
    if (!signedIn || !isSupabaseConfigured()) return;
    void syncWorker.start();
    return () => syncWorker.stop();
  }, [syncWorker, signedIn]);

  // Reload records when active borehole changes
  useEffect(() => {
    if (activeBorehole) {
      setPipeRecords(storage.getPipeRecords(activeBorehole.id));
      setEvents(storage.getEvents(activeBorehole.id));
      setActiveTimer(storage.getActiveTimer(activeBorehole.id));
    }
  }, [activeBoreholeId, activeBorehole?.id, storage]);

  // Connectivity is tracked only to label the UI. The actual upload trigger
  // lives in SyncWorker, which uses @capacitor/network - navigator.onLine
  // reports "online" for a WiFi association that has no route anywhere, which
  // is exactly a rig-side access point with no uplink.
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // Handle START PIPE
  const handleStartPipe = () => {
    if (!activeBorehole) return;

    const nextPipeNum =
      pipeRecords.length > 0
        ? Math.max(...pipeRecords.map((r) => r.pipeNumber)) + 1
        : 1;

    const nowIso = new Date().toISOString();
    const defaultPipeLength = Number(
      activeBorehole.defaultPipeLength || settings.defaultPipeLength || 4.55
    );
    const newTimer: ActivePipeTimer = {
      boreholeId: activeBorehole.id,
      pipeNumber: nextPipeNum,
      startTime: nowIso,
      startDepth: activeBorehole.currentDepth,
      pipeLength: defaultPipeLength,
      formation:
        pipeRecords.length > 0
          ? pipeRecords[pipeRecords.length - 1].formation
          : settings.defaultFormation || 'Topsoil',
      bitType: activeBorehole.bitType || settings.defaultBitType || 'DTH Hammer - Button Bit',
      bitDiameter: activeBorehole.bitDiameter || settings.defaultBitDiameter || 8.5,
      operator: currentUser.name,
      isActive: true,
    };

    storage.saveActiveTimer(newTimer);
    setActiveTimer(newTimer);
  };

  // Handle END PIPE modal open
  const handleOpenEndPipeModal = () => {
    setIsEndPipeModalOpen(true);
  };

  // Handle END PIPE submit. The modal emits a draft without an id — mint one here
  // so every save appends instead of matching a previous record on `undefined`.
  const handleSavePipeRecord = (draft: Omit<PipeRecord, 'id'>) => {
    if (!activeBorehole) return;

    const record: PipeRecord = { ...draft, id: createRecordId('pipe') };

    // Save record to local storage & queue cloud sync. Storage owns the depth
    // update (currentDepth only ever advances to the deepest recorded pipe).
    storage.savePipeRecord(record);
    const nextBoreholes = storage.getBoreholes();
    setBoreholes(nextBoreholes);

    const updatedBorehole =
      nextBoreholes.find((b) => b.id === activeBorehole.id) || activeBorehole;

    // Reset active timer, ready for the next pipe
    const resetTimer: ActivePipeTimer = {
      boreholeId: activeBorehole.id,
      pipeNumber: record.pipeNumber + 1,
      startTime: '',
      startDepth: updatedBorehole.currentDepth,
      formation: record.formation,
      operator: currentUser.name,
      isActive: false,
    };
    storage.saveActiveTimer(resetTimer);
    setActiveTimer(resetTimer);

    // Refresh state
    setPipeRecords(storage.getPipeRecords(activeBorehole.id));
  };

  // Handle saving NPT / Drilling Event
  const handleSaveEvent = (draft: Omit<DrillingEvent, 'id'>) => {
    if (!activeBorehole) return;
    storage.saveEvent({ ...draft, id: createRecordId('ev') });
    setEvents(storage.getEvents(activeBorehole.id));
  };

  // Handle deleting pipe record
  const handleDeletePipeRecord = (id: string) => {
    if (!activeBorehole) return;
    storage.deletePipeRecord(activeBorehole.id, id);
    setPipeRecords(storage.getPipeRecords(activeBorehole.id));
  };

  // Handle deleting event
  const handleDeleteEvent = (id: string) => {
    if (!activeBorehole) return;
    storage.deleteEvent(activeBorehole.id, id);
    setEvents(storage.getEvents(activeBorehole.id));
  };

  const handleSelectBorehole = (boreholeId: string) => {
    storage.setActiveBorehole(boreholeId);
    setActiveBoreholeId(boreholeId);
  };

  // Handle creating new borehole
  const handleCreateBorehole = (newBh: Borehole) => {
    storage.saveBorehole(newBh);
    storage.setActiveBorehole(newBh.id);
    const list = storage.getBoreholes();
    setBoreholes(list);
    setActiveBoreholeId(newBh.id);
    setPipeRecords([]);
    setEvents([]);
    setActiveTimer({
      boreholeId: newBh.id,
      pipeNumber: 1,
      startTime: '',
      startDepth: 0,
      formation: settings.defaultFormation || 'Topsoil',
      isActive: false,
    });
    setIsNewBoreholeModalOpen(false);
    setActiveTab('rig');
  };

  const handleDeleteBorehole = (boreholeId: string) => {
    if (!boreholeId) return;
    storage.deleteBorehole(boreholeId);
    const list = storage.getBoreholes();
    setBoreholes(list);
    const nextActive = list.find((bh) => bh.id === boreholeId)
      ? list[0]
      : list.find((bh) => bh.id === activeBoreholeId) || list[0];
    if (nextActive) {
      storage.setActiveBorehole(nextActive.id);
      setActiveBoreholeId(nextActive.id);
      setPipeRecords(storage.getPipeRecords(nextActive.id));
      setEvents(storage.getEvents(nextActive.id));
      setActiveTimer(storage.getActiveTimer(nextActive.id));
    } else {
      setActiveBoreholeId('');
      setPipeRecords([]);
      setEvents([]);
      setActiveTimer({
        boreholeId: '',
        pipeNumber: 1,
        startTime: '',
        startDepth: 0,
        formation: settings.defaultFormation || 'Topsoil',
        isActive: false,
      });
    }
  };

  // Handle updating borehole default pipe length
  const handleUpdateBoreholePipeLength = (newLen: number) => {
    if (!activeBorehole) return;
    const updated: Borehole = {
      ...activeBorehole,
      defaultPipeLength: newLen,
      updatedAt: new Date().toISOString(),
    };
    storage.saveBorehole(updated);
    setBoreholes(storage.getBoreholes());
  };

  // Handle saving App settings
  const handleSaveSettings = (newSet: AppSettings) => {
    storage.saveSettings(newSet);
    setSettings(newSet);
  };

  const handleSaveProfile = (newUser: User) => {
    storage.saveUser(newUser);
    storage.setCurrentUser(newUser.id);
    setUsers(storage.getUsers());
    setCurrentUser(newUser);
  };

  const handleSaveManagedUser = (user: User) => {
    storage.saveUser(user);
    const nextUsers = storage.getUsers();
    setUsers(nextUsers);

    // Keep the active profile in sync when the edited user is the active one.
    const nextUser =
      nextUsers.find((candidate) => candidate.id === user.id) || user;
    if (currentUser.id === user.id) {
      storage.setCurrentUser(nextUser.id);
      setCurrentUser(nextUser);
    }
  };

  const handleDeleteManagedUser = (userId: string) => {
    storage.deleteUser(userId);
    let remaining = storage.getUsers();

    // Never leave the rig without a profile to log records against.
    if (remaining.length === 0) {
      storage.saveUser(SAMPLE_USERS[0]);
      remaining = storage.getUsers();
    }
    setUsers(remaining);

    if (currentUser.id === userId) {
      // storage.deleteUser already re-points the stored active id; mirror it here.
      const fallback = remaining[0];
      storage.setCurrentUser(fallback.id);
      setCurrentUser(fallback);
    }
  };

  const handleChangeUser = (userId: string) => {
    const match = users.find((u) => u.id === userId);
    if (match) {
      storage.setCurrentUser(userId);
      setCurrentUser(match);
    }
  };

  // Handle resetting demo data
  const handleResetDemoData = () => {
    storage.resetToDemoData();
    const list = storage.getBoreholes();
    setBoreholes(list);
    if (list[0]) {
      storage.setActiveBorehole(list[0].id);
      setActiveBoreholeId(list[0].id);
      setPipeRecords(storage.getPipeRecords(list[0].id));
      setEvents(storage.getEvents(list[0].id));
      setActiveTimer(storage.getActiveTimer(list[0].id));
    }
  };

  // Manual cloud sync
  const handleManualSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      const result = await syncWorker.syncNow();
      setPendingSync(storage.getPendingSyncCount());
      if (result.failed > 0 && result.sent === 0) {
        // Silence here would look identical to a successful upload, which is
        // the failure mode this whole feature exists to remove.
        const parked = getOutbox().parked();
        const reason = parked[0]?.lastError ?? 'still offline';
        setSyncError(`Could not upload ${result.failed} change(s): ${reason}`);
      } else {
        setSyncError(null);
      }
      playAlertSound(true);
      triggerVibration([80, 40, 80]);
    } finally {
      setIsSyncing(false);
    }
  };

  // Android Back: unwind one layer of UI rather than closing the app.
  const closeTopModal = React.useCallback(() => {
    const open: [boolean, (v: boolean) => void][] = [
      [isEndPipeModalOpen, setIsEndPipeModalOpen],
      [isEventModalOpen, setIsEventModalOpen],
      [isNewBoreholeModalOpen, setIsNewBoreholeModalOpen],
      [isSettingsModalOpen, setIsSettingsModalOpen],
      [isProfileModalOpen, setIsProfileModalOpen],
      [isUserManagementOpen, setIsUserManagementOpen],
    ];
    const top = open.find(([isOpen]) => isOpen);
    if (!top) return false;
    top[1](false);
    return true;
  }, [
    isEndPipeModalOpen,
    isEventModalOpen,
    isNewBoreholeModalOpen,
    isSettingsModalOpen,
    isProfileModalOpen,
    isUserManagementOpen,
  ]);

  const goToRootTab = React.useCallback(() => {
    if (activeTab === 'rig') return false;
    setActiveTab('rig');
    return true;
  }, [activeTab]);

  useAndroidBackButton({ closeTopModal, goToRootTab });


  /**
   * Stop a pipe that was started by mistake.
   *
   * Previously the only exit from a running pipe was to save a record, which
   * wrote fabricated depth into the drilling log - a two-second pipe once
   * produced a penetration rate of 8190 m/hr. Cancelling records the lost time
   * as a downtime event instead, so the abandonment is visible in the report
   * rather than silently erased, and depth is untouched.
   */
  const handleCancelPipe = () => {
    if (!activeBorehole || !activeTimer.isActive) return;
    const startedAt = new Date(activeTimer.startTime);
    const minutes = Math.max(
      1,
      Math.round((Date.now() - startedAt.getTime()) / 60000)
    );
    if (
      !window.confirm(
        `Cancel pipe #${activeTimer.pipeNumber}?\n\n` +
          `No depth will be recorded. ${minutes} minute(s) will be logged as ` +
          `downtime so the time is still accounted for.`
      )
    ) {
      return;
    }

    storage.saveEvent({
      id: createRecordId('ev'),
      boreholeId: activeBorehole.id,
      type: 'General Note',
      title: `Pipe #${activeTimer.pipeNumber} cancelled before completion`,
      timestamp: new Date().toISOString(),
      durationMinutes: minutes,
      isNPT: true,
      operator: currentUser.name,
      depthAtEvent: activeBorehole.currentDepth,
      details: {
        notes:
          `Pipe #${activeTimer.pipeNumber} was started at ` +
          `${startedAt.toLocaleTimeString()} and cancelled without recording ` +
          `depth. Strata at the time: ${activeTimer.formation}.`,
      },
      synced: false,
    });

    storage.clearActiveTimer(activeBorehole.id);
    setActiveTimer(storage.getActiveTimer(activeBorehole.id));
    setEvents(storage.getEvents(activeBorehole.id));
    setPendingSync(DrillingStorage.getPendingSyncCount());
    triggerVibration([60, 30, 60]);
  };

  const sunlightMode = settings.sunlightMode;

  // Exports are async now that they write through the native filesystem. A
  // rejected promise here would otherwise fail exactly the way the Android
  // download bug did — silently, with the driller left staring at a button
  // that appears to do nothing.
  const runExport = (task: () => Promise<void>) => {
    task().catch((err) => {
      console.error('Export failed', err);
      alert(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  };

  // Provisioning happens once, where there is signal. "Work offline for now"
  // is deliberately offered: a crew must be able to start logging before
  // anyone has issued them an account.
  const [skippedSignIn, setSkippedSignIn] = useState(false);
  if (!signedIn && !skippedSignIn) {
    return (
      <SignInScreen
        onSignedIn={() => {
          // A linked device belongs to a real crew, so the seeded sample job
          // is just a confusing fake borehole on the rig. Anything actually
          // recorded before linking is kept and will still sync.
          const removed = DrillingStorage.clearDemoData();
          if (removed > 0) {
            console.info(`[storage] cleared ${removed} sample record(s) on link`);
          }
          setBoreholes(storage.getBoreholes());
          setActiveBoreholeId(storage.getActiveBorehole()?.id ?? '');
          setSignedIn(true);
        }}
        onSkip={() => setSkippedSignIn(true)}
      />
    );
  }

  // A device with no boreholes is a real state, not an error: it is exactly what
  // a crew sees the moment their device is linked and the sample job is cleared.
  // Rendering the rig UI here would dereference an undefined active borehole.
  if (!activeBorehole) {
    return (
      <div className="min-h-screen bg-[#0A0A0A] text-white flex flex-col items-center justify-center p-6 text-center">
        <h1 className="text-2xl font-black tracking-tight">PERIPLUS DRILL</h1>
        <p className="mt-2 mb-6 text-sm text-slate-400 font-semibold max-w-xs">
          No borehole on this device yet. Create one to start logging pipes.
          Everything is saved on the rig and uploads when you next have signal.
        </p>
        <button
          onClick={() => setIsNewBoreholeModalOpen(true)}
          className="px-6 py-3.5 rounded-xl bg-[#FFD700] text-black font-black uppercase tracking-wider border-b-4 border-yellow-700 active:translate-y-1"
        >
          Create a borehole
        </button>
        <NewBoreholeModal
          isOpen={isNewBoreholeModalOpen}
          onClose={() => setIsNewBoreholeModalOpen(false)}
          onSave={handleCreateBorehole}
          sunlightMode={sunlightMode}
        />
      </div>
    );
  }

  return (
    <div
      className={`min-h-screen flex flex-col font-sans select-none antialiased ${
        sunlightMode
          ? 'bg-black text-[#FFD700]'
          : 'bg-[#0A0A0A] text-white'
      }`}
    >
      {/* Header with Rig Info, Status, Role Switcher, & Theme */}
      <Header
        activeBorehole={activeBorehole}
        allBoreholes={boreholes}
        onSelectBorehole={handleSelectBorehole}
        onOpenNewBorehole={() => setIsNewBoreholeModalOpen(true)}
        onOpenSettings={() => setIsSettingsModalOpen(true)}
        currentUser={currentUser}
        allUsers={users}
        onChangeUser={handleChangeUser}
        sunlightMode={sunlightMode}
        onToggleSunlightMode={() =>
          handleSaveSettings({
            ...settings,
            sunlightMode: !settings.sunlightMode,
          })
        }
        soundEnabled={settings.soundEnabled}
        onToggleSound={() =>
          handleSaveSettings({
            ...settings,
            soundEnabled: !settings.soundEnabled,
          })
        }
        pendingSyncCount={pendingSync}
        isSyncing={isSyncing}
        onSyncNow={handleManualSync}
        onOpenProfile={() => setIsProfileModalOpen(true)}
        onOpenUserManagement={() => setIsUserManagementOpen(true)}
      />

      {/* Main Content Area */}
      {syncError && (
        <div className="mx-3 mt-2 p-2.5 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 text-[11px] font-bold flex items-start justify-between gap-2">
          <span>{syncError}</span>
          <button
            onClick={() => setSyncError(null)}
            className="shrink-0 underline uppercase tracking-wider"
          >
            Dismiss
          </button>
        </div>
      )}

      <main className="flex-1 flex flex-col pb-20">
        {activeTab === 'rig' && (
          <RigControlView
            activeBorehole={activeBorehole}
            activeTimer={activeTimer}
            onStartPipe={handleStartPipe}
            onOpenEndPipeModal={handleOpenEndPipeModal}
            onCancelPipe={handleCancelPipe}
            onOpenEventModal={(type) => {
              setSelectedEventType(type);
              setIsEventModalOpen(true);
            }}
            onOpenSettings={() => setIsSettingsModalOpen(true)}
            pipeRecords={pipeRecords}
            events={events}
            currentUser={currentUser}
            sunlightMode={sunlightMode}
            onGenerateShiftReport={() =>
              runExport(() =>
                generateShiftReportPDF(activeBorehole, pipeRecords, events)
              )
            }
            onExportExcel={() =>
              runExport(() =>
                generateBoreholeExcelReport(activeBorehole, pipeRecords, events)
              )
            }
          />
        )}

        {activeTab === 'logs' && (
          <PipeLogView
            borehole={activeBorehole}
            pipeRecords={pipeRecords}
            onDeletePipe={handleDeletePipeRecord}
            onExportPDF={() =>
              runExport(() =>
                generateShiftReportPDF(activeBorehole, pipeRecords, events)
              )
            }
            onExportExcel={() =>
              runExport(() =>
                generateBoreholeExcelReport(activeBorehole, pipeRecords, events)
              )
            }
            sunlightMode={sunlightMode}
          />
        )}

        {activeTab === 'npt' && (
          <NPTView
            borehole={activeBorehole}
            events={events}
            onOpenEventModal={(type) => {
              if (type) setSelectedEventType(type);
              setIsEventModalOpen(true);
            }}
            onDeleteEvent={handleDeleteEvent}
            sunlightMode={sunlightMode}
          />
        )}

        {activeTab === 'analytics' && (
          <AnalyticsView
            borehole={activeBorehole}
            pipeRecords={pipeRecords}
            events={events}
            sunlightMode={sunlightMode}
          />
        )}
      </main>

      {/* Fixed Bottom Navigation Bar (Driller Gloves Friendly) */}
      <BottomNav
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        sunlightMode={sunlightMode}
        pipeCount={pipeRecords.length}
        nptCount={events.filter((e) => e.isNPT).length}
      />

      {/* MODALS */}
      <EndPipeModal
        isOpen={isEndPipeModalOpen}
        onClose={() => setIsEndPipeModalOpen(false)}
        activeTimer={activeTimer}
        borehole={activeBorehole}
        onSavePipe={handleSavePipeRecord}
        sunlightMode={sunlightMode}
      />

      <EventModal
        isOpen={isEventModalOpen}
        onClose={() => setIsEventModalOpen(false)}
        eventType={selectedEventType}
        borehole={activeBorehole}
        operator={currentUser.name}
        onSaveEvent={handleSaveEvent}
        sunlightMode={sunlightMode}
      />

      <NewBoreholeModal
        isOpen={isNewBoreholeModalOpen}
        onClose={() => setIsNewBoreholeModalOpen(false)}
        onSave={handleCreateBorehole}
        sunlightMode={sunlightMode}
      />

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        settings={settings}
        onSaveSettings={handleSaveSettings}
        activeBorehole={activeBorehole}
        onUpdateBoreholePipeLength={handleUpdateBoreholePipeLength}
        sunlightMode={sunlightMode}
        onOpenUserManagement={() => setIsUserManagementOpen(true)}
        onResetDemoData={handleResetDemoData}
        onDeleteCurrentProject={() => {
          if (activeBorehole) {
            handleDeleteBorehole(activeBorehole.id);
          }
        }}
      />

      <UserManagementModal
        isOpen={isUserManagementOpen}
        onClose={() => setIsUserManagementOpen(false)}
        users={users}
        currentUserId={currentUser.id}
        onSaveUser={handleSaveManagedUser}
        onDeleteUser={handleDeleteManagedUser}
        onSetCurrentUser={handleChangeUser}
        sunlightMode={sunlightMode}
      />

      <ProfileModal
        isOpen={isProfileModalOpen}
        onClose={() => setIsProfileModalOpen(false)}
        onSave={handleSaveProfile}
        sunlightMode={sunlightMode}
      />
    </div>
  );
}
