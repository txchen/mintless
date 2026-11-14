import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import type {
  AccountSummary,
  Overview,
  TransactionDetail,
  TransactionPage,
  TransactionRow,
} from '../src/shared/contracts.ts';
import { canonicalAccounts } from '../src/server/db/schema.ts';
import { syncItem } from '../src/server/sync/engine.ts';
import { addFixtureItem, addUser, login, setup, shareInGroup } from './helpers.ts';

type Ctx = Awaited<ReturnType<typeof world>>;

async function world() {
  const env = setup();
  const bank = addFixtureItem(env.db, 'household-bank', 1);
  const card = addFixtureItem(env.db, 'household-card', 2);
  await syncItem(env.sync, bank, 'manual');
  await syncItem(env.sync, card, 'manual');
  await addUser(env.db, 'root', 'admin');
  const aliceId = await addUser(env.db, 'alice', 'member');
  const bobId = await addUser(env.db, 'bob', 'member');
  const admin = await login(env.api, 'root');
  const alice = await login(env.api, 'alice');
  const bob = await login(env.api, 'bob');
  const accounts = env.db.select().from(canonicalAccounts).all();
  const checking = accounts.find((a) => a.displayName === 'Everyday Checking')!;
  const savings = accounts.find((a) => a.displayName === 'Rainy Day Savings')!;
  const summit = accounts.find((a) => a.displayName === 'Summit Rewards Visa')!;
  const checkingGroup = await shareInGroup(admin.call, 'Everyday', [checking.id], [aliceId, bobId]);
  const summitGroup = await shareInGroup(admin.call, 'Summit', [summit.id], [aliceId]);
  const all = (await (await admin.call('/transactions?status=all&limit=200')).json()) as TransactionPage;
  const pick = (accountId: string) => all.rows.find((r) => r.accountId === accountId)!;
  return {
    checkingGroup,
    summitGroup,
    ...env,
    admin,
    alice,
    bob,
    aliceId,
    bobId,
    checking,
    savings,
    summit,
    savingsTx: pick(savings.id),
    summitTx: pick(summit.id),
    checkingTx: pick(checking.id),
  };
}

const json = async <T>(res: Response) => (await res.json()) as T;

describe('authentication', () => {
  it('rejects anonymous access to every business route', async () => {
    const { api } = setup();
    const paths = [
      '/overview',
      '/accounts',
      '/categories',
      '/transactions',
      '/transactions/x',
      '/transactions/export.csv',
      '/admin/users',
      '/admin/items',
    ];
    for (const path of paths) expect((await api.request(`/api${path}`)).status, path).toBe(401);
    const patch = await api.request('/api/transactions/x/annotation', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{"revision":0}',
    });
    expect(patch.status).toBe(401);
    expect((await api.request('/api/health')).status).toBe(200);
  });

  it('locks out repeated failures and does not reveal whether a user exists', async () => {
    const { api, db } = setup();
    await addUser(db, 'carol', 'member');
    const attempt = (username: string, password: string) =>
      api.request('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
    expect((await attempt('nobody', 'whatever-password')).status).toBe(401);
    for (let i = 0; i < 5; i++) expect((await attempt('carol', 'wrong-password')).status).toBe(401);
    expect((await attempt('carol', 'correct-horse-battery')).status).toBe(429);
  });

  it('counts parallel login attempts before the password check finishes', async () => {
    const { api, db } = setup();
    await addUser(db, 'dave', 'member');
    const attempt = async () =>
      api.request('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'dave', password: 'wrong-password' }),
      });
    const statuses = (await Promise.all(Array.from({ length: 12 }, attempt))).map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
  });

  it('requires the CSRF token for writes and revokes sessions on logout and disable', async () => {
    const ctx = await world();
    const noCsrf = await ctx.api.request(`/api/transactions/${ctx.checkingTx.id}/annotation`, {
      method: 'PATCH',
      headers: { cookie: ctx.alice.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ revision: 0, note: 'x' }),
    });
    expect(noCsrf.status).toBe(403);

    expect((await ctx.bob.call('/session', { method: 'DELETE' })).status).toBe(204);
    expect((await ctx.bob.call('/transactions')).status).toBe(401);

    expect(
      (
        await ctx.admin.call(`/admin/users/${ctx.aliceId}`, {
          method: 'PATCH',
          body: JSON.stringify({ disabled: true }),
        })
      ).status,
    ).toBe(204);
    expect((await ctx.alice.call('/transactions')).status).toBe(401);
  });
});

