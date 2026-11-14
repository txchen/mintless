import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vite-plus/test';
import type {
  AccountSummary,
  GroupSummary,
  Insights,
  MoveImpact,
  Overview,
  TransactionPage,
} from '../src/shared/contracts.ts';
import { openDb } from '../src/server/db/client.ts';
import { accountGroups, canonicalAccounts, groupMembers, users } from '../src/server/db/schema.ts';
import { scopeFor } from '../src/server/http/context.ts';
import { syncItem } from '../src/server/sync/engine.ts';
import { addFixtureItem, addUser, login, setup, shareInGroup } from './helpers.ts';

const migrations = join(import.meta.dirname, '../db/migrations');

function migrateTo(path: string, count: number) {
  const dir = mkdtempSync(join(tmpdir(), 'mintless-migrations-'));
  cpSync(migrations, dir, { recursive: true });
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, count);
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal));
  const sqlite = new Database(path);
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: dir });
  rmSync(dir, { recursive: true });
  return sqlite;
}

describe('migration 0003 from per-account grants to account groups', () => {
  it('keeps every member seeing exactly the accounts they saw, with history and notes intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mintless-legacy-'));
    const path = join(dir, 'legacy.sqlite');
    const old = migrateTo(path, 3);
    const user = old.prepare(
      'insert into users (id, username, password_hash, role, disabled_at, password_set_by) values (?, ?, ?, ?, ?, ?)',
    );
    user.run('u-root', 'root', 'x', 'admin', null, 'cli');
    user.run('u-alice', 'alice', 'x', 'member', null, 'admin');
    user.run('u-bob', 'bob', 'x', 'member', null, 'self');
    user.run('u-carol', 'carol', 'x', 'member', 5, 'admin');
    user.run('u-ex', 'exadmin', 'x', 'admin', null, 'cli');
    const account = old.prepare(
      "insert into canonical_accounts (id, display_name, kind, currency) values (?, ?, 'depository', 'USD')",
    );
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) account.run(id, `Account ${id}`);
    const grant = old.prepare(
      "insert into account_access (user_id, canonical_account_id, granted_by) values (?, ?, 'u-root')",
    );
    for (const [u, a] of [
      ['u-alice', 'a1'],
      ['u-bob', 'a1'],
      ['u-alice', 'a2'],
      ['u-bob', 'a2'],
      ['u-alice', 'a3'],
      ['u-carol', 'a4'],
      ['u-ex', 'a5'],
    ]) {
      grant.run(u, a);
    }
    const tx = old.prepare(
      "insert into canonical_transactions (id, canonical_account_id, preferred_source_id, status, date, amount_minor, currency, name, updated_at) values (?, ?, 's', 'posted', '2026-10-01', 100, 'USD', 'x', 0)",
    );
    for (const a of ['a1', 'a3', 'a4', 'a6']) tx.run(`t-${a}`, a);
    old
      .prepare(
        "insert into transaction_annotations (canonical_transaction_id, note, revision, updated_at) values ('t-a3', 'keep me', 1, 0)",
      )
      .run();
    const visibleBefore = (userId: string) =>
      old
        .prepare('select canonical_account_id as id from account_access where user_id = ? order by 1')
        .all(userId)
        .map((r) => (r as { id: string }).id);
    const before = Object.fromEntries(['u-alice', 'u-bob', 'u-carol'].map((u) => [u, visibleBefore(u)]));
    old.close();

    const db = openDb(path);
    const scopeOf = (id: string) => {
      const u = db.select().from(users).where(eq(users.id, id)).get()!;
      const scope = scopeFor(db, { id: u.id, username: u.username, role: u.role });
      return scope.kind === 'all' ? 'all' : [...scope.accountIds].sort();
    };
    for (const [id, accounts] of Object.entries(before)) expect(scopeOf(id), id).toEqual(accounts);
    expect(scopeOf('u-root')).toBe('all');

    const groups = db.select().from(accountGroups).all();
    const byName = Object.fromEntries(groups.map((g) => [g.name, g]));
    expect(Object.keys(byName).sort()).toEqual([
      'Shared with alice',
      'Shared with alice, bob',
      'Shared with carol',
      'Unassigned',
    ]);
    expect(byName.Unassigned).toMatchObject({ id: 'unassigned', protected: true });
    const groupOf = (a: string) =>
      db.select().from(canonicalAccounts).where(eq(canonicalAccounts.id, a)).get()!.groupId;
    expect(groupOf('a1')).toBe(groupOf('a2'));
    expect(groupOf('a5'), 'admin-only grants do not create sharing').toBe('unassigned');
    expect(groupOf('a6')).toBe('unassigned');
    expect(
      db
        .select()
        .from(canonicalAccounts)
        .all()
        .every((a) => a.groupId !== null),
    ).toBe(true);
    expect(db.select().from(groupMembers).where(eq(groupMembers.userId, 'u-ex')).all()).toHaveLength(0);
    expect(
      db.select().from(groupMembers).where(eq(groupMembers.userId, 'u-carol')).all(),
      'disabled members keep their membership',
    ).toHaveLength(1);
    expect(db.sqlite.prepare('select count(*) n from canonical_transactions').get()).toEqual({ n: 4 });
    expect(
      db.sqlite
        .prepare("select note from transaction_annotations where canonical_transaction_id = 't-a3'")
        .get(),
    ).toEqual({ note: 'keep me' });
    expect(
      db.sqlite.prepare('select count(*) n from account_access').get(),
      'legacy grant rows are kept as a record',
    ).toEqual({ n: 7 });
    expect(
      db.sqlite.prepare('select role, password_set_by, disabled_at from users order by id').all(),
    ).toEqual([
      { role: 'member', password_set_by: 'admin', disabled_at: null },
      { role: 'member', password_set_by: 'self', disabled_at: null },
      { role: 'member', password_set_by: 'admin', disabled_at: 5 },
      { role: 'admin', password_set_by: 'cli', disabled_at: null },
      { role: 'admin', password_set_by: 'cli', disabled_at: null },
    ]);
    db.sqlite.close();
    rmSync(dir, { recursive: true });
  });

  it('creates only the protected Unassigned group on a fresh database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mintless-fresh-'));
    mkdirSync(dir, { recursive: true });
    const db = openDb(join(dir, 'fresh.sqlite'));
    expect(db.select().from(accountGroups).all()).toMatchObject([
      { id: 'unassigned', name: 'Unassigned', protected: true },
    ]);
    db.sqlite.close();
    rmSync(dir, { recursive: true });
  });
});

