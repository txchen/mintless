import { randomInt, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  AnnotationPatch,
  CreateGroupBody,
  GroupMembersBody,
  MoveAccountBody,
  UpdateGroupBody,
  CreateDemoItemBody,
  CreateProfileBody,
  CreateUserBody,
  InsightsQuery,
  TransactionQuery,
  UpdateAccountBody,
  UpdateUserBody,
  type GroupSummary,
  type ItemSummary,
  type MoveImpact,
  type ProfileSummary,
  type SyncRunSummary,
  type UserSummary,
} from '../../shared/contracts.ts';
import { listAccounts, overview } from '../accounts.ts';
import { computeInsights } from '../insights.ts';
import { encryptSecret, hashPassword } from '../crypto.ts';
import {
  UNASSIGNED_GROUP_ID,
  accountGroups,
  annotations,
  canonicalAccounts,
  canonicalTransactions,
  groupMembers,
  items,
  providerProfiles,
  sessions,
  sourceAccounts,
  syncRuns,
  users,
} from '../db/schema.ts';
import { plaidFor } from '../providers.ts';
import { isSyncRunning, syncItem } from '../sync/engine.ts';
import { checkUserChange } from '../users.ts';
import {
  categoriesInScope,
  exportRows,
  getDetail,
  listTransactions,
  patchAnnotation,
  toCsv,
} from '../transactions.ts';
import * as v from 'valibot';
import {
  body,
  canSeeGroup,
  intersectScopes,
  scopeFor,
  fail,
  narrowToAccount,
  narrowToGroup,
  query,
  requireAdmin,
  requireSession,
  type AppEnv,
} from './context.ts';

const GroupFilter = v.object({ group: v.optional(v.string()) });

