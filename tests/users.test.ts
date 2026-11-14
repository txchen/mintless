import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vite-plus/test';
import type { UserSummary } from '../src/shared/contracts.ts';
import { verifyPassword } from '../src/server/crypto.ts';
import {
  groupMembers,
  canonicalAccounts,
  sessions,
  transactionEvents,
  users,
} from '../src/server/db/schema.ts';
import { syncItem } from '../src/server/sync/engine.ts';
import { checkUserChange, setPasswordHash } from '../src/server/users.ts';
import { hashPassword } from '../src/server/crypto.ts';
import { addFixtureItem, addUser, login, setup } from './helpers.ts';

async function world() {
  const env = setup();
  await syncItem(env.sync, addFixtureItem(env.db), 'manual');
  const rootId = await addUser(env.db, 'root', 'admin');
  const otherAdminId = await addUser(env.db, 'ops', 'admin');
  const memberId = await addUser(env.db, 'mia', 'member');
  const admin = await login(env.api, 'root');
  const member = await login(env.api, 'mia');
  const patch = (c: typeof admin, id: string, body: object) =>
    c.call(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  const hashOf = (id: string) => env.db.select().from(users).where(eq(users.id, id)).get()!.passwordHash;
  return { ...env, rootId, otherAdminId, memberId, admin, member, patch, hashOf };
}

const newPassword = 'a-brand-new-passphrase';

describe('administrator passwords are CLI-only', () => {
  it('rejects every browser path that would set an admin password', async () => {
    const w = await world();
    const before = { root: w.hashOf(w.rootId), ops: w.hashOf(w.otherAdminId), mia: w.hashOf(w.memberId) };
    const self = await w.admin.call('/session/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: 'correct-horse-battery', newPassword }),
    });
    expect(self.status).toBe(403);
    const attempts = [
      [w.otherAdminId, { password: newPassword }],
      [w.otherAdminId, { role: 'member', password: newPassword }],
      [w.otherAdminId, { role: 'admin', password: newPassword }],
      [w.otherAdminId, { disabled: false, password: newPassword }],
      [w.rootId, { password: newPassword }],
      [w.memberId, { role: 'admin', password: newPassword }],
    ] as const;
    for (const [id, body] of attempts)
      expect((await w.patch(w.admin, id, body)).status, JSON.stringify(body)).toBe(403);
    expect({ root: w.hashOf(w.rootId), ops: w.hashOf(w.otherAdminId), mia: w.hashOf(w.memberId) }).toEqual(
      before,
    );
    expect(w.db.select().from(users).where(eq(users.id, w.memberId)).get()!.role).toBe('member');
  });

  it('blocks demote, reset, self-change, promote as a way to set an admin password', async () => {
    const w = await world();
    expect((await w.patch(w.admin, w.otherAdminId, { role: 'member' })).status).toBe(204);
    expect((await w.patch(w.admin, w.otherAdminId, { password: newPassword })).status).toBe(204);
    const promote = await w.patch(w.admin, w.otherAdminId, { role: 'admin' });
    expect(promote.status).toBe(409);
    expect(await promote.json()).toMatchObject({ error: 'promotion_needs_cli_password' });

    const ops = await login(w.api, 'ops', newPassword);
    const selfChange = await ops.call('/session/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: newPassword, newPassword: 'known-to-the-other-admin' }),
    });
    expect(selfChange.status).toBe(204);
    expect(
      (await w.patch(w.admin, w.otherAdminId, { role: 'admin' })).status,
      'a browser-chosen password never becomes an admin password',
    ).toBe(409);

    setPasswordHash(w.db, w.otherAdminId, await hashPassword('set-on-the-server'), 'cli', Date.now());
    expect((await w.patch(w.admin, w.otherAdminId, { role: 'admin' })).status).toBe(204);
  });

  it('re-checks inside the write, so a concurrent promotion cannot carry a browser password', async () => {
    const w = await world();
    expect((await w.patch(w.admin, w.otherAdminId, { role: 'member' })).status).toBe(204);
    const [reset, promote] = await Promise.all([
      w.patch(w.admin, w.otherAdminId, { password: newPassword }),
      w.patch(w.admin, w.otherAdminId, { role: 'admin' }),
    ]);
    const ops = w.db.select().from(users).where(eq(users.id, w.otherAdminId)).get()!;
    expect([reset.status, promote.status].sort((a, b) => a - b)).toEqual([204, 403]);
    expect(ops).toMatchObject({ role: 'admin', passwordSetBy: 'cli' });
    expect(await verifyPassword(newPassword, ops.passwordHash)).toBe(false);

    const member = await login(w.api, 'mia');
    const [selfChange, promoteMember] = await Promise.all([
      member.call('/session/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: 'correct-horse-battery', newPassword }),
      }),
      (async () => {
        setPasswordHash(w.db, w.memberId, await hashPassword('correct-horse-battery'), 'cli', Date.now());
        return w.patch(w.admin, w.memberId, { role: 'admin' });
      })(),
    ]);
    const mia = w.db.select().from(users).where(eq(users.id, w.memberId)).get()!;
    if (mia.role === 'admin')
      expect(await verifyPassword(newPassword, mia.passwordHash), 'self-change lost the race cleanly').toBe(
        false,
      );
    expect([selfChange.status, promoteMember.status]).not.toContain(500);
  });

  it('creates only members from the browser', async () => {
    const w = await world();
    const admin = await w.admin.call('/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'boss', password: newPassword, role: 'admin' }),
    });
    expect(admin.status).toBe(400);
    const member = await w.admin.call('/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'kid', password: newPassword, role: 'member' }),
    });
    expect(member.status).toBe(201);
    const list = (await (await w.admin.call('/admin/users')).json()) as UserSummary[];
    expect(list.find((u) => u.username === 'kid')).toMatchObject({
      role: 'member',
      passwordFromCli: false,
    });
    expect(list.find((u) => u.username === 'boss')).toBeUndefined();
  });
});

