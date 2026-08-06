import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseTransport } from './syncTransport';
import type { OutboxItem } from './outbox';
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
  return {
    calls,
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
                return Promise.resolve({ error: nextError });
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
