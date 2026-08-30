/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Append-only queue of mutations waiting to reach the server.
 *
 * A rig phone may be offline for days, so writes never touch the network on the
 * UI path: they land in localStorage and are enqueued here. A worker drains the
 * queue whenever connectivity returns.
 *
 * Two properties matter more than throughput:
 *
 *  - **Nothing is discarded.** An operation that keeps failing is parked with
 *    its payload intact, never dropped. Losing a borehole log is worse than
 *    surfacing an error.
 *  - **No head-of-line blocking.** A 300KB photo failing on a bad connection
 *    must not hold up the 2KB pipe records behind it, so each item carries its
 *    own attempt count and backoff.
 */

const STORAGE_KEY = 'wwdm_outbox';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Give up retrying automatically after this many failures and park the item. */
export const MAX_ATTEMPTS = 8;

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 6 * 3600 * 1000; // 6 hours

export type OutboxOp = 'upsert' | 'delete' | 'upload';

export type OutboxEntity =
  | 'borehole'
  | 'pipeRecord'
  | 'event'
  | 'shiftLog'
  | 'photo';

export interface OutboxItem {
  /** Identifier of the operation itself, distinct from the record it carries. */
  id: string;
  op: OutboxOp;
  entity: OutboxEntity;
  /** UUID of the record being sent; the server upserts on this. */
  entityId: string;
  payload: unknown;
  attempts: number;
  lastError?: string;
  enqueuedAt: string;
  /** Epoch ms before which this item should not be retried. */
  nextAttemptAt: number;
  /** Exhausted its retries; held for recovery rather than deleted. */
  parked?: boolean;
}

export type OutboxTransport = (item: OutboxItem) => Promise<void>;

/**
 * A failure that retrying cannot fix - the row belongs to another user, or it
 * violates a constraint. Backing off for days before surfacing it just delays
 * the moment someone can act, so these park on the first attempt.
 */
export class PermanentSyncError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSyncError';
  }
}

function isPermanent(err: unknown): boolean {
  return (err as { permanent?: boolean } | null)?.permanent === true;
}

export interface DrainResult {
  sent: number;
  failed: number;
  parked: number;
}

function newId(): string {
  // Available in browsers, the Android WebView (https://localhost is a secure
  // context), and Node 19+.
  return crypto.randomUUID();
}

/** Demo seed rows are identical on every install and must never reach the server. */
function isDemoPayload(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { isDemo?: unknown }).isDemo === true
  );
}

export class Outbox {
  private items: OutboxItem[];
  private listeners = new Set<() => void>();

  constructor() {
    this.items = this.read();
  }

  /**
   * Notified whenever work is added.
   *
   * Without this the queue only drained on a network change, an app resume, or
   * a manual tap - so a device that was already online when the driller started
   * logging would accumulate records all day and upload none of them.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A misbehaving listener must not break the write path.
      }
    }
  }

  private read(): OutboxItem[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? (parsed as OutboxItem[]) : [];
    } catch {
      // A corrupt queue must not brick the app; better to lose the queue than
      // to prevent the driller from logging anything at all.
      return [];
    }
  }

  private write(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.items));
  }

  /**
   * Queue a mutation. Returns the stored item, or null when the write was
   * deliberately not queued (demo data).
   */
  enqueue(
    op: OutboxOp,
    entity: OutboxEntity,
    entityId: string,
    payload: unknown
  ): OutboxItem | null {
    if (isDemoPayload(payload)) return null;

    // The server's primary keys are uuid columns, so a hand-rolled id shaped
    // like `bh-1786022504143` is rejected outright and the record - plus
    // everything referencing it - can never sync. Catching it here turns a
    // silent, permanent sync failure into an obvious one at the point of the
    // mistake.
    if (!UUID_RE.test(entityId)) {
      console.error(
        `[outbox] refusing to queue ${entity} with non-uuid id "${entityId}". ` +
          `Use createRecordId(); the server will not accept this.`
      );
      return null;
    }

    if (op === 'delete') {
      // A record deleted before its upsert went out has nothing worth sending
      // first; uploading state we are about to retract wastes a metered
      // connection. The delete itself is still queued, because an earlier drain
      // may already have delivered the record - and a soft delete is idempotent
      // either way.
      this.items = this.items.filter(
        (i) => !(i.entity === entity && i.entityId === entityId && i.op === 'upsert')
      );
    } else if (op === 'upsert') {
      // Only the final state of a record matters to an upsert, so collapse
      // repeated edits into the existing queue slot and keep its position.
      const existing = this.items.find(
        (i) => i.entity === entity && i.entityId === entityId && i.op === 'upsert' && !i.parked
      );
      if (existing) {
        existing.payload = payload;
        this.write();
        this.notify();
        return existing;
      }
    }

    const item: OutboxItem = {
      id: newId(),
      op,
      entity,
      entityId,
      payload,
      attempts: 0,
      enqueuedAt: new Date().toISOString(),
      nextAttemptAt: 0,
    };
    this.items.push(item);
    this.write();
    this.notify();
    return item;
  }

  /** Operations still waiting to be sent, oldest first. Excludes parked work. */
  pending(): OutboxItem[] {
    return this.items.filter((i) => !i.parked);
  }

  /** Count shown in the header's offline badge. */
  depth(): number {
    return this.pending().length;
  }

  /** Operations that exhausted their retries and need attention. */
  parked(): OutboxItem[] {
    return this.items.filter((i) => i.parked);
  }

  /**
   * Throw away work that was given up on, keeping everything still retryable.
   *
   * Only for handing the phone to another driller. A parked record cannot be
   * uploaded by this account - that is what parked it - and carrying it into
   * the next session would credit this driller's work to whoever signs in
   * next, since created_by is stamped when a record drains rather than when it
   * was logged.
   */
  discardParked(): void {
    this.items = this.items.filter((item) => !item.parked);
    this.write();
  }

  /** Re-arm parked work, e.g. after the user fixes a server-side problem. */
  retryParked(): void {
    for (const item of this.items) {
      if (item.parked) {
        item.parked = false;
        item.attempts = 0;
        item.nextAttemptAt = 0;
      }
    }
    this.write();
  }

  /**
   * Attempt every item whose backoff has elapsed, oldest first.
   *
   * Each item is attempted independently: one failure does not abort the drain,
   * which is what keeps a stuck photo from blocking the rest of the queue.
   */
  async drain(transport: OutboxTransport, now: number = Date.now()): Promise<DrainResult> {
    const result: DrainResult = { sent: 0, failed: 0, parked: 0 };
    const due = this.items.filter((i) => !i.parked && i.nextAttemptAt <= now);

    for (const item of due) {
      try {
        await transport(item);
        this.items = this.items.filter((i) => i.id !== item.id);
        result.sent++;
      } catch (err) {
        item.attempts++;
        item.lastError = err instanceof Error ? err.message : String(err);
        if (isPermanent(err) || item.attempts >= MAX_ATTEMPTS) {
          item.parked = true;
          result.parked++;
        } else {
          item.nextAttemptAt = now + backoffFor(item.attempts);
        }
        result.failed++;
      }
    }

    this.write();
    return result;
  }

  /** Test/debug helper. */
  clear(): void {
    this.items = [];
    this.write();
  }
}

function backoffFor(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
}
