/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Download,
  FileText,
  LogOut,
  Pause,
  Pencil,
  RefreshCw,
  Search,
  Users,
} from 'lucide-react';
import {
  fetchBoreholes,
  fetchEvents,
  fetchOngoingPauses,
  fetchPipeRecords,
  fetchProfiles,
  isOngoingPause,
  measuredDepth,
  savePipeCorrection,
  signedPhotoUrl,
  type AdminBorehole,
  type AdminEvent,
  type AdminPipeRecord,
  type Profile,
} from './adminApi';
import { signIn, signOut, getSession, fetchMyProfile } from '../services/auth';
import { EditPipeModal } from '../components/modals/EditPipeModal';
import { CrewView } from './CrewView';
import { isSupabaseConfigured } from '../services/supabaseClient';
import {
  generateBoreholeExcelReport,
  generateShiftReportPDF,
} from '../utils/reports';

/**
 * The office's view of every crew's drilling record.
 *
 * Deliberately a laptop layout rather than a phone one: a pipe log is a
 * twenty-column table, and the field app's 360px-wide UI cannot show it.
 *
 * The one write here is correcting a saved pipe's End Pipe fields, open to
 * Supervisors, Administrators and the record's author. The database enforces
 * both who and which columns; the Edit button only mirrors it.
 */

/** Who is signed in to the dashboard, for deciding what to offer. */
interface Me {
  id: string;
  role: string;
}

const isReviewer = (me: Me | null) =>
  me?.role === 'Supervisor' || me?.role === 'Administrator';

function useSession() {
  const [state, setState] = useState<'checking' | 'in' | 'out'>('checking');
  useEffect(() => {
    getSession()
      .then((s) => setState(s ? 'in' : 'out'))
      .catch(() => setState('out'));
  }, []);
  return [state, setState] as const;
}

