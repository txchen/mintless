import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { and, eq, gt, inArray, isNull, sql, type Column, type SQL } from 'drizzle-orm';
import * as v from 'valibot';
import type { SessionUser } from '../../shared/contracts.ts';
import { sha256 } from '../crypto.ts';
import type { Db } from '../db/client.ts';
import {
  UNASSIGNED_GROUP_ID,
  accountGroups,
  canonicalAccounts,
  groupMembers,
  sessions,
  users,
} from '../db/schema.ts';
import type { SyncDeps } from '../sync/engine.ts';

export type AppDeps = { db: Db; masterKey: Buffer; sessionTtlMs: number; sync: SyncDeps; now: () => number };

export type AccountScope = { kind: 'all' } | { kind: 'granted'; accountIds: string[]; groupIds: string[] };

export type AppEnv = {
  Variables: { deps: AppDeps; user: SessionUser; csrfToken: string; scope: AccountScope };
};

export const SESSION_COOKIE = 'mintless_session';

export function fail(status: 400 | 401 | 403 | 404 | 409 | 429, error: string, extra: object = {}): never {
  throw new HTTPException(status, { res: Response.json({ error, ...extra }, { status }) });
}

export async function body<S extends v.GenericSchema>(c: Context, schema: S): Promise<v.InferOutput<S>> {
  if (!c.req.header('content-type')?.startsWith('application/json')) fail(400, 'expected_json');
  const raw: unknown = await c.req.json().catch(() => fail(400, 'invalid_json'));
  const result = v.safeParse(schema, raw);
  if (!result.success)
    fail(400, 'invalid_request', {
      issues: result.issues.map((i) => ({ path: v.getDotPath(i), message: i.message })),
    });
  return result.output;
}

export function query<S extends v.GenericSchema>(c: Context, schema: S): v.InferOutput<S> {
  const result = v.safeParse(schema, c.req.query());
  if (!result.success)
    fail(400, 'invalid_query', {
      issues: result.issues.map((i) => ({ path: v.getDotPath(i), message: i.message })),
    });
  return result.output;
}

export function loadSession(db: Db, token: string | undefined, now: number) {
  if (!token) return undefined;
  return db
    .select({ id: users.id, username: users.username, role: users.role, csrfToken: sessions.csrfToken })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, sha256(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        isNull(users.disabledAt),
      ),
    )
    .get();
}

export function scopeFor(db: Db, user: SessionUser): AccountScope {
  if (user.role === 'admin') return { kind: 'all' };
  const groups = db
    .select({ id: groupMembers.groupId })
    .from(groupMembers)
    .innerJoin(accountGroups, eq(accountGroups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.userId, user.id), eq(accountGroups.protected, false)))
    .all()
    .map((g) => g.id);
  const accounts = groups.length
    ? db
        .select({ id: canonicalAccounts.id })
        .from(canonicalAccounts)
        .where(inArray(canonicalAccounts.groupId, groups))
        .all()
    : [];
  return { kind: 'granted', accountIds: accounts.map((a) => a.id), groupIds: groups };
}

export function narrowToGroup(db: Db, scope: AccountScope, groupId: string | undefined): AccountScope {
  if (!groupId) return scope;
  if (scope.kind === 'granted' && !scope.groupIds.includes(groupId))
    return { kind: 'granted', accountIds: [], groupIds: [] };
  const inGroup = db
    .select({ id: canonicalAccounts.id })
    .from(canonicalAccounts)
    .where(eq(canonicalAccounts.groupId, groupId))
    .all()
    .map((a) => a.id);
  const accountIds = scope.kind === 'all' ? inGroup : inGroup.filter((id) => scope.accountIds.includes(id));
  return { kind: 'granted', accountIds, groupIds: [groupId] };
}

export function narrowToAccount(db: Db, scope: AccountScope, accountId: string | undefined): AccountScope {
  if (!accountId) return scope;
  const empty: AccountScope = { kind: 'granted', accountIds: [], groupIds: [] };
  if (scope.kind === 'granted' && !scope.accountIds.includes(accountId)) return empty;
  const account = db
    .select({ groupId: canonicalAccounts.groupId })
    .from(canonicalAccounts)
    .where(eq(canonicalAccounts.id, accountId))
    .get();
  if (!account) return empty;
  return { kind: 'granted', accountIds: [accountId], groupIds: [account.groupId ?? UNASSIGNED_GROUP_ID] };
}

export function intersectScopes(fresh: AccountScope, requested: AccountScope): AccountScope {
  if (requested.kind === 'all') return fresh;
  if (fresh.kind === 'all') return requested;
  return {
    kind: 'granted',
    accountIds: fresh.accountIds.filter((id) => requested.accountIds.includes(id)),
    groupIds: fresh.groupIds.filter((id) => requested.groupIds.includes(id)),
  };
}

export const canSeeGroup = (scope: AccountScope, groupId: string) =>
  scope.kind === 'all' || scope.groupIds.includes(groupId);

export function inScope(scope: AccountScope, column: Column): SQL | undefined {
  if (scope.kind === 'all') return undefined;
  return scope.accountIds.length ? inArray(column, scope.accountIds) : sql`0 = 1`;
}

export const canSee = (scope: AccountScope, accountId: string) =>
  scope.kind === 'all' || scope.accountIds.includes(accountId);

const unsafe = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const deps = c.get('deps');
  const session = loadSession(deps.db, getCookie(c, SESSION_COOKIE), deps.now());
  if (!session) fail(401, 'unauthenticated');
  if (unsafe.has(c.req.method)) {
    const header = Buffer.from(c.req.header('x-csrf-token') ?? '');
    const expected = Buffer.from(session.csrfToken);
    if (header.length !== expected.length || !timingSafeEqual(header, expected)) fail(403, 'csrf');
  }
  const user = { id: session.id, username: session.username, role: session.role };
  c.set('user', user);
  c.set('csrfToken', session.csrfToken);
  c.set('scope', scopeFor(deps.db, user));
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('user').role !== 'admin') fail(403, 'forbidden');
  await next();
};