async function world() {
  const env = setup();
  await syncItem(env.sync, addFixtureItem(env.db, 'household-bank', 1), 'manual');
  await syncItem(env.sync, addFixtureItem(env.db, 'household-card', 2), 'manual');
  await addUser(env.db, 'root', 'admin');
  const aliceId = await addUser(env.db, 'alice', 'member');
  const bobId = await addUser(env.db, 'bob', 'member');
  const admin = await login(env.api, 'root');
  const alice = await login(env.api, 'alice');
  const bob = await login(env.api, 'bob');
  const accounts = env.db.select().from(canonicalAccounts).all();
  const acct = (name: string) => accounts.find((a) => a.displayName === name)!.id;
  const household = await shareInGroup(
    admin.call,
    'Household',
    [acct('Everyday Checking'), acct('Harbor Cash Back Card')],
    [aliceId, bobId],
  );
  const travel = await shareInGroup(admin.call, 'Travel', [acct('Summit Rewards Visa')], [aliceId]);
  const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
  return { ...env, admin, alice, bob, aliceId, bobId, acct, household, travel, json };
}

describe('account group authorization', () => {
  it('puts newly synced accounts in the admin-only Unassigned group', async () => {
    const w = await world();
    expect(
      w.db
        .select()
        .from(canonicalAccounts)
        .where(eq(canonicalAccounts.id, w.acct('Rainy Day Savings')))
        .get()!.groupId,
    ).toBe('unassigned');
    await syncItem(w.sync, addFixtureItem(w.db, 'household-card', 99), 'manual');
    const fresh = w.db
      .select()
      .from(canonicalAccounts)
      .all()
      .filter((a) => a.groupId === 'unassigned');
    expect(fresh).toHaveLength(2);
    const aliceAccounts = await w.json<AccountSummary[]>(w.alice.call('/accounts'));
    expect(aliceAccounts.some((a) => fresh.some((f) => f.id === a.id))).toBe(false);
    const put = await w.admin.call('/admin/groups/unassigned/members', {
      method: 'PUT',
      body: JSON.stringify({ userIds: [w.aliceId] }),
    });
    expect(put.status, 'Unassigned cannot be shared').toBe(400);
  });

  it('gives members the union of their groups across every read surface, and nothing else', async () => {
    const w = await world();
    const visible = async (c: typeof w.alice) => {
      const accounts = (await w.json<AccountSummary[]>(c.call('/accounts'))).map((a) => a.id).sort();
      const rows = (await w.json<TransactionPage>(c.call('/transactions?status=all&limit=200'))).rows;
      const csv = await (await c.call('/transactions/export.csv?status=all')).text();
      return {
        accounts,
        txAccounts: [...new Set(rows.map((r) => r.accountId))].sort(),
        csvRows: csv.trim().split('\r\n').length - 1,
        rows: rows.length,
      };
    };
    const a = await visible(w.alice);
    const b = await visible(w.bob);
    expect(a.accounts).toEqual(
      [w.acct('Everyday Checking'), w.acct('Harbor Cash Back Card'), w.acct('Summit Rewards Visa')].sort(),
    );
    expect(b.accounts).toEqual([w.acct('Everyday Checking'), w.acct('Harbor Cash Back Card')].sort());
    expect(a.txAccounts).toEqual(a.accounts);
    expect(b.txAccounts).toEqual(b.accounts);
    expect(a.csvRows).toBe(a.rows);

    const groupsForBob = await w.json<GroupSummary[]>(w.bob.call('/groups'));
    expect(groupsForBob.map((g) => g.name)).toEqual(['Household']);
    expect(groupsForBob[0]!.memberIds, 'members do not see who else is in a group').toBeUndefined();
    const groupsForAdmin = await w.json<GroupSummary[]>(w.admin.call('/groups'));
    expect(groupsForAdmin.map((g) => g.name)).toEqual(['Household', 'Travel', 'Unassigned']);
    expect(groupsForAdmin.find((g) => g.name === 'Unassigned')!.accountCount).toBe(1);
  });

  it('narrows by group without ever broadening, for lists, CSV, overview, charts and suggestions', async () => {
    const w = await world();
    const travelRows = await w.json<TransactionPage>(
      w.alice.call(`/transactions?status=all&limit=200&group=${w.travel}`),
    );
    expect(new Set(travelRows.rows.map((r) => r.accountId))).toEqual(
      new Set([w.acct('Summit Rewards Visa')]),
    );
    for (const group of [w.travel, 'unassigned', 'not-a-group']) {
      const rows = await w.json<TransactionPage>(w.bob.call(`/transactions?status=all&group=${group}`));
      expect(rows.rows, `bob with group=${group}`).toHaveLength(0);
      expect(
        (await (await w.bob.call(`/transactions/export.csv?group=${group}`)).text()).trim().split('\r\n'),
      ).toHaveLength(1);
      expect((await w.json<AccountSummary[]>(w.bob.call(`/accounts?group=${group}`))).length).toBe(0);
      const ov = await w.json<Overview>(w.bob.call(`/overview?group=${group}`));
      expect(ov.groups).toEqual([]);
      expect(ov.review).toEqual({ reconciliation: 0, lifecycle: 0, uncategorized: 0, pending: 0 });
      expect((await w.json<Insights>(w.bob.call(`/insights?group=${group}`))).currency).toBeNull();
      expect(await w.json<string[]>(w.bob.call(`/categories?group=${group}`))).toEqual([]);
    }
    const combined = await w.json<TransactionPage>(
      w.alice.call(`/transactions?status=all&group=${w.household}&account=${w.acct('Summit Rewards Visa')}`),
    );
    expect(combined.rows, 'account and group filters intersect').toHaveLength(0);
    const summit = w.acct('Summit Rewards Visa');
    const scoped = await w.json<Overview>(w.alice.call(`/overview?account=${summit}`));
    expect(
      scoped.groups.reduce((n, g) => n + g.accountCount, 0),
      'account scope narrows overview balances',
    ).toBe(1);
    const bobScoped = await w.json<Overview>(w.bob.call(`/overview?account=${summit}`));
    expect(bobScoped.groups, 'an account outside the user scope yields nothing').toEqual([]);
    expect(bobScoped.review).toEqual({ reconciliation: 0, lifecycle: 0, uncategorized: 0, pending: 0 });
    const bobCsv = await (await w.bob.call(`/transactions/export.csv?account=${summit}`)).text();
    expect(bobCsv.trim().split('\n'), 'a hidden account exports only the header').toHaveLength(1);
    expect((await w.json<Insights>(w.bob.call(`/insights?account=${summit}`))).currency).toBeNull();
    const aliceGroups = await w.json<GroupSummary[]>(w.alice.call(`/groups?account=${summit}`));
    const adminGroups = await w.json<GroupSummary[]>(w.admin.call(`/groups?account=${summit}`));
    expect(
      aliceGroups.map((g) => g.id),
      'account scope keeps only its own group',
    ).toEqual(adminGroups.map((g) => g.id));
    expect(adminGroups).toHaveLength(1);
    const summitRow = (
      await w.json<TransactionPage>(w.alice.call(`/transactions?status=all&account=${summit}`))
    ).rows[0]!;
    const other = w.acct('Everyday Checking');
    expect((await w.alice.call(`/transactions/${summitRow.id}?account=${summit}`)).status).toBe(200);
    expect(
      (await w.alice.call(`/transactions/${summitRow.id}?account=${other}`)).status,
      'detail outside the requested scope is not found',
    ).toBe(404);
    const adminUnassigned = await w.json<AccountSummary[]>(w.admin.call('/accounts?group=unassigned'));
    expect(adminUnassigned.map((a) => a.displayName)).toEqual(['Rainy Day Savings']);
  });

  it('moves an account with all its history atomically, applies it on the next request, and reports the impact', async () => {
    const w = await world();
    const summit = w.acct('Summit Rewards Visa');
    const summitTx = (await w.json<TransactionPage>(w.alice.call(`/transactions?account=${summit}&limit=1`)))
      .rows[0]!;
    await w.alice.call(`/transactions/${summitTx.id}/annotation`, {
      method: 'PATCH',
      body: JSON.stringify({ revision: 0, note: 'trip' }),
    });
    expect((await w.bob.call(`/transactions/${summitTx.id}`)).status).toBe(404);

    const impact = await w.json<MoveImpact>(
      w.admin.call(`/admin/accounts/${summit}/move-impact?to=${w.household}`),
    );
    expect(impact).toMatchObject({ losesAccess: [], gainsAccess: ['bob'], annotationCount: 1 });
    expect(impact.transactionCount).toBeGreaterThan(0);
    const stale = await w.admin.call(`/admin/accounts/${summit}/move`, {
      method: 'POST',
      body: JSON.stringify({ groupId: w.household, fromGroupId: 'unassigned' }),
    });
    expect(stale.status, 'a move based on an outdated view is refused').toBe(409);
    const moved = await w.admin.call(`/admin/accounts/${summit}/move`, {
      method: 'POST',
      body: JSON.stringify({ groupId: w.household, fromGroupId: w.travel }),
    });
    expect(moved.status).toBe(204);
    const seen = await w.json<{ annotation: { note: string } }>(w.bob.call(`/transactions/${summitTx.id}`));
    expect(seen.annotation.note, 'bob now sees the full history and notes').toBe('trip');

    const back = await w.json<MoveImpact>(
      w.admin.call(`/admin/accounts/${summit}/move-impact?to=unassigned`),
    );
    expect(back).toMatchObject({ losesAccess: ['alice', 'bob'], gainsAccess: [] });
    await w.admin.call(`/admin/accounts/${summit}/move`, {
      method: 'POST',
      body: JSON.stringify({ groupId: 'unassigned', fromGroupId: w.household }),
    });
    expect((await w.alice.call(`/transactions/${summitTx.id}`)).status).toBe(404);
    const write = await w.bob.call(`/transactions/${summitTx.id}/annotation`, {
      method: 'PATCH',
      body: JSON.stringify({ revision: 2, note: 'late' }),
    });
    expect(write.status).toBe(404);
  });

  it('removes access on the next request when membership is revoked', async () => {
    const w = await world();
    const checkingTx = (
      await w.json<TransactionPage>(
        w.bob.call(`/transactions?account=${w.acct('Everyday Checking')}&limit=1`),
      )
    ).rows[0]!;
    await w.admin.call(`/admin/users/${w.bobId}`, {
      method: 'PATCH',
      body: JSON.stringify({ groupIds: [] }),
    });
    expect((await w.bob.call(`/transactions/${checkingTx.id}`)).status).toBe(404);
    expect((await w.json<AccountSummary[]>(w.bob.call('/accounts'))).length).toBe(0);
    expect((await w.json<GroupSummary[]>(w.bob.call('/groups'))).length).toBe(0);
  });

  it('manages groups safely: unique names, members only, no deleting a nonempty or protected group', async () => {
    const w = await world();
    expect(
      (await w.admin.call('/admin/groups', { method: 'POST', body: JSON.stringify({ name: 'Household' }) }))
        .status,
    ).toBe(409);
    expect(
      (
        await w.admin.call(`/admin/groups/${w.travel}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: 'Trips' }),
        })
      ).status,
    ).toBe(204);
    const duplicate = await w.admin.call(`/admin/groups/${w.travel}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Household' }),
    });
    expect(duplicate.status, 'duplicate rename is a conflict, not a crash').toBe(409);
    expect((await w.admin.call(`/admin/groups/${w.household}`, { method: 'DELETE' })).status).toBe(409);
    expect((await w.admin.call('/admin/groups/unassigned', { method: 'DELETE' })).status).toBe(409);
    const emptied = await w.admin.call(`/admin/accounts/${w.acct('Summit Rewards Visa')}/move`, {
      method: 'POST',
      body: JSON.stringify({ groupId: 'unassigned', fromGroupId: w.travel }),
    });
    expect(emptied.status).toBe(204);
    const before = w.db.sqlite.prepare('select count(*) n from canonical_transactions').get();
    expect((await w.admin.call(`/admin/groups/${w.travel}`, { method: 'DELETE' })).status).toBe(204);
    expect(
      w.db.sqlite.prepare('select count(*) n from canonical_transactions').get(),
      'deleting a group never deletes financial data',
    ).toEqual(before);
    expect(w.db.select().from(groupMembers).where(eq(groupMembers.groupId, w.travel)).all()).toHaveLength(0);
  });
});
