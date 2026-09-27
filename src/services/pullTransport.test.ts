import assert from 'node:assert/strict';
import test from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createPullRunner, createSupabasePull, PULL_OVERLAP_MS } from './pullTransport';
import type { RemoteSnapshot } from './storage';

const UID = '11111111-2222-3333-4444-555555555555';

/**
 * Stand-in for the query builder the pull uses: from().select().gte().order().
 * Every method returns the builder, and the builder is awaitable, which is how
 * postgrest-js behaves.
 */
function fakeClient(rowsByTable: Record<string, unknown[]> = {}) {
  type Call = { table: string; gte?: unknown; gteCol?: string; eq: [string, unknown][]; orderCol?: string };
  const calls: Call[] = [];
  const client = {
    calls,
    from(table: string) {
      const call: Call = { table, eq: [] };
      calls.push(call);
      const builder: Record<string, unknown> = {
        select: () => builder,
        gte: (col: string, value: unknown) => {
          call.gte = value;
          call.gteCol = col;
          return builder;
        },
        eq: (col: string, value: unknown) => {
          call.eq.push([col, value]);
          return builder;
        },
        order: (col: string) => {
          call.orderCol = col;
          return builder;
        },
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: rowsByTable[table] ?? [], error: null }),
      };
      return builder;
    },
  };
  return client;
}

function boreholeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    name: 'BH-REMOTE',
    current_depth: 18.2,
    target_depth: 120,
    default_pipe_length: 4.55,
    status: 'active',
    created_by: UID,
    recorded_at: '2026-08-30T06:00:00.000Z',
    received_at: '2026-08-30T06:00:05.000Z',
    modified_at: '2026-08-30T06:00:05.000Z',
    deleted_at: null,
    ...over,
  };
}

function deps(client: unknown, userId: string | null = UID) {
  return {
    getClient: () => client as SupabaseClient | null,
    getUserId: async () => userId,
  };
}

test('the first pull asks for everything, with no lower bound', async () => {
  const client = fakeClient({ boreholes: [boreholeRow()] });
  const pull = createSupabasePull(deps(client));

  await pull(null);

  assert.equal(client.calls.length, 4, 'all four record tables are read');
  assert.equal(
    client.calls.every((c) => c.gte === undefined),
    true
  );
});

test('later pulls ask only for what arrived since the last one', async () => {
  const client = fakeClient();
  const pull = createSupabasePull(deps(client));
  const since = '2026-08-30T06:00:00.000Z';

  await pull(since);

  // A small overlap is re-requested deliberately: two rows committed in the
  // same instant can be assigned received_at out of order, and a strict
  // greater-than would step straight over the later one, forever.
  const expected = new Date(Date.parse(since) - PULL_OVERLAP_MS).toISOString();
  assert.equal(client.calls[0].gte, expected);
});

test('the pull follows modified_at, so a correction made after upload comes down', async () => {
  const client = fakeClient();
  const pull = createSupabasePull(deps(client));

  await pull('2026-08-30T06:00:00.000Z');

  // received_at is set once at insert; an office correction never moves it.
  assert.ok(client.calls.every((c) => c.gteCol === 'modified_at'));
  assert.ok(client.calls.every((c) => c.orderCol === 'modified_at'));
});

test('the pull asks only for the signed-in account\'s own records', async () => {
  const client = fakeClient();
  const pull = createSupabasePull(deps(client));

  await pull(null);

  // Supervisors can read every crew, for review on the dashboard. Their phone
  // must not download every crew's boreholes because of it.
  assert.ok(
    client.calls.every((c) => c.eq.some(([col, v]) => col === 'created_by' && v === UID)),
    JSON.stringify(client.calls)
  );
});

test('a record corrected after upload advances the watermark by its modified_at', async () => {
  const client = fakeClient({
    pipe_records: [{
      id: 'bbbbbbbb-0000-0000-0000-000000000001',
      borehole_id: 'aaaaaaaa-0000-0000-0000-000000000001',
      pipe_number: 1, water_strike: false, created_by: UID,
      recorded_at: '2026-08-30T06:00:00.000Z',
      received_at: '2026-08-30T06:00:05.000Z',
      modified_at: '2026-08-30T15:00:00.000Z',
      formation: 'Corrected by the office',
    }],
  });
  const pull = createSupabasePull(deps(client));

  const result = await pull('2026-08-30T10:00:00.000Z');

  assert.equal(result?.snapshot.pipeRecords[0].formation, 'Corrected by the office');
  assert.equal(result?.watermark, '2026-08-30T15:00:00.000Z');
});

