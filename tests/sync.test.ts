import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { count, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { openDb, type Db } from '../src/server/db/client.ts';
import {
  canonicalTransactions,
  items,
  sourceAccounts,
  sourceTransactions,
  syncRuns,
} from '../src/server/db/schema.ts';
import { applyBatch, fetchBatch, syncItem } from '../src/server/sync/engine.ts';
import { FixtureProvider } from '../src/server/sync/fixture-provider.ts';
import { ProviderError, type TransactionsProvider } from '../src/server/sync/provider.ts';
import { getDetail, listTransactions, patchAnnotation } from '../src/server/transactions.ts';
import { addFixtureItem, addUser, setup } from './helpers.ts';

const all = { kind: 'all' } as const;
const fixture = new FixtureProvider();
const n = (db: Db, table: typeof sourceTransactions | typeof canonicalTransactions) =>
  db.select({ n: count() }).from(table).get()!.n;
const cursorOf = (db: Db, id: string) => db.select().from(items).where(eq(items.id, id)).get()!.cursor;
const seenOf = (r: { amountMinor: number; date: string; accountId: string }) => ({
  amountMinor: r.amountMinor,
  date: r.date,
  accountId: r.accountId,
});
const byName = (db: Db, name: string) =>
  listTransactions(db, all, { status: 'all', limit: 200 }).rows.find((r) => r.merchantName === name)!;

function scripted(
  fail: (call: number, cursor: string | null) => ProviderError | undefined,
): TransactionsProvider & { calls: number } {
  const provider = {
    calls: 0,
    async syncPage(token: string, cursor: string | null, size: number) {
      const error = fail(++provider.calls, cursor);
      if (error) throw error;
      return fixture.syncPage(token, cursor, size);
    },
    getAccounts: (token: string) => fixture.getAccounts(token),
  };
  return provider;
}

describe('transaction sync', () => {
  it('shares one cursor across the accounts of an item and creates canonical rows once', async () => {
    const { db, sync } = setup();
    const itemId = addFixtureItem(db);
    const outcome = await syncItem(sync, itemId, 'manual');
    expect(outcome.status).toBe('succeeded');
    expect(cursorOf(db, itemId)).toBe('v1');
    expect(db.select().from(sourceAccounts).where(eq(sourceAccounts.itemId, itemId)).all()).toHaveLength(3);
    const sources = n(db, sourceTransactions);
    expect(sources).toBeGreaterThan(100);
    expect(n(db, canonicalTransactions)).toBe(sources);
    const balances = db.select().from(sourceAccounts).all();
    expect(balances.every((a) => a.balanceFetchedAt !== null && a.balanceCurrentMinor !== null)).toBe(true);
  });

  it('replaying the same batch converges without duplicate rows', async () => {
    const { db } = setup();
    const itemId = addFixtureItem(db);
    const batch = await fetchBatch(
      {},
      fixture,
      JSON.stringify({ dataset: 'household-bank', anchor: '2026-11-01', seed: 42 }),
      null,
    );
    db.transaction((tx) => applyBatch(tx, { itemId, originalCursor: null, runId: null, batch, now: 1 }));
    const before = n(db, sourceTransactions);
    const counts = db.transaction((tx) =>
      applyBatch(tx, { itemId, originalCursor: 'v1', runId: null, batch, now: 2 }),
    );
    expect(counts).toMatchObject({ added: 0, modified: 0, removed: 0, unchanged: before });
    expect(n(db, sourceTransactions)).toBe(before);
    expect(n(db, canonicalTransactions)).toBe(before);
  });

  it('small pages produce the same state as one large page', async () => {
    const big = setup();
    const small = setup();
    const a = addFixtureItem(big.db);
    const b = addFixtureItem(small.db);
    await syncItem(big.sync, a, 'manual');
    await syncItem({ ...small.sync, pageSize: 7 }, b, 'manual');
    expect(n(small.db, sourceTransactions)).toBe(n(big.db, sourceTransactions));
    expect(cursorOf(small.db, b)).toBe('v1');
  });

  it('restarts the whole batch from the committed cursor after mutation during pagination', async () => {
    const provider = scripted((call, cursor) =>
      call === 3
        ? new ProviderError('MUTATION_DURING_PAGINATION')
        : call === 4 && cursor !== null
          ? (new Error('restart must begin at the original cursor') as ProviderError)
          : undefined,
    );
    const { db, sync } = setup({ provider });
    const itemId = addFixtureItem(db);
    const outcome = await syncItem({ ...sync, pageSize: 20 }, itemId, 'manual');
    expect(outcome.status).toBe('succeeded');
    const run = db.select().from(syncRuns).get()!;
    expect(run.attempts).toBe(2);
    const reference = setup();
    const ref = addFixtureItem(reference.db);
    await syncItem(reference.sync, ref, 'manual');
    expect(n(db, sourceTransactions)).toBe(n(reference.db, sourceTransactions));
  });

  it('gives up after bounded mutation restarts and leaves the cursor unchanged', async () => {
    const provider = scripted((call) =>
      call % 2 === 0 ? new ProviderError('MUTATION_DURING_PAGINATION') : undefined,
    );
    const { db, sync } = setup({ provider });
    const itemId = addFixtureItem(db);
    const outcome = await syncItem({ ...sync, pageSize: 20, maxMutationRestarts: 2 }, itemId, 'manual');
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'MUTATION_DURING_PAGINATION' });
    expect(cursorOf(db, itemId)).toBeNull();
    expect(n(db, sourceTransactions)).toBe(0);
    expect(db.select().from(syncRuns).get()!.attempts).toBe(3);
  });

  it('a failure while applying the batch rolls back every row and the cursor', async () => {
    const broken: TransactionsProvider = {
      async syncPage(token, cursor, size) {
        const page = await fixture.syncPage(token, cursor, size);
        const last = page.added[page.added.length - 1]!;
        return {
          ...page,
          added: [...page.added, { ...last, providerTransactionId: 'orphan', providerAccountId: 'missing' }],
        };
      },
      getAccounts: (token) => fixture.getAccounts(token),
    };
    const { db, sync } = setup({ provider: broken });
    const itemId = addFixtureItem(db);
    const outcome = await syncItem(sync, itemId, 'manual');
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'INVALID_REQUEST' });
    expect(cursorOf(db, itemId)).toBeNull();
    expect(n(db, sourceTransactions)).toBe(0);
    expect(db.select().from(sourceAccounts).all()).toHaveLength(0);
  });

  it('retries transient upstream failures, and login errors mark the item for repair', async () => {
    const flaky = scripted((call) => (call === 1 ? new ProviderError('UPSTREAM_UNAVAILABLE') : undefined));
    const ok = setup({ provider: flaky });
    const a = addFixtureItem(ok.db);
    expect((await syncItem(ok.sync, a, 'manual')).status).toBe('succeeded');

    const locked = scripted(() => new ProviderError('LOGIN_REQUIRED'));
    const bad = setup({ provider: locked });
    const b = addFixtureItem(bad.db);
    expect(await syncItem(bad.sync, b, 'manual')).toMatchObject({
      status: 'failed',
      errorCode: 'LOGIN_REQUIRED',
    });
    expect(bad.db.select().from(items).get()).toMatchObject({ status: 'login_required', cursor: null });
    expect(locked.calls).toBe(1);
  });

  it('runs at most one sync per item at a time', async () => {
    const { db, sync } = setup();
    const itemId = addFixtureItem(db);
    const [first, second] = await Promise.all([
      syncItem(sync, itemId, 'manual'),
      syncItem(sync, itemId, 'manual'),
    ]);
    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('already_running');
  });
});