describe('member account scope', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await world();
  });

  it('lists, summarizes and exports only granted accounts', async () => {
    const accounts = await json<AccountSummary[]>(await ctx.bob.call('/accounts'));
    expect(accounts.map((a) => a.id)).toEqual([ctx.checking.id]);
    expect(accounts[0]!.groupName).toBe('Everyday');

    const page = await json<TransactionPage>(await ctx.bob.call('/transactions?status=all&limit=200'));
    expect(page.rows.length).toBeGreaterThan(0);
    expect(new Set(page.rows.map((r) => r.accountId))).toEqual(new Set([ctx.checking.id]));

    const filtered = await json<TransactionPage>(
      await ctx.bob.call(`/transactions?account=${ctx.savings.id}`),
    );
    expect(filtered.rows).toHaveLength(0);

    const csv = await (
      await ctx.bob.call(`/transactions/export.csv?status=all&account=${ctx.savings.id}`)
    ).text();
    expect(csv.trim().split('\r\n')).toHaveLength(1);
    const fullCsv = await (await ctx.bob.call('/transactions/export.csv?status=all')).text();
    expect(fullCsv).not.toContain('Rainy Day Savings');
    expect(fullCsv).not.toContain('Summit Rewards Visa');

    const bobView = await json<Overview>(await ctx.bob.call('/overview'));
    const adminView = await json<Overview>(await ctx.admin.call('/overview'));
    expect(bobView.groups.reduce((n, g) => n + g.accountCount, 0)).toBe(1);
    expect(bobView.review.pending).toBeLessThan(adminView.review.pending);
    expect(bobView.syncProblems).toBeNull();
  });

  it('hides ungranted transactions on direct reads and writes', async () => {
    expect((await ctx.bob.call(`/transactions/${ctx.savingsTx.id}`)).status).toBe(404);
    expect((await ctx.bob.call(`/transactions/${ctx.summitTx.id}`)).status).toBe(404);
    const write = await ctx.bob.call(`/transactions/${ctx.summitTx.id}/annotation`, {
      method: 'PATCH',
      body: JSON.stringify({ revision: 0, note: 'sneaky' }),
    });
    expect(write.status).toBe(404);
    const after = await json<TransactionDetail>(await ctx.admin.call(`/transactions/${ctx.summitTx.id}`));
    expect(after.annotation.note).toBe('');
  });

  it('keeps categories from ungranted accounts private', async () => {
    await ctx.admin.call(`/transactions/${ctx.savingsTx.id}/annotation`, {
      method: 'PATCH',
      body: JSON.stringify({ revision: 0, category: 'Secret savings goal' }),
    });
    expect(await json<string[]>(await ctx.bob.call('/categories'))).not.toContain('Secret savings goal');
    expect(await json<string[]>(await ctx.admin.call('/categories'))).toContain('Secret savings goal');
    const search = await json<TransactionPage>(await ctx.bob.call('/transactions?status=all&q=Secret'));
    expect(search.rows).toHaveLength(0);
    await ctx.admin.call(`/transactions/${ctx.checkingTx.id}/annotation`, {
      method: 'PATCH',
      body: JSON.stringify({ revision: 0, tags: ['rent', 'split'] }),
    });
    const punctuation = await json<TransactionPage>(await ctx.bob.call('/transactions?status=all&q=%22%2C'));
    expect(punctuation.rows, 'JSON punctuation must not match tags').toHaveLength(0);
    const tag = await json<TransactionPage>(await ctx.bob.call('/transactions?status=all&q=split'));
    expect(tag.rows.map((r) => r.id)).toEqual([ctx.checkingTx.id]);
  });

  it('members bookkeep granted accounts and see each other’s shared annotations', async () => {
    const res = await ctx.bob.call(`/transactions/${ctx.checkingTx.id}/annotation`, {
      method: 'PATCH',
      body: JSON.stringify({
        revision: 0,
        note: 'Rent split',
        tags: ['household'],
        isReconciled: true,
        seen: {
          amountMinor: ctx.checkingTx.amountMinor,
          date: ctx.checkingTx.date,
          accountId: ctx.checkingTx.accountId,
        },
      }),
    });
    expect(res.status).toBe(200);
    const seen = await json<TransactionDetail>(await ctx.alice.call(`/transactions/${ctx.checkingTx.id}`));
    expect(seen.annotation).toMatchObject({
      note: 'Rent split',
      tags: ['household'],
      isReconciled: true,
      updatedBy: 'bob',
      reconciledBy: 'bob',
      revision: 1,
    });
  });

  it('applies revocation on the next request', async () => {
    expect((await ctx.alice.call(`/transactions/${ctx.summitTx.id}`)).status).toBe(200);
    await ctx.admin.call(`/admin/groups/${ctx.summitGroup}/members`, {
      method: 'PUT',
      body: JSON.stringify({ userIds: [] }),
    });
    expect((await ctx.alice.call(`/transactions/${ctx.summitTx.id}`)).status).toBe(404);
    const write = await ctx.alice.call(`/transactions/${ctx.summitTx.id}/annotation`, {
      method: 'PATCH',
      body: JSON.stringify({ revision: 0, note: 'late' }),
    });
    expect(write.status).toBe(404);
  });

  it('forbids admin routes for members', async () => {
    const attempts: [string, RequestInit][] = [
      ['/admin/users', {}],
      ['/admin/items', {}],
      ['/admin/profiles', {}],
      [
        '/admin/users',
        {
          method: 'POST',
          body: JSON.stringify({ username: 'mallory', password: 'long-enough-pw', role: 'admin' }),
        },
      ],
      [
        `/admin/groups/${ctx.summitGroup}/members`,
        { method: 'PUT', body: JSON.stringify({ userIds: [ctx.bobId] }) },
      ],
      [
        `/admin/accounts/${ctx.savings.id}/move`,
        { method: 'POST', body: JSON.stringify({ groupId: ctx.checkingGroup, fromGroupId: 'unassigned' }) },
      ],
      ['/admin/groups', { method: 'POST', body: JSON.stringify({ name: 'Mine' }) }],
      [
        `/admin/accounts/${ctx.savings.id}/access`,
        { method: 'PUT', body: JSON.stringify({ userIds: [ctx.bobId] }) },
      ],
      [`/admin/groups/${ctx.summitGroup}`, { method: 'DELETE' }],
      [
        `/admin/accounts/${ctx.checking.id}`,
        { method: 'PATCH', body: JSON.stringify({ displayName: 'Mine now' }) },
      ],
      [`/admin/users/${ctx.bobId}`, { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) }],
      ['/admin/demo-items', { method: 'POST', body: JSON.stringify({ dataset: 'household-bank' }) }],
    ];
    for (const [path, init] of attempts) expect((await ctx.bob.call(path, init)).status, path).toBe(403);
    expect(
      ctx.db.select().from(canonicalAccounts).where(eq(canonicalAccounts.id, ctx.checking.id)).get()!
        .displayName,
    ).toBe('Everyday Checking');
  });
});

