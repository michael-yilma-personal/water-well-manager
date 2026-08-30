/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Network } from '@capacitor/network';
import { App as CapacitorApp } from '@capacitor/app';
import type { DrainResult, Outbox, OutboxTransport } from './outbox';

/**
 * Decides when to drain the outbox.
 *
 * Connectivity comes from @capacitor/network rather than `navigator.onLine`,
 * which reports "online" for a WiFi association that has no route to anywhere -
 * exactly the situation at a site with a rig-side access point and no uplink.
 *
 * Nothing here runs while the app is closed. Capacitor has no background sync
 * without additional plugins, so a phone in a pocket does not upload overnight;
 * it catches up the moment the driller opens the app.
 */

/** Collapse a burst of saves into a single drain. */
const ENQUEUE_DEBOUNCE_MS = 1200;

/**
 * Safety net for a missed connectivity event.
 *
 * The drain is normally triggered by networkStatusChange, but that event is not
 * guaranteed - it was observed not firing at all when an Android device's
 * radios came back, leaving a full queue sitting next to a working connection
 * with nothing to wake it. On a rig that means a day's records staying on the
 * phone until someone happens to reopen the app.
 *
 * This costs nothing when the queue is empty, which is almost always.
 */
const RETRY_INTERVAL_MS = 60_000;

/**
 * How often to ask the server what it has that this device does not.
 *
 * Less frequent than the upload retry: a missed upload is a record that exists
 * nowhere else, while a missed download is a record that is already safe and
 * merely late. Network-regained, app-resume and launch all pull immediately, so
 * this only covers a device left open and idle on the rig.
 */
const PULL_INTERVAL_MS = 5 * 60_000;

export interface SyncWorkerDeps {
  outbox: Outbox;
  transport: OutboxTransport;
  /** Notified after every drain so the UI can refresh its pending count. */
  onChange?: (result: DrainResult) => void;
  /**
   * Fetch and merge whatever this account has on the server. Optional so an
   * unconfigured build, and the existing tests, need not provide one.
   */
  pull?: () => Promise<boolean>;
  /** Notified after a pull actually merged, so the UI can re-read storage. */
  onPulled?: () => void;
}

export class SyncWorker {
  private readonly deps: SyncWorkerDeps;
  private running = false;
  private draining = false;
  private teardown: Array<() => void> = [];
  private pendingNudge: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private pullTicker: ReturnType<typeof setInterval> | null = null;
  private pulling = false;

  constructor(deps: SyncWorkerDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const netHandle = await Network.addListener('networkStatusChange', (status) => {
      if (!status.connected) return;
      void this.syncNow();
      void this.pullNow();
    });
    this.teardown.push(() => void netHandle.remove());

    const appHandle = await CapacitorApp.addListener('resume', () => {
      void this.syncNow();
      // Coming back to the app is the moment a driller expects to see what the
      // rest of the crew logged while this phone was in a pocket.
      void this.pullNow();
    });
    this.teardown.push(() => void appHandle.remove());

    // Upload as work arrives. A short debounce collapses a burst of saves -
    // ending a pipe writes the record and its borehole - into one drain.
    const unsubscribe = this.deps.outbox.subscribe(() => {
      if (this.pendingNudge !== null) clearTimeout(this.pendingNudge);
      this.pendingNudge = setTimeout(() => {
        this.pendingNudge = null;
        void this.syncNow();
      }, ENQUEUE_DEBOUNCE_MS);
    });
    this.teardown.push(() => {
      unsubscribe();
      if (this.pendingNudge !== null) clearTimeout(this.pendingNudge);
      this.pendingNudge = null;
    });

    this.ticker = setInterval(() => {
      if (this.deps.outbox.depth() > 0) void this.syncNow();
    }, RETRY_INTERVAL_MS);
    this.teardown.push(() => {
      if (this.ticker !== null) clearInterval(this.ticker);
      this.ticker = null;
    });

    this.pullTicker = setInterval(() => void this.pullNow(), PULL_INTERVAL_MS);
    this.teardown.push(() => {
      if (this.pullTicker !== null) clearInterval(this.pullTicker);
      this.pullTicker = null;
    });

    // Catch up on whatever accumulated while the app was closed - in both
    // directions. A device signing in for the first time has an empty queue and
    // an empty store, so the pull is the only thing with anything to do.
    void this.syncNow();
    void this.pullNow();
  }

  /**
   * Fetch this account's server-side work and merge it in.
   *
   * Unlike syncNow this is not gated on queue depth: the case that matters most
   * is a freshly linked device, where the outbox is empty and everything the
   * driller is looking for is on the server.
   */
  async pullNow(): Promise<boolean> {
    if (!this.deps.pull) return false;
    if (this.pulling) return false;

    const status = await Network.getStatus().catch(() => ({ connected: true }));
    if (!status.connected) return false;

    this.pulling = true;
    try {
      const merged = await this.deps.pull();
      if (merged) this.deps.onPulled?.();
      return merged;
    } catch {
      // A failed download is not lost data - the rows are still on the server
      // and the watermark has not moved, so the next tick tries the same window.
      return false;
    } finally {
      this.pulling = false;
    }
  }

  stop(): void {
    this.running = false;
    for (const off of this.teardown) off();
    this.teardown = [];
  }

  /**
   * Drain now if connected. Safe to call from anywhere; overlapping calls
   * collapse into the one already in flight so a burst of saves does not fire
   * several concurrent drains over a weak link.
   */
  async syncNow(): Promise<DrainResult> {
    const idle: DrainResult = { sent: 0, failed: 0, parked: 0 };
    if (this.draining) return idle;
    if (this.deps.outbox.depth() === 0) return idle;

    const status = await Network.getStatus().catch(() => ({ connected: true }));
    if (!status.connected) return idle;

    this.draining = true;
    try {
      const result = await this.deps.outbox.drain(this.deps.transport);
      this.deps.onChange?.(result);
      return result;
    } finally {
      this.draining = false;
    }
  }
}