describe('transaction lifecycle and annotations', () => {
  it('keeps the canonical id and notes when a pending transaction posts with a new amount', async () => {
    const { db, sync } = setup();
    const itemId = addFixtureItem(db);
    const admin = await addUser(db, 'admin', 'admin');
    await syncItem(sync, itemId, 'manual');
    const pending = byName(db, 'Nopa Restaurant');
    expect(pending).toMatchObject({ status: 'pending', amountMinor: 4210 });
    patchAnnotation(
      db,
      all,
      admin,
      pending.id,
      { revision: 0, note: 'Birthday dinner', category: 'Dining', tags: ['family'] },
      10,
    );

    await syncItem(sync, itemId, 'manual');
    const posted = byName(db, 'Nopa Restaurant');
    expect(posted.id).toBe(pending.id);
    expect(posted).toMatchObject({ status: 'posted', amountMinor: 5052 });
    expect(posted.annotation).toMatchObject({
      note: 'Birthday dinner',
      category: 'Dining',
      tags: ['family'],
    });
    const detail = getDetail(db, all, posted.id)!;
    expect(detail.sources).toHaveLength(2);
    expect(detail.sources.find((s) => !s.preferred)).toMatchObject({ pending: true, superseded: true });
    expect(detail.events.map((e) => e.kind)).toEqual(['added', 'superseded', 'added', 'removed']);
  });

  it('a canceled pending transaction stays with its note, leaves default lists, and asks for review', async () => {
    const { db, sync } = setup();
    const itemId = addFixtureItem(db);
    const admin = await addUser(db, 'admin', 'admin');
    await syncItem(sync, itemId, 'manual');
    const fuel = byName(db, 'Chevron');
    patchAnnotation(db, all, admin, fuel.id, { revision: 0, note: 'Hold at the pump' }, 10);
    await syncItem(sync, itemId, 'manual');
    const removed = byName(db, 'Chevron');
    expect(removed).toMatchObject({
      id: fuel.id,
      status: 'removed',
      lifecycleReview: 'removed_with_annotations',
    });
    expect(removed.annotation.note).toBe('Hold at the pump');
    const active = listTransactions(db, all, { status: 'active', limit: 200 }).rows;
    expect(active.some((r) => r.id === fuel.id)).toBe(false);
    expect(
      listTransactions(db, all, { status: 'active', review: 'lifecycle', limit: 200 }).rows,
    ).toHaveLength(0);
    expect(
      listTransactions(db, all, { status: 'all', review: 'lifecycle', limit: 200 }).rows.map((r) => r.id),
    ).toEqual([fuel.id]);
  });

  it('flags reconciled transactions whose amount changes, keeping prior review data', async () => {
    const { db, sync } = setup();
    const itemId = addFixtureItem(db);
    const admin = await addUser(db, 'admin', 'admin');
    await syncItem(sync, itemId, 'manual');
    await syncItem(sync, itemId, 'manual');
    const candidates = listTransactions(db, all, { status: 'all', limit: 200 }).rows.filter(
      (r) => r.providerCategory === 'Utilities' || r.providerCategory === 'Health',
    );
    for (const c of candidates)
      expect(
        patchAnnotation(
          db,
          all,
          admin,
          c.id,
          { revision: 0, isReconciled: true, note: 'Matched statement', seen: seenOf(c) },
          10,
        ).kind,
      ).toBe('ok');

    await syncItem(sync, itemId, 'manual');
    const flagged = candidates
      .map((c) => getDetail(db, all, c.id)!)
      .filter((d) => d.annotation.needsReconciliationReview);
    expect(flagged).toHaveLength(1);
    const after = flagged[0]!;
    const utility = candidates.find((c) => c.id === after.id)!;
    expect(after.amountMinor).toBe(utility.amountMinor - 160);
    expect(after.annotation).toMatchObject({
      isReconciled: true,
      needsReconciliationReview: true,
      note: 'Matched statement',
      revision: 2,
    });
    expect(after.history[0]).toMatchObject({ cause: 'sync', revision: 2 });

    const stale = patchAnnotation(
      db,
      all,
      admin,
      utility.id,
      { revision: 1, acknowledgeReview: true, seen: seenOf(after) },
      20,
    );
    expect(stale.kind).toBe('conflict');
    const unseen = patchAnnotation(
      db,
      all,
      admin,
      utility.id,
      { revision: 2, acknowledgeReview: true, seen: seenOf(utility) },
      20,
    );
    expect(unseen.kind, 'confirming values the user did not see must conflict').toBe('conflict');
    const ack = patchAnnotation(
      db,
      all,
      admin,
      utility.id,
      { revision: 2, acknowledgeReview: true, seen: seenOf(after) },
      20,
    );
    expect(ack.kind === 'ok' && ack.row.annotation).toMatchObject({
      isReconciled: true,
      needsReconciliationReview: false,
      revision: 3,
    });
  });

  it('refuses to reconcile when the amount changed after the user loaded it', async () => {
    const { db, sync } = setup();
    const itemId = addFixtureItem(db);
    const admin = await addUser(db, 'admin', 'admin');
    await syncItem(sync, itemId, 'manual');
    const loaded = byName(db, 'Nopa Restaurant');
    await syncItem(sync, itemId, 'manual');
    const blind = patchAnnotation(
      db,
      all,
      admin,
      loaded.id,
      { revision: 0, isReconciled: true, seen: seenOf(loaded) },
      10,
    );
    expect(blind.kind === 'conflict' && blind.row.amountMinor).toBe(5052);
    expect(patchAnnotation(db, all, admin, loaded.id, { revision: 0, isReconciled: true }, 10).kind).toBe(
      'conflict',
    );
    expect(
      patchAnnotation(db, all, admin, loaded.id, { revision: 0, note: 'note only needs the revision' }, 10)
        .kind,
    ).toBe('ok');
  });

  it('asks for review when a posted record names a pending record Mintless never saw', async () => {
    const { db, sync } = setup();
    const itemId = addFixtureItem(db);
    await syncItem(sync, itemId, 'manual');
    const pending = byName(db, 'Nopa Restaurant');
    db.update(sourceTransactions)
      .set({ providerTransactionId: 'lost-pending' })
      .where(eq(sourceTransactions.canonicalTransactionId, pending.id))
      .run();
    await syncItem(sync, itemId, 'manual');
    const posted = listTransactions(db, all, { status: 'all', limit: 200, q: 'Nopa' }).rows.filter(
      (r) => r.status === 'posted',
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ lifecycleReview: 'unmatched_successor', amountMinor: 5052 });
    expect(posted[0]!.id).not.toBe(pending.id);
  });

  it('a configuration error records a failed run instead of throwing', async () => {
    const { db, sync } = setup();
    const itemId = addFixtureItem(db);
    const outcome = await syncItem(
      {
        ...sync,
        providerFor: () => {
          throw new Error('Secret environment variable X is not set');
        },
      },
      itemId,
      'manual',
    );
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'CONFIG_ERROR' });
    expect(db.select().from(syncRuns).get()).toMatchObject({ status: 'failed', errorCode: 'CONFIG_ERROR' });
  });

  it('a merchant rename from the provider updates display fields without touching annotations', async () => {
    const { db, sync } = setup();
    const itemId = addFixtureItem(db);
    const admin = await addUser(db, 'admin', 'admin');
    await syncItem(sync, itemId, 'manual');
    const amazon = listTransactions(db, all, { status: 'all', limit: 200, q: 'Amazon' }).rows.at(-1)!;
    patchAnnotation(
      db,
      all,
      admin,
      amazon.id,
      { revision: 0, isReconciled: true, category: 'Household', seen: seenOf(amazon) },
      10,
    );
    await syncItem(sync, itemId, 'manual');
    const renamed = getDetail(db, all, amazon.id)!;
    expect(renamed.merchantName).toBe('Amazon Marketplace');
    expect(renamed.annotation).toMatchObject({
      category: 'Household',
      isReconciled: true,
      needsReconciliationReview: false,
    });
    expect(renamed.events.at(-1)).toMatchObject({ kind: 'modified' });
  });

  it('refunds arrive as separate inflow transactions', async () => {
    const { db, sync } = setup();
    const itemId = addFixtureItem(db);
    for (let i = 0; i < 3; i++) await syncItem(sync, itemId, 'manual');
    const refund = listTransactions(db, all, { status: 'all', limit: 200, q: 'Refund' }).rows[0]!;
    expect(refund.amountMinor).toBeLessThan(0);
    expect(cursorOf(db, itemId)).toBe('v3');
    expect((await syncItem(sync, itemId, 'manual')).status === 'succeeded' && cursorOf(db, itemId)).toBe(
      'v3',
    );
  });
});

describe('persistence', () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('keeps annotations, cursors and sessions across a process restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mintless-'));
    const path = join(dir, 'mintless.sqlite');
    const first = setup({ path });
    const itemId = addFixtureItem(first.db);
    const admin = await addUser(first.db, 'admin', 'admin');
    await syncItem(first.sync, itemId, 'manual');
    const target = byName(first.db, 'Nopa Restaurant');
    patchAnnotation(first.db, all, admin, target.id, { revision: 0, note: 'survives restart' }, 1);
    first.db.sqlite.close();

    const second = setup({ path });
    expect(cursorOf(second.db, itemId)).toBe('v1');
    expect(getDetail(second.db, all, target.id)!.annotation.note).toBe('survives restart');
    await syncItem(second.sync, itemId, 'manual');
    expect(getDetail(second.db, all, target.id)).toMatchObject({
      status: 'posted',
      annotation: { note: 'survives restart' },
    });
    second.db.sqlite.close();
    const third = openDb(path);
    expect(third.select().from(items).get()!.cursor).toBe('v2');
    third.sqlite.close();
  });
});
