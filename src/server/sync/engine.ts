import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { decryptSecret } from '../crypto.ts';
import type { Db } from '../db/client.ts';
import {
  UNASSIGNED_GROUP_ID,
  annotationHistory,
  annotations,
  canonicalAccounts,
  canonicalTransactions,
  items,
  providerProfiles,
  sourceAccounts,
  sourceTransactions,
  syncRuns,
  transactionEvents,
} from '../db/schema.ts';
import {
  ProviderError,
  type ProviderAccount,
  type ProviderTransaction,
  type SyncPage,
  type TransactionsProvider,
} from './provider.ts';

export type ProviderResolver = (profile: typeof providerProfiles.$inferSelect) => TransactionsProvider;

export type SyncDeps = {
  db: Db;
  masterKey: Buffer;
  providerFor: ProviderResolver;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pageSize?: number;
  maxMutationRestarts?: number;
  maxTransientRetries?: number;
};

export type Batch = {
  added: ProviderTransaction[];
  modified: ProviderTransaction[];
  removed: { providerTransactionId: string }[];
  accounts: ProviderAccount[];
  nextCursor: string;
  transactionsUpdateStatus: string | null;
};

export type SyncCounts = {
  added: number;
  modified: number;
  removed: number;
  superseded: number;
  unchanged: number;
};

export type SyncOutcome =
  | { status: 'succeeded'; runId: string; counts: SyncCounts; balanceErrorCode: string | null }
  | { status: 'failed'; runId: string; errorCode: string }
  | { status: 'already_running' };

const running = new Map<string, Promise<SyncOutcome>>();

export function isSyncRunning(itemId: string) {
  return running.has(itemId);
}

export function syncItem(
  deps: SyncDeps,
  itemId: string,
  trigger: 'manual' | 'scheduled',
): Promise<SyncOutcome> {
  if (running.has(itemId)) return Promise.resolve({ status: 'already_running' });
  const job = runSync(deps, itemId, trigger).finally(() => running.delete(itemId));
  running.set(itemId, job);
  return job;
}

export function markInterruptedRuns(db: Db, now = Date.now()) {
  db.update(syncRuns)
    .set({ status: 'interrupted', finishedAt: now, errorCode: 'PROCESS_RESTARTED' })
    .where(eq(syncRuns.status, 'running'))
    .run();
}

async function runSync(
  deps: SyncDeps,
  itemId: string,
  trigger: 'manual' | 'scheduled',
): Promise<SyncOutcome> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const item = db.select().from(items).where(eq(items.id, itemId)).get();
  if (!item) throw new Error(`Unknown item ${itemId}`);
  const runId = randomUUID();
  db.insert(syncRuns).values({ id: runId, itemId, trigger, status: 'running', startedAt: now() }).run();

  const originalCursor = item.cursor;
  let attempts = 0;
  try {
    let provider: TransactionsProvider;
    let accessToken: string;
    try {
      const profile = db
        .select()
        .from(providerProfiles)
        .where(eq(providerProfiles.id, item.profileId))
        .get()!;
      provider = deps.providerFor(profile);
      accessToken = decryptSecret(deps.masterKey, item.accessTokenEnc);
    } catch (error) {
      console.error('sync configuration error', itemId, error);
      throw new SyncConfigError();
    }
    const batch = await fetchBatch(deps, provider, accessToken, originalCursor, () => {
      attempts++;
      db.update(syncRuns).set({ attempts }).where(eq(syncRuns.id, runId)).run();
    });
    const counts = db.transaction((tx) => {
      const applied = applyBatch(tx, { itemId, originalCursor, runId, batch, now: now() });
      tx.update(syncRuns)
        .set({ status: 'succeeded', finishedAt: now(), countsJson: JSON.stringify(applied) })
        .where(eq(syncRuns.id, runId))
        .run();
      return applied;
    });
    const balanceErrorCode = await refreshAccounts(deps, provider, itemId, accessToken, runId);
    return { status: 'succeeded', runId, counts, balanceErrorCode };
  } catch (error) {
    const errorCode =
      error instanceof ProviderError || error instanceof SyncConflict || error instanceof SyncConfigError
        ? error.code
        : 'INTERNAL';
    if (errorCode === 'INTERNAL') console.error('sync failed', itemId, error);
    db.update(syncRuns)
      .set({ status: 'failed', finishedAt: now(), errorCode })
      .where(eq(syncRuns.id, runId))
      .run();
    db.update(items)
      .set({
        lastErrorCode: errorCode,
        ...(errorCode === 'LOGIN_REQUIRED' ? { status: 'login_required' as const } : {}),
      })
      .where(eq(items.id, itemId))
      .run();
    return { status: 'failed', runId, errorCode };
  }
}