export const appRoutes = new Hono<AppEnv>()
  .use(requireSession)
  .use(async (c, next) => {
    const group = c.req.query('group');
    if (group !== undefined) c.set('scope', narrowToGroup(c.get('deps').db, c.get('scope'), group));
    const account = c.req.query('account');
    if (account !== undefined) c.set('scope', narrowToAccount(c.get('deps').db, c.get('scope'), account));
    await next();
  })
  .get('/overview', (c) => c.json(overview(c.get('deps').db, c.get('scope'), c.get('user').role === 'admin')))
  .get('/accounts', (c) => c.json(listAccounts(c.get('deps').db, c.get('scope'))))
  .get('/categories', (c) => {
    query(c, GroupFilter);
    return c.json(categoriesInScope(c.get('deps').db, c.get('scope')));
  })
  .get('/groups', (c) => c.json(listGroups(c.get('deps').db, c.get('scope'), c.get('user').role === 'admin')))
  .get('/insights', (c) =>
    c.json(computeInsights(c.get('deps').db, c.get('scope'), query(c, InsightsQuery), c.get('deps').now())),
  )
  .get('/transactions', (c) =>
    c.json(listTransactions(c.get('deps').db, c.get('scope'), query(c, TransactionQuery))),
  )
  .get('/transactions/export.csv', (c) => {
    const filters = { ...query(c, TransactionQuery), cursor: undefined };
    const csv = toCsv(exportRows(c.get('deps').db, c.get('scope'), filters));
    return c.body(csv, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="mintless-transactions.csv"`,
      'cache-control': 'no-store',
    });
  })
  .get('/transactions/:id', (c) => {
    const detail = getDetail(c.get('deps').db, c.get('scope'), c.req.param('id'));
    return detail ? c.json(detail) : fail(404, 'not_found');
  })
  .patch('/transactions/:id/annotation', async (c) => {
    const patch = await body(c, AnnotationPatch);
    const deps = c.get('deps');
    const user = c.get('user');
    const requested = c.get('scope');
    const result = patchAnnotation(
      deps.db,
      (tx) => intersectScopes(scopeFor(tx, user), requested),
      c.get('user').id,
      c.req.param('id'),
      patch,
      deps.now(),
    );
    if (result.kind === 'not_found') fail(404, 'not_found');
    if (result.kind === 'conflict') return c.json({ error: 'conflict', current: result.row }, 409);
    return c.json(result.row);
  });

export const adminRoutes = new Hono<AppEnv>()
  .use(requireSession, requireAdmin)
  .get('/users', (c) => {
    const db = c.get('deps').db;
    const memberships = db.select().from(groupMembers).all();
    const list: UserSummary[] = db
      .select()
      .from(users)
      .orderBy(users.username)
      .all()
      .map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        disabled: u.disabledAt !== null,
        passwordFromCli: u.passwordSetBy === 'cli',
        createdAt: u.createdAt,
        groupIds: memberships.filter((m) => m.userId === u.id).map((m) => m.groupId),
      }));
    return c.json(list);
  })
  .post('/users', async (c) => {
    const input = await body(c, CreateUserBody);
    const db = c.get('deps').db;
    if (input.role !== 'member') fail(400, 'admins_cli_only');
    if (db.select().from(users).where(eq(users.username, input.username)).get()) fail(409, 'username_taken');
    const id = randomUUID();
    const passwordHash = await hashPassword(input.password);
    const inserted = db
      .insert(users)
      .values({ id, username: input.username, role: input.role, passwordSetBy: 'admin', passwordHash })
      .onConflictDoNothing({ target: users.username })
      .run();
    if (!inserted.changes) fail(409, 'username_taken');
    return c.json({ id }, 201);
  })
  .patch('/users/:id', async (c) => {
    const input = await body(c, UpdateUserBody);
    const { db, now } = c.get('deps');
    const actor = c.get('user');
    const id = c.req.param('id');
    const early = db.select().from(users).where(eq(users.id, id)).get() ?? fail(404, 'not_found');
    const earlyProblem = checkUserChange(db, actor.id, early, input);
    if (earlyProblem) fail(earlyProblem === 'admin_password_cli_only' ? 403 : 409, earlyProblem);
    const passwordHash = input.password ? await hashPassword(input.password) : undefined;
    const outcome = db.transaction((tx) => {
      const target = tx.select().from(users).where(eq(users.id, id)).get();
      if (!target) return 'not_found' as const;
      const problem = checkUserChange(tx, actor.id, target, input);
      if (problem) return problem;
      if (input.groupIds?.length) {
        const known = tx
          .select({ id: accountGroups.id })
          .from(accountGroups)
          .where(and(inArray(accountGroups.id, input.groupIds), eq(accountGroups.protected, false)))
          .all();
        if (known.length !== new Set(input.groupIds).size) return 'unknown_group' as const;
      }
      const fields = {
        ...(input.role ? { role: input.role } : {}),
        ...(input.disabled === undefined
          ? {}
          : { disabledAt: input.disabled ? (target.disabledAt ?? now()) : null }),
        ...(passwordHash ? { passwordHash, passwordSetBy: 'admin' as const } : {}),
      };
      if (Object.keys(fields).length) tx.update(users).set(fields).where(eq(users.id, id)).run();
      const promoted = input.role === 'admin' && target.role !== 'admin';
      if (input.groupIds || promoted) tx.delete(groupMembers).where(eq(groupMembers.userId, id)).run();
      for (const groupId of new Set(input.groupIds ?? [])) {
        tx.insert(groupMembers).values({ groupId, userId: id }).run();
      }
      if (input.disabled || passwordHash || (input.role && input.role !== target.role)) {
        tx.update(sessions)
          .set({ revokedAt: now() })
          .where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)))
          .run();
      }
      return null;
    });
    if (outcome === 'not_found') fail(404, 'not_found');
    if (outcome === 'unknown_group') fail(400, 'unknown_group');
    if (outcome) fail(outcome === 'admin_password_cli_only' ? 403 : 409, outcome);
    return c.body(null, 204);
  })
  .patch('/accounts/:id', async (c) => {
    const input = await body(c, UpdateAccountBody);
    const db = c.get('deps').db;
    const result = db
      .update(canonicalAccounts)
      .set({ displayName: input.displayName })
      .where(eq(canonicalAccounts.id, c.req.param('id')))
      .run();
    return result.changes ? c.body(null, 204) : fail(404, 'not_found');
  })
  .get('/accounts/:id/move-impact', (c) => {
    const db = c.get('deps').db;
    const to = c.req.query('to') ?? fail(400, 'missing_group');
    return c.json(moveImpact(db, c.req.param('id'), to) ?? fail(404, 'not_found'));
  })
  .post('/accounts/:id/move', async (c) => {
    const { groupId, fromGroupId } = await body(c, MoveAccountBody);
    const db = c.get('deps').db;
    const accountId = c.req.param('id');
    const outcome = db.transaction((tx) => {
      const account = tx.select().from(canonicalAccounts).where(eq(canonicalAccounts.id, accountId)).get();
      if (!account) return 'not_found' as const;
      if (!tx.select().from(accountGroups).where(eq(accountGroups.id, groupId)).get())
        return 'unknown_group' as const;
      if ((account.groupId ?? UNASSIGNED_GROUP_ID) !== fromGroupId) return 'account_moved' as const;
      tx.update(canonicalAccounts).set({ groupId }).where(eq(canonicalAccounts.id, accountId)).run();
      return null;
    });
    if (outcome === 'not_found') fail(404, 'not_found');
    if (outcome === 'unknown_group') fail(400, 'unknown_group');
    if (outcome === 'account_moved') fail(409, 'account_moved');
    return c.body(null, 204);
  })
  .post('/groups', async (c) => {
    const { name } = await body(c, CreateGroupBody);
    const id = randomUUID();
    const inserted = c
      .get('deps')
      .db.insert(accountGroups)
      .values({ id, name })
      .onConflictDoNothing({ target: accountGroups.name })
      .run();
    if (!inserted.changes) fail(409, 'group_name_taken');
    return c.json({ id }, 201);
  })
  .patch('/groups/:id', async (c) => {
    const { name } = await body(c, UpdateGroupBody);
    const id = c.req.param('id');
    const outcome = c.get('deps').db.transaction((tx) => {
      if (!tx.select().from(accountGroups).where(eq(accountGroups.id, id)).get()) return 'not_found' as const;
      if (
        tx
          .select()
          .from(accountGroups)
          .where(eq(accountGroups.name, name))
          .all()
          .some((g) => g.id !== id)
      ) {
        return 'group_name_taken' as const;
      }
      tx.update(accountGroups).set({ name }).where(eq(accountGroups.id, id)).run();
      return null;
    });
    if (outcome === 'not_found') fail(404, 'not_found');
    if (outcome) fail(409, outcome);
    return c.body(null, 204);
  })
  .put('/groups/:id/members', async (c) => {
    const { userIds } = await body(c, GroupMembersBody);
    const db = c.get('deps').db;
    const id = c.req.param('id');
    const outcome = db.transaction((tx) => {
      const group = tx.select().from(accountGroups).where(eq(accountGroups.id, id)).get();
      if (!group) return 'not_found' as const;
      if (group.protected && userIds.length) return 'protected_group' as const;
      const found = userIds.length ? tx.select().from(users).where(inArray(users.id, userIds)).all() : [];
      if (found.length !== new Set(userIds).size || found.some((u) => u.role !== 'member'))
        return 'members_only' as const;
      tx.delete(groupMembers).where(eq(groupMembers.groupId, id)).run();
      for (const u of found) tx.insert(groupMembers).values({ groupId: id, userId: u.id }).run();
      return null;
    });
    if (outcome === 'not_found') fail(404, 'not_found');
    if (outcome) fail(400, outcome);
    return c.body(null, 204);
  })
  .delete('/groups/:id', (c) => {
    const db = c.get('deps').db;
    const id = c.req.param('id');
    const outcome = db.transaction((tx) => {
      const group = tx.select().from(accountGroups).where(eq(accountGroups.id, id)).get();
      if (!group) return 'not_found' as const;
      if (group.protected) return 'protected_group' as const;
      const accounts = tx
        .select({ n: count() })
        .from(canonicalAccounts)
        .where(eq(canonicalAccounts.groupId, id))
        .get()!.n;
      if (accounts > 0) return 'group_not_empty' as const;
      tx.delete(groupMembers).where(eq(groupMembers.groupId, id)).run();
      tx.delete(accountGroups).where(eq(accountGroups.id, id)).run();
      return null;
    });
    if (outcome === 'not_found') fail(404, 'not_found');
    if (outcome) fail(409, outcome);
    return c.body(null, 204);
  })
  .get('/profiles', (c) => {
    const list: ProfileSummary[] = c
      .get('deps')
      .db.select()
      .from(providerProfiles)
      .all()
      .map((p) => ({
        id: p.id,
        name: p.name,
        environment: p.environment,
        hasCredentials: Boolean(p.clientId && p.secretRef),
      }));
    return c.json(list);
  })
  .post('/profiles', async (c) => {
    const input = await body(c, CreateProfileBody);
    const db = c.get('deps').db;
    if (db.select().from(providerProfiles).where(eq(providerProfiles.name, input.name)).get())
      fail(409, 'profile_name_taken');
    const id = randomUUID();
    db.insert(providerProfiles)
      .values({ id, ...input })
      .run();
    return c.json({ id }, 201);
  })
  .post('/profiles/:id/sandbox-items', async (c) => {
    const deps = c.get('deps');
    const profile =
      deps.db
        .select()
        .from(providerProfiles)
        .where(eq(providerProfiles.id, c.req.param('id')))
        .get() ?? fail(404, 'not_found');
    if (profile.environment !== 'sandbox') fail(400, 'sandbox_only');
    const created = await plaidFor(profile).createSandboxItem();
    const id = randomUUID();
    deps.db
      .insert(items)
      .values({
        id,
        profileId: profile.id,
        providerItemId: created.providerItemId,
        accessTokenEnc: encryptSecret(deps.masterKey, created.accessToken),
      })
      .run();
    syncItem(deps.sync, id, 'manual').catch((error: unknown) =>
      console.error('initial sync failed', id, error),
    );
    return c.json({ id }, 201);
  })
  .post('/demo-items', async (c) => {
    const { dataset } = await body(c, CreateDemoItemBody);
    const deps = c.get('deps');
    const id = createDemoItem(
      deps.db,
      deps.masterKey,
      dataset,
      new Date(deps.now()).toISOString().slice(0, 10),
      randomInt(1, 1_000_000),
    );
    const outcome = await syncItem(deps.sync, id, 'manual');
    return c.json({ id, outcome }, 201);
  })
  .get('/items', (c) => {
    const db = c.get('deps').db;
    const runs = db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(200).all();
    const accounts = db
      .select({ itemId: sourceAccounts.itemId, name: sourceAccounts.name })
      .from(sourceAccounts)
      .all();
    const list: ItemSummary[] = db
      .select({ item: items, profile: providerProfiles })
      .from(items)
      .innerJoin(providerProfiles, eq(providerProfiles.id, items.profileId))
      .orderBy(items.createdAt)
      .all()
      .map(({ item, profile }) => ({
        id: item.id,
        profileName: profile.name,
        environment: profile.environment,
        institutionName: item.institutionName,
        status: item.status,
        lastSyncAt: item.lastSyncAt,
        lastBalanceAt: item.lastBalanceAt,
        lastErrorCode: item.lastErrorCode,
        transactionsUpdateStatus: item.transactionsUpdateStatus,
        accountNames: accounts.filter((a) => a.itemId === item.id).map((a) => a.name),
        syncing: isSyncRunning(item.id),
        recentRuns: runs
          .filter((r) => r.itemId === item.id)
          .slice(0, 5)
          .map(runSummary),
      }));
    return c.json(list);
  })
  .post('/items/:id/sync', async (c) => {
    const deps = c.get('deps');
    const id = c.req.param('id');
    if (!deps.db.select().from(items).where(eq(items.id, id)).get()) fail(404, 'not_found');
    return c.json(await syncItem(deps.sync, id, 'manual'));
  });

function runSummary(r: typeof syncRuns.$inferSelect): SyncRunSummary {
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    attempts: r.attempts,
    counts: r.countsJson ? (JSON.parse(r.countsJson) as Record<string, number>) : null,
    errorCode: r.errorCode,
    balanceErrorCode: r.balanceErrorCode,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

export function createDemoItem(
  db: AppEnv['Variables']['deps']['db'],
  masterKey: Buffer,
  dataset: 'household-bank' | 'household-card',
  anchor: string,
  seed: number,
) {
  let profile = db.select().from(providerProfiles).where(eq(providerProfiles.environment, 'fixture')).get();
  if (!profile) {
    profile = {
      id: randomUUID(),
      name: 'Demo fixtures',
      environment: 'fixture',
      clientId: null,
      secretRef: null,
      createdAt: Date.now(),
    };
    db.insert(providerProfiles).values(profile).run();
  }
  const id = randomUUID();
  const token = JSON.stringify({ dataset, anchor, seed });
  db.insert(items)
    .values({
      id,
      profileId: profile.id,
      providerItemId: `fixture-${dataset}-${seed}`,
      accessTokenEnc: encryptSecret(masterKey, token),
    })
    .run();
  return id;
}

function listGroups(
  db: AppEnv['Variables']['deps']['db'],
  scope: AppEnv['Variables']['scope'],
  isAdmin: boolean,
): GroupSummary[] {
  const groups = db.select().from(accountGroups).orderBy(accountGroups.protected, accountGroups.name).all();
  const counts = db
    .select({ groupId: canonicalAccounts.groupId, n: count() })
    .from(canonicalAccounts)
    .groupBy(canonicalAccounts.groupId)
    .all();
  const members = isAdmin ? db.select().from(groupMembers).all() : [];
  return groups
    .filter((g) => canSeeGroup(scope, g.id))
    .map((g) => ({
      id: g.id,
      name: g.name,
      protected: g.protected,
      accountCount: counts
        .filter((x) => (x.groupId ?? UNASSIGNED_GROUP_ID) === g.id)
        .reduce((n, x) => n + x.n, 0),
      ...(isAdmin ? { memberIds: members.filter((m) => m.groupId === g.id).map((m) => m.userId) } : {}),
    }));
}

function moveImpact(
  db: AppEnv['Variables']['deps']['db'],
  accountId: string,
  toGroupId: string,
): MoveImpact | null {
  const account = db.select().from(canonicalAccounts).where(eq(canonicalAccounts.id, accountId)).get();
  const from =
    account &&
    db
      .select()
      .from(accountGroups)
      .where(eq(accountGroups.id, account.groupId ?? UNASSIGNED_GROUP_ID))
      .get();
  const to = db.select().from(accountGroups).where(eq(accountGroups.id, toGroupId)).get();
  if (!account || !from || !to) return null;
  const memberNames = (groupId: string) =>
    db
      .select({ username: users.username })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(eq(groupMembers.groupId, groupId))
      .all()
      .map((u) => u.username);
  const before = new Set(memberNames(from.id));
  const after = new Set(memberNames(to.id));
  const transactionCount = db
    .select({ n: count() })
    .from(canonicalTransactions)
    .where(eq(canonicalTransactions.canonicalAccountId, accountId))
    .get()!.n;
  const annotationCount = db
    .select({ n: count() })
    .from(annotations)
    .innerJoin(canonicalTransactions, eq(canonicalTransactions.id, annotations.canonicalTransactionId))
    .where(eq(canonicalTransactions.canonicalAccountId, accountId))
    .get()!.n;
  return {
    account: { id: account.id, name: account.displayName },
    from: { id: from.id, name: from.name },
    to: { id: to.id, name: to.name },
    losesAccess: [...before].filter((u) => !after.has(u)).sort(),
    gainsAccess: [...after].filter((u) => !before.has(u)).sort(),
    transactionCount,
    annotationCount,
  };
}
