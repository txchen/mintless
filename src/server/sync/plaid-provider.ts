import { readFileSync } from 'node:fs';
import { Plaid, PlaidClient, PlaidEnvironment, PlaidError, PlaidTimeoutError } from 'plaid';
import { toMinorUnits } from '../../shared/money.ts';
import {
  ProviderError,
  type ProviderAccount,
  type ProviderTransaction,
  type TransactionsProvider,
} from './provider.ts';

export type PlaidCredentials = { environment: 'sandbox'; clientId: string; secret: string };

export function resolveSecretRef(ref: string): string {
  const [scheme, ...rest] = ref.split(':');
  const target = rest.join(':');
  if (scheme === 'env') {
    const value = process.env[target];
    if (!value) throw new Error(`Secret environment variable ${target} is not set`);
    return value;
  }
  if (scheme === 'file') return readFileSync(target, 'utf8').trim();
  throw new Error('Unsupported secret reference');
}

const repairCodes = new Set([
  'ITEM_LOGIN_REQUIRED',
  'ACCESS_NOT_GRANTED',
  'ITEM_NOT_FOUND',
  'INVALID_ACCESS_TOKEN',
]);

export function mapPlaidError(error: unknown): ProviderError {
  if (error instanceof PlaidTimeoutError) return new ProviderError('UPSTREAM_UNAVAILABLE');
  if (!(error instanceof PlaidError)) throw error;
  if (error.statusCode === undefined) return new ProviderError('UPSTREAM_UNAVAILABLE');
  const body = (error.body ?? {}) as { error_code?: string; error_type?: string };
  const code = body.error_code;
  if (code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION')
    return new ProviderError('MUTATION_DURING_PAGINATION');
  if (code && repairCodes.has(code)) return new ProviderError('LOGIN_REQUIRED');
  if (body.error_type === 'INSTITUTION_ERROR') return new ProviderError('UPSTREAM_UNAVAILABLE');
  if (error.statusCode === 429 || body.error_type === 'RATE_LIMIT_EXCEEDED')
    return new ProviderError('RATE_LIMITED');
  if (error.statusCode >= 500) return new ProviderError('UPSTREAM_UNAVAILABLE');
  return new ProviderError('INVALID_REQUEST', code ?? 'Plaid request failed');
}

const minorOrNull = (value: number | null | undefined, currency: string) =>
  value === null || value === undefined ? null : toMinorUnits(value, currency);

function mapAccount(a: Plaid.AccountBase): ProviderAccount {
  const currency = a.balances.iso_currency_code ?? a.balances.unofficial_currency_code ?? 'USD';
  return {
    providerAccountId: a.account_id,
    name: a.name,
    officialName: a.official_name ?? null,
    mask: a.mask ?? null,
    type: a.type,
    subtype: a.subtype ?? null,
    persistentAccountId: a.persistent_account_id ?? null,
    currency,
    balances: {
      currentMinor: minorOrNull(a.balances.current, currency),
      availableMinor: minorOrNull(a.balances.available, currency),
      limitMinor: minorOrNull(a.balances.limit, currency),
    },
  };
}

function mapTransaction(t: Plaid.Transaction): ProviderTransaction {
  const currency = t.iso_currency_code ?? t.unofficial_currency_code ?? 'USD';
  return {
    providerTransactionId: t.transaction_id,
    providerAccountId: t.account_id,
    pending: t.pending,
    pendingTransactionId: t.pending_transaction_id ?? null,
    amountMinor: toMinorUnits(t.amount, currency),
    currency,
    date: t.date,
    authorizedDate: t.authorized_date ?? null,
    name: t.name,
    merchantName: t.merchant_name ?? null,
    category: t.personal_finance_category?.primary ?? null,
    raw: {
      payment_channel: t.payment_channel,
      personal_finance_category: t.personal_finance_category ?? null,
      transaction_code: t.transaction_code ?? null,
    },
  };
}

export class PlaidProvider implements TransactionsProvider {
  readonly #api: PlaidClient;
  constructor(creds: PlaidCredentials) {
    this.#api = new PlaidClient({
      environment: PlaidEnvironment.Sandbox,
      clientId: creds.clientId,
      secret: creds.secret,
      timeoutInSeconds: 30,
    });
  }

  async syncPage(accessToken: string, cursor: string | null, count: number) {
    try {
      const data = await this.#api.transactions.sync({
        access_token: accessToken,
        count,
        ...(cursor ? { cursor } : {}),
        options: { days_requested: 730, include_personal_finance_category: true },
      });
      return {
        added: data.added.map(mapTransaction),
        modified: data.modified.map(mapTransaction),
        removed: data.removed.map((r: Plaid.RemovedTransaction) => ({
          providerTransactionId: r.transaction_id,
        })),
        accounts: data.accounts.map(mapAccount),
        nextCursor: data.next_cursor,
        hasMore: data.has_more,
        transactionsUpdateStatus: data.transactions_update_status ?? null,
      };
    } catch (error) {
      throw mapPlaidError(error);
    }
  }

  async getAccounts(accessToken: string) {
    try {
      const data = await this.#api.accounts.get({ access_token: accessToken });
      return { accounts: data.accounts.map(mapAccount), institutionName: data.item.institution_name ?? null };
    } catch (error) {
      throw mapPlaidError(error);
    }
  }

  async createSandboxItem(institutionId = 'ins_109508') {
    try {
      const created = await this.#api.sandbox.createPublicToken({
        institution_id: institutionId,
        initial_products: [Plaid.Products.Transactions],
        options: { transactions: { days_requested: 730 } },
      });
      const exchanged = await this.#api.item.exchangePublicToken({ public_token: created.public_token });
      return { accessToken: exchanged.access_token, providerItemId: exchanged.item_id };
    } catch (error) {
      throw mapPlaidError(error);
    }
  }
}
