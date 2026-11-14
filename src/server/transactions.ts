import { randomUUID } from 'node:crypto';
import {
  aliasedTable,
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type {
  Annotation,
  AnnotationPatch,
  AnnotationRevision,
  TransactionDetail,
  TransactionFilter,
  TransactionPage,
  TransactionRow,
} from '../shared/contracts.ts';
import { currencyExponent } from '../shared/money.ts';
import type { Db } from './db/client.ts';
import {
  annotationHistory,
  annotations,
  canonicalAccounts,
  canonicalTransactions,
  items,
  sourceAccounts,
  sourceTransactions,
  transactionEvents,
  users,
} from './db/schema.ts';
import { canSee, inScope, type AccountScope } from './http/context.ts';
import type { ReconciledSnapshot } from './sync/engine.ts';

type Query = TransactionFilter;

const updater = aliasedTable(users, 'updater');
const reconciler = aliasedTable(users, 'reconciler');
const primarySource = aliasedTable(sourceAccounts, 'primary_source');

const rowSelect = {
  id: canonicalTransactions.id,
  accountId: canonicalTransactions.canonicalAccountId,
  accountName: canonicalAccounts.displayName,
  accountMask: primarySource.mask,
  date: canonicalTransactions.date,
  name: canonicalTransactions.name,
  merchantName: canonicalTransactions.merchantName,
  amountMinor: canonicalTransactions.amountMinor,
  currency: canonicalTransactions.currency,
  status: canonicalTransactions.status,
  providerCategory: canonicalTransactions.providerCategory,
  lifecycleReview: canonicalTransactions.lifecycleReview,
  category: annotations.category,
  kind: annotations.kind,
  note: annotations.note,
  tagsJson: annotations.tagsJson,
  owner: annotations.owner,
  isReconciled: annotations.isReconciled,
  reconciledAt: annotations.reconciledAt,
  reconciledBy: reconciler.username,
  needsReconciliationReview: annotations.needsReconciliationReview,
  revision: annotations.revision,
  updatedAt: annotations.updatedAt,
  updatedBy: updater.username,
};

function baseQuery(db: Db) {
  return db
    .select(rowSelect)
    .from(canonicalTransactions)
    .innerJoin(canonicalAccounts, eq(canonicalAccounts.id, canonicalTransactions.canonicalAccountId))
    .leftJoin(primarySource, eq(primarySource.id, canonicalAccounts.primarySourceAccountId))
    .leftJoin(annotations, eq(annotations.canonicalTransactionId, canonicalTransactions.id))
    .leftJoin(updater, eq(updater.id, annotations.updatedBy))
    .leftJoin(reconciler, eq(reconciler.id, annotations.reconciledBy));
}

type RawRow = Awaited<ReturnType<ReturnType<typeof baseQuery>['all']>>[number];

function toRow(r: RawRow): TransactionRow {
  const annotation: Annotation = {
    category: r.category ?? null,
    kind: r.kind ?? null,
    note: r.note ?? '',
    tags: r.tagsJson ? (JSON.parse(r.tagsJson) as string[]) : [],
    owner: r.owner ?? null,
    isReconciled: r.isReconciled ?? false,
    reconciledAt: r.reconciledAt ?? null,
    reconciledBy: r.reconciledBy ?? null,
    needsReconciliationReview: r.needsReconciliationReview ?? false,
    revision: r.revision ?? 0,
    updatedAt: r.updatedAt ?? null,
    updatedBy: r.updatedBy ?? null,
  };
  return {
    id: r.id,
    accountId: r.accountId,
    accountName: r.accountName,
    accountMask: r.accountMask ?? null,
    date: r.date,
    name: r.name,
    merchantName: r.merchantName,
    amountMinor: r.amountMinor,
    currency: r.currency,
    status: r.status,
    providerCategory: r.providerCategory,
    lifecycleReview: r.lifecycleReview,
    annotation,
  };
}

const encodeCursor = (date: string, id: string) => Buffer.from(`${date}|${id}`).toString('base64url');
function decodeCursor(cursor: string) {
  const [date, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  return date && id ? { date, id } : null;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export function filterConditions(scope: AccountScope, q: Query): SQL[] {
  const conditions: (SQL | undefined)[] = [inScope(scope, canonicalTransactions.canonicalAccountId)];
  if (q.account) conditions.push(eq(canonicalTransactions.canonicalAccountId, q.account));
  if (q.status === 'active') conditions.push(inArray(canonicalTransactions.status, ['pending', 'posted']));
  else if (q.status !== 'all') conditions.push(eq(canonicalTransactions.status, q.status));
  if (q.q) {
    const pattern = `%${escapeLike(q.q)}%`;
    const match = (col: Parameters<typeof like>[0]) => sql`${col} like ${pattern} escape '\\'`;
    conditions.push(
      or(
        match(canonicalTransactions.name),
        match(canonicalTransactions.merchantName),
        match(annotations.note),
        match(annotations.category),
        sql`exists (select 1 from json_each(${annotations.tagsJson}) where value like ${pattern} escape '\\')`,
      ),
    );
  }
  if (q.category) conditions.push(eq(annotations.category, q.category));
  if (q.reconciled === 'yes') conditions.push(eq(annotations.isReconciled, true));
  if (q.reconciled === 'no')
    conditions.push(or(isNull(annotations.isReconciled), eq(annotations.isReconciled, false)));
  const reconciliation = eq(annotations.needsReconciliationReview, true);
  const lifecycle = isNotNull(canonicalTransactions.lifecycleReview);
  const uncategorized = and(
    isNull(annotations.category),
    inArray(canonicalTransactions.status, ['pending', 'posted']),
  );
  if (q.review === 'reconciliation') conditions.push(reconciliation);
  if (q.review === 'lifecycle') conditions.push(lifecycle);
  if (q.review === 'uncategorized') conditions.push(uncategorized);
  if (q.review === 'any') conditions.push(or(reconciliation, lifecycle));
  if (q.from) conditions.push(gte(canonicalTransactions.date, q.from));
  if (q.to) conditions.push(lte(canonicalTransactions.date, q.to));
  return conditions.filter((c): c is SQL => c !== undefined);
}

export function listTransactions(db: Db, scope: AccountScope, q: Query): TransactionPage {
  const conditions = filterConditions(scope, q);
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  if (after) {
    conditions.push(
      or(
        lt(canonicalTransactions.date, after.date),
        and(eq(canonicalTransactions.date, after.date), lt(canonicalTransactions.id, after.id)),
      )!,
    );
  }
  const raw = baseQuery(db)
    .where(and(...conditions))
    .orderBy(desc(canonicalTransactions.date), desc(canonicalTransactions.id))
    .limit(q.limit + 1)
    .all();
  const rows = raw.slice(0, q.limit).map(toRow);
  const last = rows[rows.length - 1];
  return { rows, nextCursor: raw.length > q.limit && last ? encodeCursor(last.date, last.id) : null };
}

export function exportRows(db: Db, scope: AccountScope, q: Query) {
  return baseQuery(db)
    .where(and(...filterConditions(scope, q)))
    .orderBy(desc(canonicalTransactions.date), desc(canonicalTransactions.id))
    .all()
    .map(toRow);
}

export function getRow(db: Db, scope: AccountScope, id: string): TransactionRow | undefined {
  const raw = baseQuery(db).where(eq(canonicalTransactions.id, id)).get();
  if (!raw || !canSee(scope, raw.accountId)) return undefined;
  return toRow(raw);
}

export function getDetail(db: Db, scope: AccountScope, id: string): TransactionDetail | undefined {
  const row = getRow(db, scope, id);
  if (!row) return undefined;
  const canonical = db.select().from(canonicalTransactions).where(eq(canonicalTransactions.id, id)).get()!;
  const sources = db
    .select({
      id: sourceTransactions.id,
      institutionName: items.institutionName,
      accountName: sourceAccounts.name,
      pending: sourceTransactions.pending,
      amountMinor: sourceTransactions.amountMinor,
      currency: sourceTransactions.currency,
      date: sourceTransactions.date,
      name: sourceTransactions.name,
      removedAt: sourceTransactions.removedAt,
      supersededById: sourceTransactions.supersededById,
      providerTransactionId: sourceTransactions.providerTransactionId,
    })
    .from(sourceTransactions)
    .innerJoin(sourceAccounts, eq(sourceAccounts.id, sourceTransactions.sourceAccountId))
    .innerJoin(items, eq(items.id, sourceTransactions.itemId))
    .where(eq(sourceTransactions.canonicalTransactionId, id))
    .orderBy(asc(sourceTransactions.createdAt))
    .all()
    .map(({ supersededById, providerTransactionId, ...s }) => ({
      ...s,
      superseded: supersededById !== null,
      preferred: s.id === canonical.preferredSourceId,
      providerRef: `…${providerTransactionId.slice(-6)}`,
    }));
  const events = db
    .select()
    .from(transactionEvents)
    .where(eq(transactionEvents.canonicalTransactionId, id))
    .orderBy(asc(transactionEvents.at))
    .all()
    .map((e) => ({ kind: e.kind, at: e.at, detail: JSON.parse(e.detailJson) as Record<string, unknown> }));
  const history: AnnotationRevision[] = db
    .select({
      revision: annotationHistory.revision,
      at: annotationHistory.at,
      actor: users.username,
      cause: annotationHistory.cause,
      snapshotJson: annotationHistory.snapshotJson,
    })
    .from(annotationHistory)
    .leftJoin(users, eq(users.id, annotationHistory.actor))
    .where(eq(annotationHistory.canonicalTransactionId, id))
    .orderBy(desc(annotationHistory.revision))
    .all()
    .map((h) => ({
      revision: h.revision,
      at: h.at,
      actor: h.actor,
      cause: h.cause,
      summary: summarize(h.snapshotJson),
    }));
  return { ...row, sources, events, history };
}

function summarize(snapshotJson: string) {
  const s = JSON.parse(snapshotJson) as { changed?: string[]; needsReconciliationReview?: boolean };
  if (s.changed) return s.changed.length ? `Changed ${s.changed.join(', ')}` : 'Saved without changes';
  return s.needsReconciliationReview ? 'Amount, date, or account changed after reconciliation' : 'Updated';
}

export type PatchResult =
  | { kind: 'ok'; row: TransactionRow }
  | { kind: 'conflict'; row: TransactionRow }
  | { kind: 'not_found' };

export function patchAnnotation(
  db: Db,
  scopeOrFresh: AccountScope | ((tx: Db) => AccountScope),
  actorId: string,
  id: string,
  patch: AnnotationPatch,
  now: number,
): PatchResult {
  return db.transaction((tx) => {
    const scope = typeof scopeOrFresh === 'function' ? scopeOrFresh(tx as unknown as Db) : scopeOrFresh;
    const row = getRow(tx as unknown as Db, scope, id);
    if (!row) return { kind: 'not_found' as const };
    if (row.annotation.revision !== patch.revision) return { kind: 'conflict' as const, row };
    const confirmsValues =
      patch.acknowledgeReview || (patch.isReconciled === true && !row.annotation.isReconciled);
    const seenCurrent =
      patch.seen?.amountMinor === row.amountMinor &&
      patch.seen.date === row.date &&
      patch.seen.accountId === row.accountId;
    if (confirmsValues && !seenCurrent) return { kind: 'conflict' as const, row };

    const before = row.annotation;
    const snapshot: ReconciledSnapshot = {
      amountMinor: row.amountMinor,
      date: row.date,
      canonicalAccountId: row.accountId,
    };
    const next = {
      category: patch.category === undefined ? before.category : patch.category,
      kind: patch.kind === undefined ? before.kind : patch.kind,
      note: patch.note ?? before.note,
      tagsJson: JSON.stringify(patch.tags ?? before.tags),
      owner: patch.owner === undefined ? before.owner : patch.owner,
    };
    const reconcile = patch.isReconciled ?? before.isReconciled;
    const reconcileFields =
      reconcile && (!before.isReconciled || patch.acknowledgeReview)
        ? {
            isReconciled: true,
            reconciledAt: now,
            reconciledBy: actorId,
            reconciledSnapshotJson: JSON.stringify(snapshot),
            needsReconciliationReview: false,
          }
        : !reconcile
          ? {
              isReconciled: false,
              reconciledAt: null,
              reconciledBy: null,
              reconciledSnapshotJson: null,
              needsReconciliationReview: false,
            }
          : {};
    const revision = before.revision + 1;
    const values = { ...next, ...reconcileFields, revision, updatedAt: now, updatedBy: actorId };
    tx.insert(annotations)
      .values({ canonicalTransactionId: id, ...values })
      .onConflictDoUpdate({ target: annotations.canonicalTransactionId, set: values })
      .run();
    if (patch.acknowledgeReview && row.lifecycleReview) {
      tx.update(canonicalTransactions)
        .set({ lifecycleReview: null })
        .where(eq(canonicalTransactions.id, id))
        .run();
    }
    const changed = [
      next.category !== before.category && 'category',
      next.kind !== before.kind && 'counts as',
      next.note !== before.note && 'note',
      next.tagsJson !== JSON.stringify(before.tags) && 'tags',
      next.owner !== before.owner && 'owner',
      reconcile !== before.isReconciled && (reconcile ? 'reconciled' : 'unreconciled'),
      patch.acknowledgeReview && 'review acknowledged',
    ].filter((x): x is string => typeof x === 'string');
    tx.insert(annotationHistory)
      .values({
        id: randomUUID(),
        canonicalTransactionId: id,
        revision,
        actor: actorId,
        cause: 'user',
        snapshotJson: JSON.stringify({ ...values, changed }),
        at: now,
      })
      .run();
    return { kind: 'ok' as const, row: getRow(tx as unknown as Db, scope, id)! };
  });
}

export function categoriesInScope(db: Db, scope: AccountScope) {
  return db
    .selectDistinct({ category: annotations.category })
    .from(annotations)
    .innerJoin(canonicalTransactions, eq(canonicalTransactions.id, annotations.canonicalTransactionId))
    .where(and(isNotNull(annotations.category), inScope(scope, canonicalTransactions.canonicalAccountId)))
    .orderBy(asc(annotations.category))
    .all()
    .map((r) => r.category!);
}

const csvCell = (value: string | number | null) => {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(rows: TransactionRow[]) {
  const header = [
    'date',
    'account',
    'description',
    'merchant',
    'amount',
    'currency',
    'direction',
    'status',
    'category',
    'tags',
    'owner',
    'note',
    'reconciled',
  ];
  const lines = rows.map((r) => {
    const exponent = currencyExponent(r.currency);
    const amount = (Math.abs(r.amountMinor) / 10 ** exponent).toFixed(exponent);
    return [
      r.date,
      r.accountName,
      r.name,
      r.merchantName,
      amount,
      r.currency,
      r.amountMinor > 0 ? 'outflow' : 'inflow',
      r.status,
      r.annotation.category,
      r.annotation.tags.join('; '),
      r.annotation.owner,
      r.annotation.note,
      r.annotation.isReconciled ? 'yes' : 'no',
    ]
      .map(csvCell)
      .join(',');
  });
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}
