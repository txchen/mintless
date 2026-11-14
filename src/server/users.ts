import { and, count, eq, isNull, ne } from 'drizzle-orm';
import type { Role } from '../shared/contracts.ts';
import type { Db } from './db/client.ts';
import { sessions, users } from './db/schema.ts';

export type UserChange = { role?: Role; disabled?: boolean; password?: string; groupIds?: string[] };
type Target = typeof users.$inferSelect;
type Reader = Pick<Db, 'select'>;

export type UserChangeError =
  | 'admin_password_cli_only'
  | 'cannot_change_own_access'
  | 'promotion_needs_cli_password'
  | 'last_admin'
  | 'groups_require_members';

export function checkUserChange(
  db: Reader,
  actorId: string,
  target: Target,
  change: UserChange,
): UserChangeError | null {
  const nextRole = change.role ?? target.role;
  if (change.password !== undefined && (target.role === 'admin' || nextRole === 'admin'))
    return 'admin_password_cli_only';
  const changesRole = change.role !== undefined && change.role !== target.role;
  if (target.id === actorId && (changesRole || change.disabled === true)) return 'cannot_change_own_access';
  if (changesRole && nextRole === 'admin' && target.passwordSetBy !== 'cli')
    return 'promotion_needs_cli_password';
  if (change.groupIds !== undefined && nextRole !== 'member') return 'groups_require_members';
  const removesAdmin =
    target.role === 'admin' &&
    target.disabledAt === null &&
    (nextRole !== 'admin' || change.disabled === true);
  if (removesAdmin) {
    const others = db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), ne(users.id, target.id)))
      .get()!.n;
    if (others === 0) return 'last_admin';
  }
  return null;
}

export function setPasswordHash(
  db: Db,
  userId: string,
  passwordHash: string,
  via: 'cli' | 'self' | 'admin',
  now: number,
  keepSessionHash?: string,
) {
  return db.transaction((tx) => {
    const memberOnly = via === 'cli' ? undefined : eq(users.role, 'member');
    const changed = tx
      .update(users)
      .set({ passwordHash, passwordSetBy: via })
      .where(and(eq(users.id, userId), memberOnly))
      .run().changes;
    if (!changed) return false;
    tx.update(sessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          keepSessionHash ? ne(sessions.tokenHash, keepSessionHash) : undefined,
        ),
      )
      .run();
    return true;
  });
}
