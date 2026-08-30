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
  const calls: { table: string; gte?: unknown }[] = [];
  const client = {
    calls,
    from(table: string) {
      const call: { table: string; gte?: unknown } = { table };
      calls.push(call);
      const builder: Record<string, unknown> = {
        select: () => builder,
        gte: (_col: string, value: unknown) => {
          call.gte = value;
          return builder;
        },
        order: () => builder,
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
      boreholeRow({ received_at: '2026-08-30T06:00:05.000Z' }),
      boreholeRow({
        id: 'aaaaaaaa-0000-0000-0000-000000000003',
        received_at: '2026-08-30T09:30:00.000Z',
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
