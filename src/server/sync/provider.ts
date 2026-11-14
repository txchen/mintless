export type ProviderAccount = {
  providerAccountId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  persistentAccountId: string | null;
  currency: string;
  balances: { currentMinor: number | null; availableMinor: number | null; limitMinor: number | null };
};

export type ProviderTransaction = {
  providerTransactionId: string;
  providerAccountId: string;
  pending: boolean;
  pendingTransactionId: string | null;
  amountMinor: number;
  currency: string;
  date: string;
  authorizedDate: string | null;
  name: string;
  merchantName: string | null;
  category: string | null;
  raw: Record<string, unknown>;
};

export type SyncPage = {
  added: ProviderTransaction[];
  modified: ProviderTransaction[];
  removed: { providerTransactionId: string }[];
  accounts: ProviderAccount[];
  nextCursor: string;
  hasMore: boolean;
  transactionsUpdateStatus: string | null;
};

export type ProviderErrorCode =
  | 'MUTATION_DURING_PAGINATION'
  | 'LOGIN_REQUIRED'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INVALID_REQUEST';

const transientCodes = new Set<ProviderErrorCode>(['RATE_LIMITED', 'UPSTREAM_UNAVAILABLE']);

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  constructor(code: ProviderErrorCode, message: string = code) {
    super(message);
    this.code = code;
  }
  get transient() {
    return transientCodes.has(this.code);
  }
}

export interface TransactionsProvider {
  syncPage(accessToken: string, cursor: string | null, count: number): Promise<SyncPage>;
  getAccounts(accessToken: string): Promise<{ accounts: ProviderAccount[]; institutionName: string | null }>;
}