describe('member management', () => {
  it('keeps member self-service and admin resets for members', async () => {
    const w = await world();
    const own = await w.member.call('/session/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: 'correct-horse-battery', newPassword }),
    });
    expect(own.status).toBe(204);
    expect((await w.member.call('/transactions?limit=1')).status, 'current session survives').toBe(200);
    expect((await w.patch(w.admin, w.memberId, { password: 'reset-by-an-admin' })).status).toBe(204);
    expect((await w.member.call('/transactions?limit=1')).status, 'admin reset signs the member out').toBe(
      401,
    );
    expect(await verifyPassword('reset-by-an-admin', w.hashOf(w.memberId))).toBe(true);
  });

  it('replaces a member group set atomically, refuses admins and the protected group, and rejects old fields', async () => {
    const w = await world();
    const a = await w.admin.call('/admin/groups', { method: 'POST', body: JSON.stringify({ name: 'A' }) });
    const b = await w.admin.call('/admin/groups', { method: 'POST', body: JSON.stringify({ name: 'B' }) });
    const ga = ((await a.json()) as { id: string }).id;
    const gb = ((await b.json()) as { id: string }).id;
    expect((await w.patch(w.admin, w.memberId, { groupIds: [ga, gb] })).status).toBe(204);
    const groupsOf = () =>
      w.db
        .select()
        .from(groupMembers)
        .where(eq(groupMembers.userId, w.memberId))
        .all()
        .map((m) => m.groupId)
        .sort();
    expect(groupsOf()).toEqual([ga, gb].sort());
    expect((await w.patch(w.admin, w.memberId, { groupIds: ['missing'] })).status).toBe(400);
    expect(
      (await w.patch(w.admin, w.memberId, { groupIds: ['unassigned'] })).status,
      'the Unassigned group stays admin-only',
    ).toBe(400);
    expect((await w.patch(w.admin, w.otherAdminId, { groupIds: [ga] })).status).toBe(409);
    expect((await w.patch(w.admin, w.memberId, { role: 'admin', groupIds: [ga] })).status).toBe(409);
    expect(
      (await w.patch(w.admin, w.memberId, { accountIds: [] })).status,
      'the old per-account field is rejected',
    ).toBe(400);
    expect(groupsOf()).toEqual([ga, gb].sort());
  });

  it('protects the acting admin and the last active admin, and forbids members', async () => {
    const w = await world();
    expect((await w.patch(w.admin, w.rootId, { disabled: true })).status).toBe(409);
    expect((await w.patch(w.admin, w.rootId, { role: 'member' })).status).toBe(409);
    const ops = w.db.select().from(users).where(eq(users.id, w.otherAdminId)).get()!;
    w.db.update(users).set({ disabledAt: 1 }).where(eq(users.id, w.rootId)).run();
    expect(checkUserChange(w.db, 'someone-else', ops, { role: 'member' })).toBe('last_admin');
    expect(checkUserChange(w.db, 'someone-else', ops, { disabled: true })).toBe('last_admin');
    w.db.update(users).set({ disabledAt: null }).where(eq(users.id, w.rootId)).run();

    for (const body of [{ role: 'admin' }, { password: newPassword }, { groupIds: [] }]) {
      expect((await w.patch(w.member, w.memberId, body)).status).toBe(403);
    }
    expect((await w.api.request(`/api/admin/users/${w.memberId}`, { method: 'PATCH' })).status).toBe(401);
  });
});

describe('CLI password reset', () => {
  it('replaces the hash, revokes every session, and leaves role, grants and history untouched', async () => {
    const w = await world();
    const ids = w.db
      .select()
      .from(canonicalAccounts)
      .all()
      .map((a) => a.id);
    const created = await w.admin.call('/admin/groups', {
      method: 'POST',
      body: JSON.stringify({ name: 'Kept' }),
    });
    const kept = ((await created.json()) as { id: string }).id;
    await w.patch(w.admin, w.memberId, { groupIds: [kept] });
    expect(ids.length).toBeGreaterThan(0);
    const events = w.db.select().from(transactionEvents).all().length;
    setPasswordHash(w.db, w.rootId, await hashPassword(newPassword), 'cli', Date.now());
    expect((await w.admin.call('/transactions?limit=1')).status).toBe(401);
    expect(
      w.db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, w.rootId))
        .all()
        .every((s) => s.revokedAt !== null),
    ).toBe(true);
    const root = w.db.select().from(users).where(eq(users.id, w.rootId)).get()!;
    expect(root).toMatchObject({ role: 'admin', passwordSetBy: 'cli', disabledAt: null });
    await login(w.api, 'root', newPassword);
    await expect(login(w.api, 'root')).rejects.toThrow();
    expect(w.db.select().from(groupMembers).all()).toHaveLength(1);
    expect(w.db.select().from(transactionEvents).all()).toHaveLength(events);
  });
});