function SignIn({ onIn }: { onIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      onIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm flex flex-col gap-3">
        <h1 className="text-2xl font-black tracking-tight">Drilling Records</h1>
        <p className="text-sm text-slate-400 font-semibold mb-3">
          Administrator sign-in.
        </p>
        {!isSupabaseConfigured() && (
          <div className="p-3 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 text-xs font-bold">
            No Supabase project is configured for this build.
          </div>
        )}
        <input
          type="email"
          required
          placeholder="Email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="p-3 rounded border-2 border-white/20 bg-black font-bold"
        />
        <input
          type="password"
          required
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="p-3 rounded border-2 border-white/20 bg-black font-bold"
        />
        {error && (
          <p className="text-xs font-bold text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded p-2">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="mt-1 py-3 rounded-lg bg-[#FFD700] text-black font-black uppercase tracking-wider disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-3">
      <div className="text-[10px] uppercase tracking-wider font-black text-slate-400">
        {label}
      </div>
      <div className={`text-xl font-black ${tone ?? 'text-white'}`}>{value}</div>
    </div>
  );
}

/** Minutes as "1 h 05 min" once they pass an hour, so long stoppages read at a glance. */
function formatMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

function PausedBadge({ pause }: { pause: AdminEvent }) {
  return (
    <span
      title={pause.title}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/50 text-amber-300 text-[11px] font-black uppercase whitespace-nowrap"
    >
      <Pause className="w-3 h-3 fill-current" />
      Paused since {new Date(pause.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </span>
  );
}

function EventPhoto({ event }: { event: AdminEvent }) {
  const [url, setUrl] = useState<string | null>(null);
  const [full, setFull] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (event.photoPath) {
      signedPhotoUrl(event.createdBy, event.photoPath, 'thumb').then((u) => {
        if (alive) setUrl(u);
      });
    }
    return () => {
      alive = false;
    };
  }, [event.photoPath, event.createdBy]);

  if (!event.photoPath) return <span className="text-slate-600">—</span>;
  if (!url) return <span className="text-slate-500 text-xs">loading…</span>;

  return (
    <>
      <img
        src={url}
        alt="Site photo"
        title="Click to view full size"
        onClick={async () => setFull(await signedPhotoUrl(event.createdBy, event.photoPath!, 'full'))}
        className="h-12 w-16 object-cover rounded border border-slate-600 cursor-zoom-in"
      />
      {full && (
        <div
          onClick={() => setFull(null)}
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-6 cursor-zoom-out"
        >
          <img src={full} alt="Site photo, full size" className="max-h-full max-w-full rounded" />
        </div>
      )}
    </>
  );
}

function BoreholeDetail({
  borehole,
  profiles,
  me,
  onBack,
}: {
  borehole: AdminBorehole;
  profiles: Map<string, Profile>;
  me: Me | null;
  onBack: () => void;
}) {
  const [pipes, setPipes] = useState<AdminPipeRecord[] | null>(null);
  const [events, setEvents] = useState<AdminEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminPipeRecord | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchPipeRecords(borehole.id), fetchEvents(borehole.id)])
      .then(([p, e]) => {
        if (!alive) return;
        setPipes(p);
        setEvents(e);
      })
      .catch((err) => alive && setError(String(err)));
    return () => {
      alive = false;
    };
  }, [borehole.id, reloadKey]);

  const canEdit = (p: AdminPipeRecord) =>
    !p.deletedAt && (isReviewer(me) || p.createdBy === me?.id);

  const live = (pipes ?? []).filter((p) => !p.deletedAt);
  const depth = measuredDepth(pipes ?? []);
  const nptMinutes = (events ?? [])
    .filter((e) => !e.deletedAt && e.isNPT)
    .reduce((s, e) => s + (e.durationMinutes ?? 0), 0);
  const drillSeconds = live.reduce((s, p) => s + p.durationSeconds, 0);
  const avgRate = drillSeconds > 0 ? depth / (drillSeconds / 3600) : 0;
  const strikes = live.filter((p) => p.waterStrike);
  const ongoingPause = (events ?? []).find(isOngoingPause);

  const exportable = useMemo(
    () => ({ ...borehole, currentDepth: depth }),
    [borehole, depth]
  );

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="border-b border-slate-800 bg-slate-900 px-6 py-4 flex items-center gap-4 flex-wrap">
        <button onClick={onBack} className="flex items-center gap-1.5 text-slate-300 font-bold text-sm">
          <ArrowLeft className="w-4 h-4" /> All boreholes
        </button>
        <h1 className="text-lg font-black">{borehole.name}</h1>
        <span className="text-xs text-slate-400 font-semibold">
          {borehole.project} · {borehole.client} · {borehole.rigName}
        </span>
        <span className="text-xs text-slate-400 font-semibold ml-auto">
          Logged by {profiles.get(borehole.createdBy)?.name ?? 'unknown'}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() =>
              generateShiftReportPDF(exportable, live, (events ?? []).filter((e) => !e.deletedAt))
            }
            className="flex items-center gap-1.5 px-3 py-2 rounded bg-slate-800 border border-slate-600 text-xs font-black uppercase"
          >
            <FileText className="w-4 h-4" /> PDF
          </button>
          <button
            onClick={() =>
              generateBoreholeExcelReport(exportable, live, (events ?? []).filter((e) => !e.deletedAt))
            }
            className="flex items-center gap-1.5 px-3 py-2 rounded bg-[#FFD700] text-black text-xs font-black uppercase"
          >
            <Download className="w-4 h-4" /> Excel
          </button>
        </div>
      </header>

      {error && (
        <div className="m-6 p-3 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 text-sm font-bold">
          {error}
        </div>
      )}

      <div className="p-6 grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Measured depth" value={`${depth.toFixed(2)} m`} />
        <Stat label="Target" value={`${borehole.targetDepth} m`} />
        <Stat label="Pipes" value={String(live.length)} />
        <Stat label="Avg rate" value={`${avgRate.toFixed(1)} m/hr`} />
        <Stat
          label="Downtime"
          value={`${(nptMinutes / 60).toFixed(1)} hrs`}
          tone={nptMinutes > 0 ? 'text-rose-400' : undefined}
        />
      </div>

      {ongoingPause && (
        <div className="mx-6 mb-4 p-3 rounded border border-amber-500/50 bg-amber-500/10 text-amber-200 text-sm font-bold flex items-center gap-2 flex-wrap">
          <Pause className="w-4 h-4 fill-current" />
          Drilling paused on pipe #{ongoingPause.details.pipeNumber ?? '?'} since{' '}
          {new Date(ongoingPause.timestamp).toLocaleString()} ·{' '}
          {ongoingPause.details.pauseReason ?? ongoingPause.title}
          {ongoingPause.details.notes ? ` · "${ongoingPause.details.notes}"` : ''}
          <span className="text-amber-300/70 font-semibold">
            — {ongoingPause.operator}. As of the rig&apos;s last upload.
          </span>
        </div>
      )}

      {strikes.length > 0 && (
        <div className="mx-6 mb-4 p-3 rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 text-sm font-bold">
          Water struck at{' '}
          {strikes.map((s) => `${s.endDepth.toFixed(1)}m`).join(', ')}
          {strikes[0].waterStrikeDetails?.flowRateLpm
            ? ` · ${strikes[0].waterStrikeDetails.flowRateLpm} L/min`
            : ''}
        </div>
      )}

      <section className="px-6 pb-8">
        <h2 className="text-sm font-black uppercase tracking-wider text-slate-400 mb-2">
          Pipe log {pipes ? `(${live.length})` : ''}
        </h2>
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400 text-[11px] uppercase tracking-wider">
              <tr>
                {['#', 'Interval', 'Length', 'Drilling', 'Paused', 'Rate', 'Formation', 'Bit', 'Water', 'PSI', 'Operator', 'Remarks', ''].map(
                  (h) => (
                    <th key={h} className="text-left p-2.5 font-black whitespace-nowrap">
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {(pipes ?? []).map((p) => (
                <tr
                  key={p.id}
                  className={p.deletedAt ? 'line-through opacity-40' : 'hover:bg-slate-900/60'}
                  title={p.deletedAt ? `Deleted ${new Date(p.deletedAt).toLocaleString()}` : undefined}
                >
                  <td className="p-2.5 font-black">#{p.pipeNumber}</td>
                  <td className="p-2.5 whitespace-nowrap font-mono text-xs">
                    {p.startDepth.toFixed(1)}–{p.endDepth.toFixed(1)}m
                  </td>
                  <td className="p-2.5">{p.pipeLength.toFixed(2)}m</td>
                  <td className="p-2.5 whitespace-nowrap">{Math.round(p.durationSeconds / 60)} min</td>
                  <td
                    className={`p-2.5 whitespace-nowrap ${p.pausedSeconds ? 'text-amber-300 font-bold' : 'text-slate-600'}`}
                    title={p.pauses?.map((x) => x.reason).join(', ')}
                  >
                    {p.pausedSeconds
                      ? `${formatMinutes(Math.max(1, Math.round(p.pausedSeconds / 60)))}${
                          (p.pauses?.length ?? 0) > 1 ? ` (${p.pauses!.length}×)` : ''
                        }`
                      : '—'}
                  </td>
                  <td className="p-2.5 whitespace-nowrap">{p.penetrationRate.toFixed(1)} m/hr</td>
                  <td className="p-2.5 whitespace-nowrap">{p.formation}</td>
                  <td className="p-2.5 whitespace-nowrap text-xs">
                    {p.bitType} {p.bitDiameter ? `${p.bitDiameter}"` : ''}
                  </td>
                  <td className="p-2.5">{p.waterStrike ? 'YES' : '—'}</td>
                  <td className="p-2.5 whitespace-nowrap">
                    {p.airPressure}/{p.compressorPressure}
                  </td>
                  <td className="p-2.5 whitespace-nowrap">{p.operator}</td>
                  <td className="p-2.5 max-w-xs">
                    {p.remarks || <span className="text-slate-600">—</span>}
                    {p.editedAt && (
                      <div className="text-[11px] text-blue-300 font-semibold mt-0.5">
                        Edited by {profiles.get(p.editedBy ?? '')?.name ?? 'unknown'} ·{' '}
                        {new Date(p.editedAt).toLocaleString()}
                      </div>
                    )}
                  </td>
                  <td className="p-2.5 text-right">
                    {canEdit(p) && (
                      <button
                        onClick={() => setEditing(p)}
                        aria-label={`Edit pipe ${p.pipeNumber}`}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-800 border border-slate-600 text-xs font-black uppercase hover:border-blue-400"
                      >
                        <Pencil className="w-3.5 h-3.5" /> Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {pipes && pipes.length === 0 && (
                <tr>
                  <td colSpan={13} className="p-6 text-center text-slate-500">
                    No pipe records have reached the server for this borehole yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <EditPipeModal
        isOpen={editing !== null}
        onClose={() => setEditing(null)}
        record={editing}
        onSave={async (correction) => {
          if (!editing) return;
          await savePipeCorrection(editing, correction);
          setReloadKey((k) => k + 1);
        }}
        sunlightMode={false}
      />

      <section className="px-6 pb-12">
        <h2 className="text-sm font-black uppercase tracking-wider text-slate-400 mb-2">
          Downtime &amp; events {events ? `(${events.filter((e) => !e.deletedAt).length})` : ''}
        </h2>
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400 text-[11px] uppercase tracking-wider">
              <tr>
                {['When', 'Type', 'Title', 'Depth', 'Duration', 'Downtime', 'Operator', 'Photo'].map((h) => (
                  <th key={h} className="text-left p-2.5 font-black whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {(events ?? []).map((e) => (
                <tr key={e.id} className={e.deletedAt ? 'line-through opacity-40' : 'hover:bg-slate-900/60'}>
                  <td className="p-2.5 whitespace-nowrap text-xs">
                    {new Date(e.timestamp).toLocaleString()}
                  </td>
                  <td className="p-2.5 whitespace-nowrap">{e.type}</td>
                  <td className="p-2.5">{e.title}</td>
                  <td className="p-2.5 whitespace-nowrap">{e.depthAtEvent?.toFixed(1)}m</td>
                  <td className="p-2.5 whitespace-nowrap">
                    {isOngoingPause(e) ? (
                      <span className="text-amber-300 font-black uppercase text-xs">Ongoing</span>
                    ) : e.durationMinutes ? (
                      formatMinutes(e.durationMinutes)
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className={`p-2.5 font-black ${e.isNPT ? 'text-rose-400' : 'text-slate-500'}`}>
                    {e.isNPT ? 'YES' : '—'}
                  </td>
                  <td className="p-2.5 whitespace-nowrap">{e.operator}</td>
                  <td className="p-2.5">
                    <EventPhoto event={e} />
                  </td>
                </tr>
              ))}
              {events && events.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-slate-500">
                    No events logged.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function BoreholeList({
  onOpen,
  profiles,
  onSignOut,
  onOpenCrew,
}: {
  onOpen: (b: AdminBorehole) => void;
  profiles: Map<string, Profile>;
  onSignOut: () => void;
  /** Absent for Supervisors: managing accounts stays with Administrators. */
  onOpenCrew?: () => void;
}) {
  const [rows, setRows] = useState<AdminBorehole[] | null>(null);
  const [pauses, setPauses] = useState<Map<string, AdminEvent>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    // A failed pause lookup must not hide the boreholes themselves.
    fetchOngoingPauses().then(setPauses).catch(() => setPauses(new Map()));
    fetchBoreholes()
      .then(setRows)
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  }, []);

  useEffect(load, [load]);

  const filtered = (rows ?? []).filter((b) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [b.name, b.project, b.client, b.rigName, profiles.get(b.createdBy)?.name ?? '']
      .join(' ')
      .toLowerCase()
      .includes(q);
  });

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="border-b border-slate-800 bg-slate-900 px-6 py-4 flex items-center gap-4 flex-wrap">
        <h1 className="text-lg font-black">Drilling Records</h1>
        <span className="text-xs text-slate-400 font-semibold">
          Every borehole reported from the field
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-slate-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search project, client, rig, driller…"
              className="pl-8 pr-3 py-2 rounded bg-slate-800 border border-slate-700 text-sm w-72"
            />
          </div>
          <button
            onClick={load}
            disabled={busy}
            title="Reload"
            className="p-2 rounded bg-slate-800 border border-slate-700 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
          </button>
          {onOpenCrew && (
            <button
              onClick={onOpenCrew}
              className="flex items-center gap-1.5 px-3 py-2 rounded bg-slate-800 border border-slate-700 text-xs font-black uppercase"
            >
              <Users className="w-4 h-4" /> Crew
            </button>
          )}
          <button
            onClick={onSignOut}
            className="flex items-center gap-1.5 px-3 py-2 rounded bg-slate-800 border border-slate-700 text-xs font-black uppercase"
          >
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>
      </header>

      {error && (
        <div className="m-6 p-3 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 text-sm font-bold">
          {error}
        </div>
      )}

      <div className="p-6">
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400 text-[11px] uppercase tracking-wider">
              <tr>
                {['Borehole', 'Project', 'Client', 'Rig', 'Depth / Target', 'Status', 'Created by', 'Last received'].map(
                  (h) => (
                    <th key={h} className="text-left p-3 font-black whitespace-nowrap">
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filtered.map((b) => (
                <tr
                  key={b.id}
                  onClick={() => onOpen(b)}
                  className={`cursor-pointer hover:bg-slate-900/60 ${b.deletedAt ? 'line-through opacity-40' : ''}`}
                >
                  <td className="p-3 font-black">{b.name}</td>
                  <td className="p-3">{b.project}</td>
                  <td className="p-3">{b.client}</td>
                  <td className="p-3 whitespace-nowrap">{b.rigName}</td>
                  <td className="p-3 whitespace-nowrap">
                    {b.currentDepth.toFixed(1)} / {b.targetDepth} m
                  </td>
                  <td className="p-3 uppercase text-xs font-black">
                    {pauses.get(b.id) ? <PausedBadge pause={pauses.get(b.id)!} /> : b.status}
                  </td>
                  <td className="p-3 whitespace-nowrap">
                    {profiles.get(b.createdBy)?.name ?? '—'}
                  </td>
                  <td className="p-3 whitespace-nowrap text-xs text-slate-400">
                    {new Date(b.receivedAt).toLocaleString()}
                  </td>
                </tr>
              ))}
              {rows && filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-slate-500">
                    {rows.length === 0
                      ? 'No boreholes have synced from the field yet.'
                      : 'No boreholes match that search.'}
                  </td>
                </tr>
              )}
              {!rows && !error && (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-slate-500">
                    Loading…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function AdminApp() {
  const [session, setSession] = useSession();
  const [selected, setSelected] = useState<AdminBorehole | null>(null);
  const [showCrew, setShowCrew] = useState(false);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    if (session !== 'in') return;
    fetchProfiles().then(setProfiles).catch(() => {});
    fetchMyProfile()
      .then((p) => setMe(p ? { id: p.id, role: p.role } : null))
      .catch(() => setMe(null));
  }, [session]);

  if (session === 'checking') {
    return <div className="min-h-screen bg-slate-950 text-slate-500 grid place-items-center">Loading…</div>;
  }
  if (session === 'out') return <SignIn onIn={() => setSession('in')} />;

  if (showCrew) return <CrewView onBack={() => setShowCrew(false)} />;

  if (selected) {
    return (
      <BoreholeDetail
        borehole={selected}
        profiles={profiles}
        me={me}
        onBack={() => setSelected(null)}
      />
    );
  }
  return (
    <BoreholeList
      profiles={profiles}
      onOpen={setSelected}
      onOpenCrew={me?.role === 'Administrator' ? () => setShowCrew(true) : undefined}
      onSignOut={async () => {
        await signOut();
        setSession('out');
      }}
    />
  );
}