class SyncConflict extends Error {
  readonly code = 'CURSOR_MOVED';
}

class SyncConfigError extends Error {
  readonly code = 'CONFIG_ERROR';
}

const MAX_PAGES_PER_BATCH = 1000;

export async function fetchBatch(
  deps: Pick<SyncDeps, 'sleep' | 'pageSize' | 'maxMutationRestarts' | 'maxTransientRetries'>,
  provider: TransactionsProvider,
  accessToken: string,
  originalCursor: string | null,
  onAttempt: () => void = () => {},
): Promise<Batch> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pageSize = deps.pageSize ?? 500;
  const maxRestarts = deps.maxMutationRestarts ?? 3;
  const maxTransient = deps.maxTransientRetries ?? 3;
  for (let restart = 0; ; restart++) {
    onAttempt();
    const batch: Batch = {
      added: [],
      modified: [],
      removed: [],
      accounts: [],
      nextCursor: originalCursor ?? '',
      transactionsUpdateStatus: null,
    };
    let cursor = originalCursor;
    try {
      for (let pages = 1; ; pages++) {
        if (pages > MAX_PAGES_PER_BATCH) throw new ProviderError('INVALID_REQUEST', 'Too many sync pages');
        const page = await withTransientRetry(
          () => provider.syncPage(accessToken, cursor, pageSize),
          maxTransient,
          sleep,
        );
        stagePage(batch, page);
        cursor = page.nextCursor;
        if (!page.hasMore) return batch;
      }
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.code === 'MUTATION_DURING_PAGINATION' &&
        restart < maxRestarts
      ) {
        await sleep(200 * 2 ** restart);
        continue;
      }
      throw error;
    }
  }
}

function stagePage(batch: Batch, page: SyncPage) {
  batch.added.push(...page.added);
  batch.modified.push(...page.modified);
  batch.removed.push(...page.removed);
  batch.accounts = page.accounts.length ? page.accounts : batch.accounts;
  batch.nextCursor = page.nextCursor;
  batch.transactionsUpdateStatus = page.transactionsUpdateStatus;
}

async function withTransientRetry<T>(
  fn: () => Promise<T>,
  max: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof ProviderError && error.transient) || attempt >= max) throw error;
      await sleep(500 * 2 ** attempt);
    }
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

type ApplyInput = {
  itemId: string;
  originalCursor: string | null;
  runId: string | null;
  batch: Batch;
  now: number;
};

