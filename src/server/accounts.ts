import { and, asc, count, eq, inArray, isNotNull, isNull, max, sql } from 'drizzle-orm';
import type { AccountSummary, Overview } from '../shared/contracts.ts';
import type { Db } from './db/client.ts';
import {
  UNASSIGNED_GROUP_ID,
  accountGroups,
  annotations,
  canonicalAccounts,
  canonicalTransactions,
  items,
  sourceAccounts,
} from './db/schema.ts';
import { inScope, type AccountScope } from './http/context.ts';

export function listAccounts(db: Db, scope: AccountScope): AccountSummary[] {
  const rows = db
    .select({
      id: canonicalAccounts.id,
      displayName: canonicalAccounts.displayName,
      kind: canonicalAccounts.kind,
      currency: canonicalAccounts.currency,
      mask: sourceAccounts.mask,
      institutionName: items.institutionName,
      balanceCurrentMinor: sourceAccounts.balanceCurrentMinor,
      balanceAvailableMinor: sourceAccounts.balanceAvailableMinor,
      balanceLimitMinor: sourceAccounts.balanceLimitMinor,
      balanceFetchedAt: sourceAccounts.balanceFetchedAt,
      lastSyncAt: items.lastSyncAt,
      groupId: sql<string>`coalesce(${canonicalAccounts.groupId}, ${UNASSIGNED_GROUP_ID})`,
      groupName: sql<string>`coalesce(${accountGroups.name}, 'Unassigned')`,
      sourceCount: sql<number>`(select count(*) from ${sourceAccounts} s where s.canonical_account_id = ${canonicalAccounts.id})`,
    })
    .from(canonicalAccounts)
    .leftJoin(sourceAccounts, eq(sourceAccounts.id, canonicalAccounts.primarySourceAccountId))
    .leftJoin(items, eq(items.id, sourceAccounts.itemId))
    .leftJoin(accountGroups, eq(accountGroups.id, canonicalAccounts.groupId))
    .where(and(isNull(canonicalAccounts.archivedAt), inScope(scope, canonicalAccounts.id)))
    .orderBy(asc(canonicalAccounts.kind), asc(canonicalAccounts.displayName))
    .all();
  return rows;
}

export function overview(db: Db, scope: AccountScope, isAdmin: boolean): Overview {
  const accounts = listAccounts(db, scope);
  const groups = new Map<string, Overview['groups'][number]>();
  for (const a of accounts) {
    if (a.balanceCurrentMinor === null) continue;
    const kind = a.kind === 'depository' ? 'cash' : a.kind === 'credit' ? 'credit' : 'other';
    const key = `${kind}:${a.currency}`;
    const group = groups.get(key) ?? { kind, currency: a.currency, totalMinor: 0, accountCount: 0 };
    group.totalMinor += a.balanceCurrentMinor;
    group.accountCount++;
    groups.set(key, group);
  }
  const inAccounts = inScope(scope, canonicalTransactions.canonicalAccountId);
  const countWhere = (...conditions: Parameters<typeof and>) =>
    db
      .select({ n: count() })
      .from(canonicalTransactions)
      .leftJoin(annotations, eq(annotations.canonicalTransactionId, canonicalTransactions.id))
      .where(and(inAccounts, ...conditions))
      .get()!.n;
  const active = inArray(canonicalTransactions.status, ['pending', 'posted']);
  const lastSyncAt = accounts.reduce<number | null>(
    (m, a) => (a.lastSyncAt !== null && (m === null || a.lastSyncAt > m) ? a.lastSyncAt : m),
    null,
  );
  return {
    groups: [...groups.values()],
    review: {
      reconciliation: countWhere(eq(annotations.needsReconciliationReview, true)),
      lifecycle: countWhere(isNotNull(canonicalTransactions.lifecycleReview)),
      uncategorized: countWhere(active, isNull(annotations.category)),
      pending: countWhere(eq(canonicalTransactions.status, 'pending')),
    },
    lastSyncAt: isAdmin
      ? (db
          .select({ at: max(items.lastSyncAt) })
          .from(items)
          .get()?.at ?? null)
      : lastSyncAt,
    syncProblems: isAdmin
      ? db.select({ n: count() }).from(items).where(isNotNull(items.lastErrorCode)).get()!.n
      : null,
  };
}
