import * as v from 'valibot';

export const Role = v.picklist(['admin', 'member']);
export type Role = v.InferOutput<typeof Role>;

const Username = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.regex(/^[a-z0-9._-]{2,40}$/, 'Use 2-40 letters, digits, dot, dash, or underscore'),
);
export const Password = v.pipe(v.string(), v.minLength(10, 'Use at least 10 characters'), v.maxLength(200));

export const LoginBody = v.object({ username: Username, password: v.pipe(v.string(), v.maxLength(200)) });
export const ChangePasswordBody = v.object({ currentPassword: v.string(), newPassword: Password });
export const CreateUserBody = v.object({ username: Username, password: Password, role: Role });
export const UpdateUserBody = v.strictObject({
  role: v.optional(Role),
  disabled: v.optional(v.boolean()),
  password: v.optional(Password),
  groupIds: v.optional(v.pipe(v.array(v.string()), v.maxLength(200))),
});
const GroupName = v.pipe(v.string(), v.trim(), v.minLength(1, 'Name the group'), v.maxLength(60));
export const CreateGroupBody = v.strictObject({ name: GroupName });
export const UpdateGroupBody = v.strictObject({ name: GroupName });
export const GroupMembersBody = v.strictObject({ userIds: v.pipe(v.array(v.string()), v.maxLength(200)) });
export const MoveAccountBody = v.strictObject({ groupId: v.string(), fromGroupId: v.string() });
export const UpdateAccountBody = v.object({
  displayName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
});
export const CreateDemoItemBody = v.object({ dataset: v.picklist(['household-bank', 'household-card']) });
export const CreateProfileBody = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60)),
  environment: v.literal('sandbox'),
  clientId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
  secretRef: v.pipe(v.string(), v.regex(/^(env|file):.+$/, 'Use env:NAME or file:/path')),
});

const Tag = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40));
const OptionalText = (max: number) =>
  v.nullable(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(max),
      v.transform((s) => s || null),
    ),
  );

export const AnnotationKind = v.picklist(['refund', 'transfer']);
export type AnnotationKind = v.InferOutput<typeof AnnotationKind>;

export const AnnotationPatch = v.object({
  revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  category: v.optional(OptionalText(60)),
  kind: v.optional(v.nullable(AnnotationKind)),
  note: v.optional(v.pipe(v.string(), v.maxLength(4000))),
  tags: v.optional(
    v.pipe(
      v.array(Tag),
      v.maxLength(20),
      v.transform((tags) => [...new Set(tags)]),
    ),
  ),
  owner: v.optional(OptionalText(60)),
  isReconciled: v.optional(v.boolean()),
  acknowledgeReview: v.optional(v.literal(true)),
  seen: v.optional(
    v.object({
      amountMinor: v.pipe(v.number(), v.integer()),
      date: v.pipe(v.string(), v.isoDate()),
      accountId: v.string(),
    }),
  ),
});
export type AnnotationPatch = v.InferOutput<typeof AnnotationPatch>;

export const StatusFilter = v.picklist(['active', 'pending', 'posted', 'removed', 'all']);
export type StatusFilter = v.InferOutput<typeof StatusFilter>;

export const TransactionQuery = v.object({
  q: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(100))),
  account: v.optional(v.string()),
  group: v.optional(v.string()),
  status: v.optional(StatusFilter, 'active'),
  review: v.optional(v.picklist(['any', 'reconciliation', 'lifecycle', 'uncategorized'])),
  reconciled: v.optional(v.picklist(['yes', 'no'])),
  category: v.optional(v.pipe(v.string(), v.maxLength(60))),
  from: v.optional(v.pipe(v.string(), v.isoDate())),
  to: v.optional(v.pipe(v.string(), v.isoDate())),
  cursor: v.optional(v.string()),
  limit: v.optional(v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1), v.maxValue(200)), '100'),
});
export type TransactionQuery = v.InferInput<typeof TransactionQuery>;
export type TransactionFilter = v.InferOutput<typeof TransactionQuery>;