test('a row soft-deleted upstream comes back as a deletion, not a record', async () => {
  const client = fakeClient({
    boreholes: [
      boreholeRow(),
      boreholeRow({
        id: 'aaaaaaaa-0000-0000-0000-000000000002',
        deleted_at: '2026-08-30T07:00:00.000Z',
      }),
    ],
  });
  const pull = createSupabasePull(deps(client));

  const result = await pull(null);

  assert.equal(result?.snapshot.boreholes.length, 1);
  assert.equal(result?.snapshot.boreholes[0].id, 'aaaaaaaa-0000-0000-0000-000000000001');
  assert.deepEqual(result?.snapshot.deletedIds, ['aaaaaaaa-0000-0000-0000-000000000002']);
});

test('the watermark advances to the newest row the server returned', async () => {
  const client = fakeClient({
    boreholes: [
      boreholeRow({ modified_at: '2026-08-30T06:00:05.000Z' }),
      boreholeRow({
        id: 'aaaaaaaa-0000-0000-0000-000000000003',
        modified_at: '2026-08-30T09:30:00.000Z',
      }),
    ],
  });
  const pull = createSupabasePull(deps(client));

  const result = await pull(null);

  assert.equal(result?.watermark, '2026-08-30T09:30:00.000Z');
});

test('an empty pull leaves the watermark where it was', async () => {
  const client = fakeClient();
  const pull = createSupabasePull(deps(client));
  const since = '2026-08-30T06:00:00.000Z';

  const result = await pull(since);

  assert.equal(result?.watermark, since);
});

test('no session means nothing is pulled', async () => {
  const client = fakeClient({ boreholes: [boreholeRow()] });
  const pull = createSupabasePull(deps(client, null));

  const result = await pull(null);

  assert.equal(result, null);
  assert.equal(client.calls.length, 0, 'the server is not asked at all');
});

test('an unconfigured build pulls nothing rather than throwing', async () => {
  const pull = createSupabasePull(deps(null));
  assert.equal(await pull(null), null);
});

// --- the runner that carries the watermark between pulls ---------------------

function runnerHarness(pullImpl: (since: string | null) => Promise<unknown>) {
  let stored: string | null = null;
  const merged: RemoteSnapshot[] = [];
  const runner = createPullRunner({
    pull: pullImpl as never,
    readWatermark: () => stored,
    writeWatermark: (w: string) => void (stored = w),
    merge: (s: RemoteSnapshot) => void merged.push(s),
  });
  return { runner, merged, get stored() { return stored; } };
}

const EMPTY: RemoteSnapshot = {
  boreholes: [], pipeRecords: [], events: [], shiftLogs: [], deletedIds: [],
};

test('the runner hands the stored watermark to the transport', async () => {
  const seen: (string | null)[] = [];
  const h = runnerHarness(async (since) => {
    seen.push(since);
    return { snapshot: EMPTY, watermark: '2026-08-30T10:00:00.000Z' };
  });

  await h.runner();
  await h.runner();

  assert.deepEqual(seen, [null, '2026-08-30T10:00:00.000Z']);
});

test('the runner stores the watermark the pull came back with', async () => {
  const h = runnerHarness(async () => ({
    snapshot: EMPTY,
    watermark: '2026-08-30T11:22:33.000Z',
  }));

  await h.runner();

  assert.equal(h.stored, '2026-08-30T11:22:33.000Z');
});

test('a pull with no session merges nothing and moves no watermark', async () => {
  const h = runnerHarness(async () => null);

  const merged = await h.runner();

  assert.equal(merged, false);
  assert.equal(h.merged.length, 0);
  assert.equal(h.stored, null);
});

test('a failing pull leaves the watermark alone so the rows are retried', async () => {
  const h = runnerHarness(async () => {
    throw new Error('network down');
  });

  await assert.rejects(() => h.runner());
  assert.equal(h.stored, null);
});
