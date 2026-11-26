import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseTransport } from './syncTransport';
import * as outboxModule from './outbox';
import { NoSessionError, type OutboxItem } from './outbox';
import type { PipeRecord } from '../types';

const UID = '11111111-2222-3333-4444-555555555555';

function pipe(): PipeRecord {
  return {
    id: 'bbbbbbbb-0000-0000-0000-000000000001',
    boreholeId: 'aaaaaaaa-0000-0000-0000-000000000001',
    pipeNumber: 3,
    startDepth: 9.1,
    endDepth: 13.65,
    pipeLength: 4.55,
    startTime: '2026-08-05T08:00:00.000Z',
    endTime: '2026-08-05T08:19:00.000Z',
    durationSeconds: 1140,
    penetrationRate: 14.2,
    formation: 'Soft Clay',
    waterStrike: false,
    airPressure: 252,
    compressorPressure: 211,
    bitType: 'DTH Hammer - Button Bit',
    bitDiameter: 8.5,
    operator: 'James Wanjala',
    gpsCoordinates: { lat: -1.31, lng: 36.78 },
    remarks: '',
    synced: false,
  };
}

function item(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: 'op-1',
    op: 'upsert',
    entity: 'pipeRecord',
    entityId: pipe().id,
    payload: pipe(),
    attempts: 0,
    enqueuedAt: '2026-08-05T08:20:00.000Z',
    nextAttemptAt: 0,
    ...overrides,
  };
}

/** Minimal stand-in for the pieces of the Supabase client the transport uses. */
function fakeClient() {
  const calls: { table: string; op: string; arg: unknown; eq?: unknown }[] = [];
  let nextError: { code?: string; message: string } | null = null;
  let matched: number | null = 1;
  return {
    calls,
    /** How many rows the next update matches (P3-3). */
    matchRows(n: number | null) {
      matched = n;
    },
    failWith(err: { code?: string; message: string }) {
      nextError = err;
    },
    client: {
      from(table: string) {
        return {
          upsert(row: unknown) {
            calls.push({ table, op: 'upsert', arg: row });
            return Promise.resolve({ error: nextError });
          },
          update(patch: unknown) {
            return {
              eq(_col: string, val: unknown) {
                calls.push({ table, op: 'update', arg: patch, eq: val });
                // The rows the update touched, whichever way the transport asks:
                // `count` on the answer, or `data` after a chained .select().
                const answer = { error: nextError, data: matched === null ? null : matched ? [{ id: val }] : [], count: matched };
                return Object.assign(Promise.resolve(answer), { select: () => Promise.resolve(answer) });
              },
            };
          },
        };
      },
    },
  };
}

test('an upsert lands in the right table with the author stamped on it', async () => {
  const fake = fakeClient();
  const send = createSupabaseTransport({
    getClient: () => fake.client as never,
    getUserId: async () => UID,
  });

  await send(item());

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].table, 'pipe_records');
  assert.equal(fake.calls[0].op, 'upsert');
  const row = fake.calls[0].arg as Record<string, unknown>;
  assert.equal(row.created_by, UID);
  assert.equal(row.pipe_number, 3);
});

test('a delete becomes a soft delete so the audit trail survives', async () => {
  const fake = fakeClient();
  const send = createSupabaseTransport({
    getClient: () => fake.client as never,
    getUserId: async () => UID,
    now: () => '2026-08-05T12:00:00.000Z',
  });

  await send(item({ op: 'delete' }));

  assert.equal(fake.calls[0].op, 'update');
  assert.deepEqual(fake.calls[0].arg, { deleted_at: '2026-08-05T12:00:00.000Z' });
  assert.equal(fake.calls[0].eq, pipe().id);
});

test('no session is a transient failure - the driller logged offline for days', async () => {
  const fake = fakeClient();
  const send = createSupabaseTransport({
    getClient: () => fake.client as never,
    getUserId: async () => null,
  });

  await assert.rejects(send(item()), (err: Error) => {
    assert.match(err.message, /no active session/);
    assert.ok(err instanceof NoSessionError, 'not counted as an attempt (RF-125)');
    assert.notEqual((err as { permanent?: boolean }).permanent, true, 'must retry, not park');
    return true;
  });
  assert.equal(fake.calls.length, 0, 'nothing sent without an identity');
});

test('an RLS rejection is permanent - another rig owns that row', async () => {
  const fake = fakeClient();
  fake.failWith({ code: '42501', message: 'new row violates row-level security policy' });
  const send = createSupabaseTransport({
    getClient: () => fake.client as never,
    getUserId: async () => UID,
  });

  await assert.rejects(send(item()), (err: Error) => {
    assert.equal((err as { permanent?: boolean }).permanent, true);
    return true;
  });
});

