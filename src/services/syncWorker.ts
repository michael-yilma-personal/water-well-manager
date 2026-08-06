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

export interface SyncWorkerDeps {
  outbox: Outbox;
  transport: OutboxTransport;
  /** Notified after every drain so the UI can refresh its pending count. */
  onChange?: (result: DrainResult) => void;
}

export class SyncWorker {
  private readonly deps: SyncWorkerDeps;
  private running = false;
  private draining = false;
  private teardown: Array<() => void> = [];

  constructor(deps: SyncWorkerDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const netHandle = await Network.addListener('networkStatusChange', (status) => {
      if (status.connected) void this.syncNow();
    });
    this.teardown.push(() => void netHandle.remove());

    const appHandle = await CapacitorApp.addListener('resume', () => {
      void this.syncNow();
    });
    this.teardown.push(() => void appHandle.remove());

    // Catch up on whatever accumulated while the app was closed.
    void this.syncNow();
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