describe('annotation conflicts', () => {
  it('detects concurrent edits from two members and returns the current version', async () => {
    const ctx = await world();
    const id = ctx.checkingTx.id;
    const first = await ctx.alice.call(`/transactions/${id}/annotation`, {
      method: 'PATCH',
      body: JSON.stringify({ revision: 0, note: 'Alice note' }),
    });
    expect(first.status).toBe(200);
    const second = await ctx.bob.call(`/transactions/${id}/annotation`, {
      method: 'PATCH',
      body: JSON.stringify({ revision: 0, note: 'Bob note' }),
    });
    expect(second.status).toBe(409);
    const conflict = await json<{ error: string; current: TransactionRow }>(second);
    expect(conflict.current.annotation).toMatchObject({
      note: 'Alice note',
      revision: 1,
      updatedBy: 'alice',
    });
    const retry = await ctx.bob.call(`/transactions/${id}/annotation`, {
      method: 'PATCH',
      body: JSON.stringify({ revision: 1, note: 'Bob note' }),
    });
    expect(retry.status).toBe(200);
    const detail = await json<TransactionDetail>(await ctx.admin.call(`/transactions/${id}`));
    expect(detail.history.map((h) => [h.revision, h.actor])).toEqual([
      [2, 'bob'],
      [1, 'alice'],
    ]);
  });

  it('validates annotation input at the boundary', async () => {
    const ctx = await world();
    const id = ctx.checkingTx.id;
    const bad = [
      { note: 'no revision' },
      { revision: -1 },
      { revision: 0, tags: ['x'.repeat(41)] },
      { revision: 0, note: 'x'.repeat(4001) },
    ];
    for (const body of bad)
      expect(
        (
          await ctx.alice.call(`/transactions/${id}/annotation`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
  });
});

describe('administration', () => {
  it('an administrator cannot demote themselves', async () => {
    const ctx = await world();
    const users = await json<{ id: string; username: string }[]>(await ctx.admin.call('/admin/users'));
    const root = users.find((u) => u.username === 'root')!;
    expect(
      (
        await ctx.admin.call(`/admin/users/${root.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ role: 'member' }),
        })
      ).status,
    ).toBe(409);
  });

  it('grants only to members, and exports escape spreadsheet formulas', async () => {
    const ctx = await world();
    const users = await json<{ id: string; username: string }[]>(await ctx.admin.call('/admin/users'));
    const root = users.find((u) => u.username === 'root')!;
    const grant = await ctx.admin.call(`/admin/groups/${ctx.summitGroup}/members`, {
      method: 'PUT',
      body: JSON.stringify({ userIds: [root.id] }),
    });
    expect(grant.status).toBe(400);
    const legacy = await ctx.admin.call(`/admin/accounts/${ctx.savings.id}/access`, {
      method: 'PUT',
      body: JSON.stringify({ userIds: [ctx.bobId] }),
    });
    expect(legacy.status, 'the old per-account grant endpoint is gone').toBe(404);
    await ctx.alice.call(`/transactions/${ctx.checkingTx.id}/annotation`, {
      method: 'PATCH',
      body: JSON.stringify({ revision: 0, note: '=HYPERLINK("http://x")' }),
    });
    const csv = await (await ctx.alice.call('/transactions/export.csv?status=all')).text();
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
});