test('a network blip is transient and retried', async () => {
  const fake = fakeClient();
  fake.failWith({ message: 'fetch failed' });
  const send = createSupabaseTransport({
    getClient: () => fake.client as never,
    getUserId: async () => UID,
  });

  await assert.rejects(send(item()), (err: Error) => {
    assert.notEqual((err as { permanent?: boolean }).permanent, true);
    return true;
  });
});

test('an unconfigured build fails without pretending to sync', async () => {
  const send = createSupabaseTransport({
    getClient: () => null,
    getUserId: async () => UID,
  });
  await assert.rejects(send(item()), /not configured/);
});

// --- P2-5: queued work carries its organization ------------------------------

const ORG = '99999999-0000-4000-8000-000000000001';

async function sentRow(over: Partial<OutboxItem> & { orgId?: string }) {
  const fake = fakeClient();
  const send = createSupabaseTransport({
    getClient: () => fake.client as never,
    getUserId: async () => UID,
  });
  await send(item(over));
  assert.equal(fake.calls.length, 1);
  return fake.calls[0].arg as Record<string, unknown>;
}

const boreholeItem = {
  entity: 'borehole' as const,
  entityId: 'aaaaaaaa-0000-0000-0000-000000000001',
  payload: { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'BH-1' },
};

test('a borehole is sent under the organization it was captured in', async () => {
  const row = await sentRow({ ...boreholeItem, orgId: ORG });
  assert.equal(row.org_id, ORG);
  assert.equal(row.created_by, UID, 'the author is still stamped');
});

test('a borehole queued before the update is sent with no org_id at all', async () => {
  const row = await sentRow(boreholeItem);
  assert.equal('org_id' in row, false, JSON.stringify(Object.keys(row)));
});

test('a child row never carries org_id, even when its item has an organization', async () => {
  const row = await sentRow({ orgId: ORG });
  assert.equal('org_id' in row, false, 'the database takes it from the borehole');
});

// --- P3-3: the subscription refuses, the work is held (criteria 2, 4) ---------
// Assumed: SubscriptionHeldError exported by outbox.ts (see outbox.test.ts), and
// TransportDeps gains  getAccess?: () => 'full' | 'read_only' | 'none' | null
// (the cached access of the active organization; absent or null means full).
// The deps are cast so this file type-checks before the field exists.

const held = () => (outboxModule as unknown as { SubscriptionHeldError: new (m: string) => Error }).SubscriptionHeldError;

test('a write refused with SS002 is held for renewal, not parked', async () => {
  const fake = fakeClient();
  fake.failWith({ code: 'SS002', message: 'subscription does not allow writes' });
  const send = createSupabaseTransport({ getClient: () => fake.client as never, getUserId: async () => UID });

  await assert.rejects(send(item()), (err: Error) => {
    assert.ok(err instanceof held(), `${err.name}: ${err.message}`);
    assert.notEqual((err as { permanent?: boolean }).permanent, true);
    return true;
  });
});

test('a soft delete that matched no row is unsent while access is none, and sent otherwise (RF-142)', async () => {
  const sendDelete = (access: string) => {
    const fake = fakeClient();
    fake.matchRows(0);
    const send = createSupabaseTransport(
      { getClient: () => fake.client as never, getUserId: async () => UID, getAccess: () => access } as never
    );
    return send(item({ op: 'delete' }));
  };

  await assert.rejects(sendDelete('none'), (err: Error) => err instanceof held());
  // Deleting a record that never reached the server matches nothing either, and is done.
  await sendDelete('full');
});

// Review of P3-3. Assumed: TransportDeps gains
//   refreshAccess?: () => Promise<'full' | 'read_only' | 'none' | null>
// (reads the access level from the server; rejects when it cannot be read).

function deleteWith(deps: Record<string, unknown>, rows: number | null = 0) {
  const fake = fakeClient();
  fake.matchRows(rows);
  const send = createSupabaseTransport({ getClient: () => fake.client as never, getUserId: async () => UID, ...deps } as never);
  return send(item({ op: 'delete' }));
}

test('under none a soft delete whose answer carries no count is held, not sent', async () => {
  await assert.rejects(deleteWith({ getAccess: () => 'none' }, null), (err: Error) => err instanceof held());
});

test('a soft delete that matched no row while the cached access is full or unknown is decided on a fresh read', async () => {
  let asked = 0;
  const fresh = (answer: string | Error) => async () => {
    asked++;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const isHeld = (err: Error) => err instanceof held();

  await assert.rejects(deleteWith({ getAccess: () => 'full', refreshAccess: fresh('none') }), isHeld);
  await assert.rejects(deleteWith({ getAccess: () => null, refreshAccess: fresh('none') }), isHeld);
  await assert.rejects(deleteWith({ getAccess: () => 'full', refreshAccess: fresh(new Error('offline')) }), isHeld);
  await deleteWith({ getAccess: () => 'full', refreshAccess: fresh('full') });
  assert.equal(asked, 4, 'the fresh level was read each time');
});