export function applyBatch(tx: Tx, { itemId, originalCursor, runId, batch, now }: ApplyInput): SyncCounts {
  const current = tx.select({ cursor: items.cursor }).from(items).where(eq(items.id, itemId)).get();
  if (!current || current.cursor !== originalCursor) throw new SyncConflict('Item cursor moved during sync');

  const counts: SyncCounts = { added: 0, modified: 0, removed: 0, superseded: 0, unchanged: 0 };
  for (const account of batch.accounts) upsertSourceAccount(tx, itemId, account, null);

  const event = (
    canonicalTransactionId: string,
    sourceTransactionId: string,
    kind: 'added' | 'modified' | 'removed' | 'superseded',
    detail: object,
  ) =>
    tx
      .insert(transactionEvents)
      .values({
        id: randomUUID(),
        canonicalTransactionId,
        sourceTransactionId,
        syncRunId: runId,
        kind,
        detailJson: JSON.stringify(detail),
        at: now,
      })
      .run();

  for (const incoming of [...batch.added, ...batch.modified]) {
    const account = tx
      .select()
      .from(sourceAccounts)
      .where(
        and(
          eq(sourceAccounts.itemId, itemId),
          eq(sourceAccounts.providerAccountId, incoming.providerAccountId),
        ),
      )
      .get();
    if (!account) throw new ProviderError('INVALID_REQUEST', 'Transaction references an unknown account');
    const fields = sourceFields(incoming, account.id);
    const existing = findSource(tx, itemId, incoming.providerTransactionId);

    if (existing) {
      const changes = changedFields(existing, fields);
      if (!changes && existing.removedAt === null) {
        counts.unchanged++;
        continue;
      }
      tx.update(sourceTransactions)
        .set({ ...fields, removedAt: null, updatedAt: now })
        .where(eq(sourceTransactions.id, existing.id))
        .run();
      counts.modified++;
      if (existing.canonicalTransactionId) {
        event(existing.canonicalTransactionId, existing.id, 'modified', {
          changes: changes ?? {},
          restored: existing.removedAt !== null,
        });
        reprojectIfPreferred(tx, existing.canonicalTransactionId, existing.id, now, runId);
      }
      continue;
    }

    const sourceId = randomUUID();
    const predecessor = incoming.pendingTransactionId
      ? findSource(tx, itemId, incoming.pendingTransactionId)
      : undefined;
    tx.insert(sourceTransactions)
      .values({ id: sourceId, itemId, ...fields, createdAt: now, updatedAt: now })
      .run();
    counts.added++;

    if (predecessor?.canonicalTransactionId && predecessor.supersededById === null) {
      const canonicalId = predecessor.canonicalTransactionId;
      tx.update(sourceTransactions)
        .set({ supersededById: sourceId, updatedAt: now })
        .where(eq(sourceTransactions.id, predecessor.id))
        .run();
      tx.update(sourceTransactions)
        .set({ canonicalTransactionId: canonicalId })
        .where(eq(sourceTransactions.id, sourceId))
        .run();
      tx.update(canonicalTransactions)
        .set({ preferredSourceId: sourceId, lifecycleReview: null })
        .where(eq(canonicalTransactions.id, canonicalId))
        .run();
      event(canonicalId, predecessor.id, 'superseded', { by: incoming.providerTransactionId });
      event(canonicalId, sourceId, 'added', { successorOf: predecessor.providerTransactionId });
      reprojectIfPreferred(tx, canonicalId, sourceId, now, runId);
      counts.superseded++;
      continue;
    }

    const canonicalAccount = tx
      .select()
      .from(canonicalAccounts)
      .where(eq(canonicalAccounts.id, account.canonicalAccountId!))
      .get()!;
    if (canonicalAccount.primarySourceAccountId !== account.id) continue;
    const canonicalId = randomUUID();
    tx.insert(canonicalTransactions)
      .values({
        id: canonicalId,
        canonicalAccountId: canonicalAccount.id,
        preferredSourceId: sourceId,
        ...projection(fields),
        lifecycleReview:
          incoming.pendingTransactionId && originalCursor !== null ? 'unmatched_successor' : null,
        updatedAt: now,
      })
      .run();
    tx.update(sourceTransactions)
      .set({ canonicalTransactionId: canonicalId })
      .where(eq(sourceTransactions.id, sourceId))
      .run();
    event(canonicalId, sourceId, 'added', {});
  }

  for (const { providerTransactionId } of batch.removed) {
    const source = findSource(tx, itemId, providerTransactionId);
    if (!source || source.removedAt !== null) continue;
    tx.update(sourceTransactions)
      .set({ removedAt: now, updatedAt: now })
      .where(eq(sourceTransactions.id, source.id))
      .run();
    counts.removed++;
    if (!source.canonicalTransactionId) continue;
    event(source.canonicalTransactionId, source.id, 'removed', {
      superseded: source.supersededById !== null,
    });
    const canonical = tx
      .select()
      .from(canonicalTransactions)
      .where(eq(canonicalTransactions.id, source.canonicalTransactionId))
      .get()!;
    if (canonical.preferredSourceId !== source.id) continue;
    const annotation = tx
      .select()
      .from(annotations)
      .where(eq(annotations.canonicalTransactionId, canonical.id))
      .get();
    tx.update(canonicalTransactions)
      .set({
        status: 'removed',
        updatedAt: now,
        lifecycleReview: annotation && hasContent(annotation) ? 'removed_with_annotations' : null,
      })
      .where(eq(canonicalTransactions.id, canonical.id))
      .run();
  }

  tx.update(items)
    .set({
      cursor: batch.nextCursor,
      lastSyncAt: now,
      lastErrorCode: null,
      status: 'active',
      transactionsUpdateStatus: batch.transactionsUpdateStatus,
    })
    .where(eq(items.id, itemId))
    .run();
  return counts;
}

