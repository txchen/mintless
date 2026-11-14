import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { ChangePasswordBody, LoginBody, type SessionInfo } from '../../shared/contracts.ts';
import { hashPassword, randomToken, sha256, verifyPassword } from '../crypto.ts';
import { sessions, users } from '../db/schema.ts';
import { setPasswordHash } from '../users.ts';
import { body, fail, loadSession, requireSession, SESSION_COOKIE, type AppEnv } from './context.ts';

const failures = new Map<string, { count: number; until: number }>();
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const MAX_TRACKED = 10_000;
const decoyHash = hashPassword(randomToken());

export const authRoutes = new Hono<AppEnv>()
  .get('/session', (c) => {
    const deps = c.get('deps');
    const session = loadSession(deps.db, getCookie(c, SESSION_COOKIE), deps.now());
    if (!session) return c.json({ error: 'unauthenticated' }, 401);
    const info: SessionInfo = {
      user: { id: session.id, username: session.username, role: session.role },
      csrfToken: session.csrfToken,
    };
    return c.json(info);
  })
  .post('/session', async (c) => {
    const deps = c.get('deps');
    const { username, password } = await body(c, LoginBody);
    const now = deps.now();
    const attempt = reserveAttempt(username, now);
    if (!attempt) fail(429, 'too_many_attempts');

    const user = deps.db.select().from(users).where(eq(users.username, username)).get();
    const ok = user
      ? await verifyPassword(password, user.passwordHash)
      : (await verifyPassword(password, await decoyHash), false);
    if (!user || !ok || user.disabledAt !== null) fail(401, 'invalid_credentials');
    failures.delete(username);

    const token = randomToken();
    const csrfToken = randomToken();
    const expiresAt = now + deps.sessionTtlMs;
    deps.db
      .insert(sessions)
      .values({ tokenHash: sha256(token), userId: user.id, csrfToken, expiresAt })
      .run();
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttps(c.req.url, c.req.header('x-forwarded-proto')),
      path: '/',
      expires: new Date(expiresAt),
    });
    const info: SessionInfo = { user: { id: user.id, username: user.username, role: user.role }, csrfToken };
    return c.json(info);
  })
  .delete('/session', requireSession, (c) => {
    const token = getCookie(c, SESSION_COOKIE)!;
    const deps = c.get('deps');
    deps.db
      .update(sessions)
      .set({ revokedAt: deps.now() })
      .where(eq(sessions.tokenHash, sha256(token)))
      .run();
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  })
  .post('/session/password', requireSession, async (c) => {
    const deps = c.get('deps');
    const input = await body(c, ChangePasswordBody);
    const user = deps.db
      .select()
      .from(users)
      .where(eq(users.id, c.get('user').id))
      .get()!;
    if (user.role === 'admin') fail(403, 'admin_password_cli_only');
    if (!(await verifyPassword(input.currentPassword, user.passwordHash)))
      fail(400, 'invalid_current_password');
    const passwordHash = await hashPassword(input.newPassword);
    const saved = setPasswordHash(
      deps.db,
      user.id,
      passwordHash,
      'self',
      deps.now(),
      sha256(getCookie(c, SESSION_COOKIE)!),
    );
    if (!saved) fail(403, 'admin_password_cli_only');
    return c.body(null, 204);
  });

function reserveAttempt(key: string, now: number) {
  if (failures.size >= MAX_TRACKED && !failures.has(key)) {
    for (const [k, r] of failures) if (r.until <= now) failures.delete(k);
    const evict = (locked: boolean) => {
      for (const [k, r] of failures) {
        if (failures.size < MAX_TRACKED) return;
        if (locked || r.count < MAX_FAILURES) failures.delete(k);
      }
    };
    evict(false);
    evict(true);
  }
  const record = failures.get(key);
  const count = record && record.until > now ? record.count : 0;
  if (count >= MAX_FAILURES) return false;
  failures.set(key, { count: count + 1, until: now + LOCK_MS });
  return true;
}

function isHttps(url: string, forwardedProto: string | undefined) {
  return url.startsWith('https:') || forwardedProto?.split(',')[0]?.trim() === 'https';
}