const Month = v.pipe(v.string(), v.regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM'));
export const InsightsQuery = v.object({
  from: v.optional(Month),
  to: v.optional(Month),
  account: v.optional(v.string()),
  group: v.optional(v.string()),
  currency: v.optional(v.pipe(v.string(), v.regex(/^[A-Z]{3}$/))),
});
export type InsightsFilter = v.InferOutput<typeof InsightsQuery>;

export type Insights = {
  currency: string | null;
  currencies: string[];
  from: string;
  to: string;
  months: { month: string; moneyInMinor: number; spendingMinor: number }[];
  categories: { name: string; spendingMinor: number; count: number; source: 'user' | 'bank' | 'none' }[];
  coverage: {
    included: number;
    pendingExcluded: number;
    transfersExcluded: number;
    refunds: number;
    unclassifiedInflows: number;
    bankTransferLike: number;
    otherCurrencies: number;
  };
};

export type SessionUser = { id: string; username: string; role: Role };
export type SessionInfo = { user: SessionUser; csrfToken: string };

export type TransactionStatus = 'pending' | 'posted' | 'removed';

export type Annotation = {
  category: string | null;
  kind: AnnotationKind | null;
  note: string;
  tags: string[];
  owner: string | null;
  isReconciled: boolean;
  reconciledAt: number | null;
  reconciledBy: string | null;
  needsReconciliationReview: boolean;
  revision: number;
  updatedAt: number | null;
  updatedBy: string | null;
};

export type TransactionRow = {
  id: string;
  accountId: string;
  accountName: string;
  accountMask: string | null;
  date: string;
  name: string;
  merchantName: string | null;
  amountMinor: number;
  currency: string;
  status: TransactionStatus;
  providerCategory: string | null;
  lifecycleReview: 'removed_with_annotations' | 'unmatched_successor' | null;
  annotation: Annotation;
};

export type TransactionPage = { rows: TransactionRow[]; nextCursor: string | null };

export type TransactionSource = {
  id: string;
  institutionName: string | null;
  accountName: string;
  pending: boolean;
  amountMinor: number;
  currency: string;
  date: string;
  name: string;
  removedAt: number | null;
  superseded: boolean;
  preferred: boolean;
  providerRef: string;
};

export type TransactionEvent = {
  kind: 'added' | 'modified' | 'removed' | 'superseded';
  at: number;
  detail: Record<string, unknown>;
};
export type AnnotationRevision = {
  revision: number;
  at: number;
  actor: string | null;
  cause: 'user' | 'sync';
  summary: string;
};

export type TransactionDetail = TransactionRow & {
  sources: TransactionSource[];
  events: TransactionEvent[];
  history: AnnotationRevision[];
};

export type AnnotationConflict = { error: 'conflict'; current: TransactionRow };

export type AccountSummary = {
  id: string;
  displayName: string;
  kind: 'depository' | 'credit' | 'loan' | 'investment' | 'other';
  currency: string;
  mask: string | null;
  institutionName: string | null;
  balanceCurrentMinor: number | null;
  balanceAvailableMinor: number | null;
  balanceLimitMinor: number | null;
  balanceFetchedAt: number | null;
  lastSyncAt: number | null;
  sourceCount: number;
  groupId: string;
  groupName: string;
};

export type Overview = {
  groups: { kind: 'cash' | 'credit' | 'other'; currency: string; totalMinor: number; accountCount: number }[];
  review: { reconciliation: number; lifecycle: number; uncategorized: number; pending: number };
  lastSyncAt: number | null;
  syncProblems: number | null;
};

export type UserSummary = {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  passwordFromCli: boolean;
  createdAt: number;
  groupIds: string[];
};

export type ItemSummary = {
  id: string;
  profileName: string;
  environment: 'fixture' | 'sandbox' | 'production';
  institutionName: string | null;
  status: 'active' | 'login_required' | 'error';
  lastSyncAt: number | null;
  lastBalanceAt: number | null;
  lastErrorCode: string | null;
  transactionsUpdateStatus: string | null;
  accountNames: string[];
  syncing: boolean;
  recentRuns: SyncRunSummary[];
};

export type SyncRunSummary = {
  id: string;
  trigger: 'manual' | 'scheduled';
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  attempts: number;
  counts: Record<string, number> | null;
  errorCode: string | null;
  balanceErrorCode: string | null;
  startedAt: number;
  finishedAt: number | null;
};

export type ProfileSummary = {
  id: string;
  name: string;
  environment: 'fixture' | 'sandbox' | 'production';
  hasCredentials: boolean;
};

export type GroupSummary = {
  id: string;
  name: string;
  protected: boolean;
  accountCount: number;
  memberIds?: string[];
};

export type MoveImpact = {
  account: { id: string; name: string };
  from: { id: string; name: string };
  to: { id: string; name: string };
  losesAccess: string[];
  gainsAccess: string[];
  transactionCount: number;
  annotationCount: number;
};