function findSource(tx: Tx, itemId: string, providerTransactionId: string) {
  return tx
    .select()
    .from(sourceTransactions)
    .where(
      and(
        eq(sourceTransactions.itemId, itemId),
        eq(sourceTransactions.providerTransactionId, providerTransactionId),
      ),
    )
    .get();
}

function sourceFields(t: ProviderTransaction, sourceAccountId: string) {
  return {
    providerTransactionId: t.providerTransactionId,
    sourceAccountId,
    pending: t.pending,
    pendingTransactionId: t.pendingTransactionId,
    amountMinor: t.amountMinor,
    currency: t.currency,
    date: t.date,
    authorizedDate: t.authorizedDate,
    name: t.name,
    merchantName: t.merchantName,
    providerCategory: t.category,
    rawJson: JSON.stringify(t.raw),
  };
}

type SourceFields = ReturnType<typeof sourceFields>;

function changedFields(existing: SourceFields, next: SourceFields) {
  const changes: Record<string, [unknown, unknown]> = {};
  for (const key of Object.keys(next) as (keyof SourceFields)[]) {
    if (key !== 'rawJson' && existing[key] !== next[key]) changes[key] = [existing[key], next[key]];
  }
  return Object.keys(changes).length ? changes : null;
}

function projection(f: SourceFields) {
  return {
    status: f.pending ? ('pending' as const) : ('posted' as const),
    date: f.date,
    amountMinor: f.amountMinor,
    currency: f.currency,
    name: f.name,
    merchantName: f.merchantName,
    providerCategory: f.providerCategory,
  };
}

function reprojectIfPreferred(
  tx: Tx,
  canonicalId: string,
  sourceId: string,
  now: number,
  runId: string | null,
) {
  const canonical = tx
    .select()
    .from(canonicalTransactions)
    .where(eq(canonicalTransactions.id, canonicalId))
    .get()!;
  if (canonical.preferredSourceId !== sourceId) return;
  const source = tx.select().from(sourceTransactions).where(eq(sourceTransactions.id, sourceId)).get()!;
  const account = tx
    .select()
    .from(sourceAccounts)
    .where(eq(sourceAccounts.id, source.sourceAccountId))
    .get()!;
  const next = {
    ...projection(source),
    canonicalAccountId: account.canonicalAccountId ?? canonical.canonicalAccountId,
  };
  tx.update(canonicalTransactions)
    .set({ ...next, ...(source.removedAt === null ? { lifecycleReview: null } : {}), updatedAt: now })
    .where(eq(canonicalTransactions.id, canonicalId))
    .run();
  flagReconciliationDrift(tx, canonicalId, next, now, runId);
}

export type ReconciledSnapshot = { amountMinor: number; date: string; canonicalAccountId: string };

