import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

const createdAt = () =>
  integer('created_at', { mode: 'number' })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`);

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['admin', 'member'] }).notNull(),
    passwordSetBy: text('password_set_by', { enum: ['cli', 'self', 'admin'] })
      .notNull()
      .default('cli'),
    disabledAt: integer('disabled_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('users_username_unique').on(t.username),
    check('users_role', sql`${t.role} in ('admin', 'member')`),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    csrfToken: text('csrf_token').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user').on(t.userId)],
);

export const providerProfiles = sqliteTable(
  'provider_profiles',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    environment: text('environment', { enum: ['fixture', 'sandbox', 'production'] }).notNull(),
    clientId: text('client_id'),
    secretRef: text('secret_ref'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('provider_profiles_name_unique').on(t.name),
    check('provider_profiles_environment', sql`${t.environment} in ('fixture', 'sandbox', 'production')`),
  ],
);

export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => providerProfiles.id),
    providerItemId: text('provider_item_id').notNull(),
    accessTokenEnc: text('access_token_enc').notNull(),
    institutionName: text('institution_name'),
    cursor: text('cursor'),
    status: text('status', { enum: ['active', 'login_required', 'error'] })
      .notNull()
      .default('active'),
    transactionsUpdateStatus: text('transactions_update_status'),
    lastSyncAt: integer('last_sync_at'),
    lastBalanceAt: integer('last_balance_at'),
    lastErrorCode: text('last_error_code'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('items_profile_provider_unique').on(t.profileId, t.providerItemId)],
);

export const UNASSIGNED_GROUP_ID = 'unassigned';

export const accountGroups = sqliteTable(
  'account_groups',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    protected: integer('protected', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('account_groups_name_unique').on(t.name)],
);

export const groupMembers = sqliteTable(
  'group_members',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => accountGroups.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] }), index('group_members_user').on(t.userId)],
);

export const canonicalAccounts = sqliteTable('canonical_accounts', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  kind: text('kind', { enum: ['depository', 'credit', 'loan', 'investment', 'other'] }).notNull(),
  currency: text('currency').notNull(),
  primarySourceAccountId: text('primary_source_account_id').references(
    (): AnySQLiteColumn => sourceAccounts.id,
  ),
  groupId: text('group_id').references(() => accountGroups.id),
  archivedAt: integer('archived_at'),
  createdAt: createdAt(),
});

export const sourceAccounts = sqliteTable(
  'source_accounts',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    providerAccountId: text('provider_account_id').notNull(),
    canonicalAccountId: text('canonical_account_id').references(() => canonicalAccounts.id),
    name: text('name').notNull(),
    officialName: text('official_name'),
    mask: text('mask'),
    type: text('type').notNull(),
    subtype: text('subtype'),
    persistentAccountId: text('persistent_account_id'),
    currency: text('currency').notNull(),
    balanceCurrentMinor: integer('balance_current_minor'),
    balanceAvailableMinor: integer('balance_available_minor'),
    balanceLimitMinor: integer('balance_limit_minor'),
    balanceFetchedAt: integer('balance_fetched_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('source_accounts_item_provider_unique').on(t.itemId, t.providerAccountId)],
);

export const accountAccess = sqliteTable(
  'account_access',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    canonicalAccountId: text('canonical_account_id')
      .notNull()
      .references(() => canonicalAccounts.id),
    grantedBy: text('granted_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.canonicalAccountId] })],
);

export const transactionStatuses = ['pending', 'posted', 'removed'] as const;
export const lifecycleReviewReasons = ['removed_with_annotations', 'unmatched_successor'] as const;

export const canonicalTransactions = sqliteTable(
  'canonical_transactions',
  {
    id: text('id').primaryKey(),
    canonicalAccountId: text('canonical_account_id')
      .notNull()
      .references(() => canonicalAccounts.id),
    preferredSourceId: text('preferred_source_id').notNull(),
    status: text('status', { enum: transactionStatuses }).notNull(),
    date: text('date').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    name: text('name').notNull(),
    merchantName: text('merchant_name'),
    providerCategory: text('provider_category'),
    lifecycleReview: text('lifecycle_review', { enum: lifecycleReviewReasons }),
    createdAt: createdAt(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('canonical_transactions_account_date').on(t.canonicalAccountId, t.date, t.id),
    index('canonical_transactions_date').on(t.date, t.id),
    check('canonical_transactions_status', sql`${t.status} in ('pending', 'posted', 'removed')`),
  ],
);

export const sourceTransactions = sqliteTable(
  'source_transactions',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    providerTransactionId: text('provider_transaction_id').notNull(),
    sourceAccountId: text('source_account_id')
      .notNull()
      .references(() => sourceAccounts.id),
    canonicalTransactionId: text('canonical_transaction_id').references(() => canonicalTransactions.id),
    pending: integer('pending', { mode: 'boolean' }).notNull(),
    pendingTransactionId: text('pending_transaction_id'),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    date: text('date').notNull(),
    authorizedDate: text('authorized_date'),
    name: text('name').notNull(),
    merchantName: text('merchant_name'),
    providerCategory: text('provider_category'),
    rawJson: text('raw_json').notNull(),
    removedAt: integer('removed_at'),
    supersededById: text('superseded_by_id').references((): AnySQLiteColumn => sourceTransactions.id),
    createdAt: createdAt(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('source_transactions_item_provider_unique').on(t.itemId, t.providerTransactionId),
    index('source_transactions_canonical').on(t.canonicalTransactionId),
  ],
);

export const transactionEvents = sqliteTable(
  'transaction_events',
  {
    id: text('id').primaryKey(),
    canonicalTransactionId: text('canonical_transaction_id')
      .notNull()
      .references(() => canonicalTransactions.id),
    sourceTransactionId: text('source_transaction_id')
      .notNull()
      .references(() => sourceTransactions.id),
    syncRunId: text('sync_run_id').references(() => syncRuns.id),
    kind: text('kind', { enum: ['added', 'modified', 'removed', 'superseded'] }).notNull(),
    detailJson: text('detail_json').notNull(),
    at: integer('at').notNull(),
  },
  (t) => [index('transaction_events_canonical').on(t.canonicalTransactionId, t.at)],
);

export const annotationKinds = ['refund', 'transfer'] as const;

export const annotations = sqliteTable('transaction_annotations', {
  canonicalTransactionId: text('canonical_transaction_id')
    .primaryKey()
    .references(() => canonicalTransactions.id),
  category: text('category'),
  kind: text('kind', { enum: annotationKinds }),
  note: text('note').notNull().default(''),
  tagsJson: text('tags_json').notNull().default('[]'),
  owner: text('owner'),
  isReconciled: integer('is_reconciled', { mode: 'boolean' }).notNull().default(false),
  reconciledAt: integer('reconciled_at'),
  reconciledBy: text('reconciled_by').references(() => users.id),
  reconciledSnapshotJson: text('reconciled_snapshot_json'),
  needsReconciliationReview: integer('needs_reconciliation_review', { mode: 'boolean' })
    .notNull()
    .default(false),
  revision: integer('revision').notNull(),
  updatedAt: integer('updated_at').notNull(),
  updatedBy: text('updated_by').references(() => users.id),
});

export const annotationHistory = sqliteTable(
  'annotation_history',
  {
    id: text('id').primaryKey(),
    canonicalTransactionId: text('canonical_transaction_id')
      .notNull()
      .references(() => canonicalTransactions.id),
    revision: integer('revision').notNull(),
    actor: text('actor').references(() => users.id),
    cause: text('cause', { enum: ['user', 'sync'] }).notNull(),
    snapshotJson: text('snapshot_json').notNull(),
    at: integer('at').notNull(),
  },
  (t) => [uniqueIndex('annotation_history_revision_unique').on(t.canonicalTransactionId, t.revision)],
);

export const syncRuns = sqliteTable(
  'sync_runs',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => items.id),
    trigger: text('trigger', { enum: ['manual', 'scheduled'] }).notNull(),
    status: text('status', { enum: ['running', 'succeeded', 'failed', 'interrupted'] }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    countsJson: text('counts_json'),
    errorCode: text('error_code'),
    balanceErrorCode: text('balance_error_code'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (t) => [index('sync_runs_item_started').on(t.itemId, t.startedAt)],
);