function flagReconciliationDrift(
  tx: Tx,
  canonicalId: string,
  next: ReconciledSnapshot,
  now: number,
  runId: string | null,
) {
  const annotation = tx
    .select()
    .from(annotations)
    .where(eq(annotations.canonicalTransactionId, canonicalId))
    .get();
  if (!annotation?.isReconciled || annotation.needsReconciliationReview || !annotation.reconciledSnapshotJson)
    return;
  const snapshot = JSON.parse(annotation.reconciledSnapshotJson) as ReconciledSnapshot;
  const drifted =
    snapshot.amountMinor !== next.amountMinor ||
    snapshot.date !== next.date ||
    snapshot.canonicalAccountId !== next.canonicalAccountId;
  if (!drifted) return;
  const revision = annotation.revision + 1;
  tx.update(annotations)
    .set({ needsReconciliationReview: true, revision, updatedAt: now, updatedBy: null })
    .where(eq(annotations.canonicalTransactionId, canonicalId))
    .run();
  tx.insert(annotationHistory)
    .values({
      id: randomUUID(),
      canonicalTransactionId: canonicalId,
      revision,
      actor: null,
      cause: 'sync',
      snapshotJson: JSON.stringify({
        needsReconciliationReview: true,
        reconciledSnapshot: snapshot,
        current: next,
        syncRunId: runId,
      }),
      at: now,
    })
    .run();
}

function hasContent(a: typeof annotations.$inferSelect) {
  return (
    a.note !== '' ||
    a.category !== null ||
    a.tagsJson !== '[]' ||
    a.owner !== null ||
    a.kind !== null ||
    a.isReconciled
  );
}

function upsertSourceAccount(
  tx: Tx,
  itemId: string,
  account: ProviderAccount,
  balanceFetchedAt: number | null,
) {
  const metadata = {
    name: account.name,
    officialName: account.officialName,
    mask: account.mask,
    type: account.type,
    subtype: account.subtype,
    persistentAccountId: account.persistentAccountId,
    currency: account.currency,
  };
  const balances =
    balanceFetchedAt === null
      ? {}
      : {
          balanceCurrentMinor: account.balances.currentMinor,
          balanceAvailableMinor: account.balances.availableMinor,
          balanceLimitMinor: account.balances.limitMinor,
          balanceFetchedAt,
        };
  const existing = tx
    .select()
    .from(sourceAccounts)
    .where(
      and(eq(sourceAccounts.itemId, itemId), eq(sourceAccounts.providerAccountId, account.providerAccountId)),
    )
    .get();
  if (existing) {
    tx.update(sourceAccounts)
      .set({ ...metadata, ...balances })
      .where(eq(sourceAccounts.id, existing.id))
      .run();
    return existing.id;
  }
  const id = randomUUID();
  const canonicalId = randomUUID();
  tx.insert(canonicalAccounts)
    .values({
      id: canonicalId,
      displayName: account.name,
      kind: accountKind(account.type),
      groupId: UNASSIGNED_GROUP_ID,
      currency: account.currency,
    })
    .run();
  tx.insert(sourceAccounts)
    .values({
      id,
      itemId,
      providerAccountId: account.providerAccountId,
      canonicalAccountId: canonicalId,
      ...metadata,
      ...balances,
    })
    .run();
  tx.update(canonicalAccounts)
    .set({ primarySourceAccountId: id })
    .where(eq(canonicalAccounts.id, canonicalId))
    .run();
  return id;
}

function accountKind(type: string): 'depository' | 'credit' | 'loan' | 'investment' | 'other' {
  return type === 'depository' || type === 'credit' || type === 'loan' || type === 'investment'
    ? type
    : 'other';
}

async function refreshAccounts(
  deps: SyncDeps,
  provider: TransactionsProvider,
  itemId: string,
  accessToken: string,
  runId: string,
) {
  const now = deps.now ?? Date.now;
  try {
    const { accounts, institutionName } = await provider.getAccounts(accessToken);
    const fetchedAt = now();
    deps.db.transaction((tx) => {
      for (const account of accounts) upsertSourceAccount(tx, itemId, account, fetchedAt);
      tx.update(items)
        .set({ lastBalanceAt: fetchedAt, ...(institutionName ? { institutionName } : {}) })
        .where(eq(items.id, itemId))
        .run();
    });
    return null;
  } catch (error) {
    const code = error instanceof ProviderError ? error.code : 'INTERNAL';
    try {
      deps.db.update(syncRuns).set({ balanceErrorCode: code }).where(eq(syncRuns.id, runId)).run();
    } catch (recordError) {
      console.error('could not record balance refresh failure', runId, recordError);
    }
    return code;
  }
}
