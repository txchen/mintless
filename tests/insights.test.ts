import { describe, expect, it } from 'vite-plus/test';
import type { Insights } from '../src/shared/contracts.ts';
import { canonicalAccounts } from '../src/server/db/schema.ts';
import { computeInsights } from '../src/server/insights.ts';
import { syncItem } from '../src/server/sync/engine.ts';
import type {
  ProviderAccount,
  ProviderTransaction,
  TransactionsProvider,
} from '../src/server/sync/provider.ts';
import { listTransactions, patchAnnotation } from '../src/server/transactions.ts';
import { addFixtureItem, addUser, login, setup, shareInGroup } from './helpers.ts';

const account = (id: string, type: string, currency = 'USD'): ProviderAccount => ({
  providerAccountId: id,
  name: id,
  officialName: null,
  mask: id.slice(-4),
  type,
  subtype: null,
  persistentAccountId: null,
  currency,
  balances: { currentMinor: 0, availableMinor: null, limitMinor: null },
});

const tx = (
  id: string,
  acct: string,
  date: string,
  amountMinor: number,
  category: string | null,
  extra: Partial<ProviderTransaction> = {},
): ProviderTransaction => ({
  providerTransactionId: id,
  providerAccountId: acct,
  pending: false,
  pendingTransactionId: null,
  amountMinor,
  currency: 'USD',
  date,
  authorizedDate: date,
  name: id,
  merchantName: id,
  category,
  raw: {},
  ...extra,
});

const accounts = [
  account('acct-checking', 'depository'),
  account('acct-card', 'credit'),
  account('acct-euro', 'depository', 'EUR'),
];
const v1 = [
  tx('rent', 'acct-checking', '2026-09-30', 10_000, 'Rent'),
  tx('payroll', 'acct-checking', '2026-10-01', -300_000, 'Income'),
  tx('grocer', 'acct-card', '2026-10-15', 5_000, 'Groceries'),
  tx('grocer-refund', 'acct-card', '2026-10-20', -2_000, 'Groceries'),
  tx('card-payment-out', 'acct-checking', '2026-10-12', 80_000, 'Credit card payment'),
  tx('card-payment-in', 'acct-card', '2026-10-12', -80_000, 'Credit card payment'),
  tx('to-savings', 'acct-checking', '2026-10-25', 4_000, 'Transfer'),
  tx('cafe-pending', 'acct-card', '2026-10-30', 1_500, 'Dining', { pending: true }),
  tx('bakery', 'acct-euro', '2026-10-05', 7_000, 'Dining', { currency: 'EUR' }),
  tx('mistake', 'acct-card', '2026-10-31', 999, 'Shopping'),
  tx('returned', 'acct-card', '2026-11-01', -500, 'Shopping'),
];
const v2 = {
  added: [
    tx('cafe-posted', 'acct-card', '2026-10-31', 1_800, 'Dining', { pendingTransactionId: 'cafe-pending' }),
  ],
  removed: [{ providerTransactionId: 'cafe-pending' }, { providerTransactionId: 'mistake' }],
};

const scripted: TransactionsProvider = {
  async syncPage(_token, cursor) {
    const base = {
      modified: [],
      accounts,
      hasMore: false,
      transactionsUpdateStatus: 'HISTORICAL_UPDATE_COMPLETE',
    };
    if (cursor === null) return { ...base, added: v1, removed: [], nextCursor: 'v1' };
    if (cursor === 'v1') return { ...base, ...v2, nextCursor: 'v2' };
    return { ...base, added: [], removed: [], nextCursor: cursor };
  },
  getAccounts: async () => ({ accounts, institutionName: 'Scripted' }),
};

const now = Date.parse('2026-11-20T12:00:00Z');
const all = { kind: 'all' } as const;
const range = { from: '2026-09', to: '2026-11' };

async function world() {
  const env = setup({ provider: scripted });
  const itemId = addFixtureItem(env.db);
  await syncItem(env.sync, itemId, 'manual');
  const adminId = await addUser(env.db, 'root', 'admin');
  const memberId = await addUser(env.db, 'mia', 'member');
  const id = (name: string) =>
    listTransactions(env.db, all, { status: 'all', limit: 200, q: name }).rows.find((r) => r.name === name)!
      .id;
  const classify = (name: string, kind: 'refund' | 'transfer') => {
    const target = id(name);
    const revision = listTransactions(env.db, all, { status: 'all', limit: 200 }).rows.find(
      (r) => r.id === target,
    )!.annotation.revision;
    expect(patchAnnotation(env.db, all, adminId, target, { revision, kind }, 1).kind).toBe('ok');
  };
  classify('grocer-refund', 'refund');
  classify('returned', 'refund');
  classify('card-payment-out', 'transfer');
  classify('card-payment-in', 'transfer');
  const acct = (name: string) =>
    env.db
      .select()
      .from(canonicalAccounts)
      .all()
      .find((a) => a.displayName === name)!.id;
  return { ...env, itemId, adminId, memberId, acct };
}

const spendingOf = (i: Insights) => Object.fromEntries(i.months.map((m) => [m.month, m.spendingMinor]));
const moneyInOf = (i: Insights) => Object.fromEntries(i.months.map((m) => [m.month, m.moneyInMinor]));
const categoriesOf = (i: Insights) => Object.fromEntries(i.categories.map((c) => [c.name, c.spendingMinor]));

describe('overview insights', () => {
  it('excludes pending charges, then counts the posted successor once', async () => {
    const w = await world();
    const before = computeInsights(w.db, all, range, now);
    expect(before.coverage.pendingExcluded).toBe(1);
    expect(spendingOf(before)['2026-10']).toBe(5_000 - 2_000 + 4_000 + 999);

    await syncItem(w.sync, w.itemId, 'manual');
    const after = computeInsights(w.db, all, range, now);
    expect(after.coverage.pendingExcluded).toBe(0);
    expect(spendingOf(after)).toEqual({
      '2026-09': 10_000,
      '2026-10': 5_000 - 2_000 + 4_000 + 1_800,
      '2026-11': -500,
    });
    expect(moneyInOf(after)).toEqual({ '2026-09': 0, '2026-10': 300_000, '2026-11': 0 });
  });

  it('nets refunds inside their category, keeps negative totals visible, and excludes classified transfers', async () => {
    const w = await world();
    await syncItem(w.sync, w.itemId, 'manual');
    const i = computeInsights(w.db, all, range, now);
    expect(categoriesOf(i)).toEqual({
      Rent: 10_000,
      Transfer: 4_000,
      Groceries: 3_000,
      Dining: 1_800,
      Shopping: -500,
    });
    expect(i.categories.find((c) => c.name === 'Shopping')).toMatchObject({ source: 'bank', count: 1 });
    expect(i.coverage).toMatchObject({
      included: 7,
      transfersExcluded: 2,
      refunds: 2,
      unclassifiedInflows: 1,
      bankTransferLike: 1,
      otherCurrencies: 1,
    });
  });

  it('keeps currencies separate and never sums across them', async () => {
    const w = await world();
    await syncItem(w.sync, w.itemId, 'manual');
    expect(computeInsights(w.db, all, range, now)).toMatchObject({
      currency: 'USD',
      currencies: ['EUR', 'USD'],
    });
    const euro = computeInsights(w.db, all, { ...range, currency: 'EUR' }, now);
    expect(spendingOf(euro)).toEqual({ '2026-09': 0, '2026-10': 7_000, '2026-11': 0 });
    expect(euro.coverage.otherCurrencies).toBe(9);
    expect(computeInsights(w.db, all, { ...range, currency: 'JPY' }, now).currency).toBe('USD');
  });

  it('applies account and month filters at month boundaries', async () => {
    const w = await world();
    await syncItem(w.sync, w.itemId, 'manual');
    const card = computeInsights(w.db, all, { ...range, account: w.acct('acct-card') }, now);
    expect(spendingOf(card)).toEqual({ '2026-09': 0, '2026-10': 5_000 - 2_000 + 1_800, '2026-11': -500 });
    expect(card.coverage.transfersExcluded).toBe(1);
    const october = computeInsights(w.db, all, { from: '2026-10', to: '2026-10' }, now);
    expect(october.months.map((m) => m.month)).toEqual(['2026-10']);
    expect(categoriesOf(october).Rent).toBeUndefined();
    const reversed = computeInsights(w.db, all, { from: '2026-11', to: '2026-09' }, now);
    expect(reversed.months.map((m) => m.month)).toEqual(['2026-09', '2026-10', '2026-11']);
    expect(computeInsights(w.db, all, {}, now).months.map((m) => m.month)).toEqual([
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
  });

  it('aggregates only granted accounts, re-checks grants on every request, and shows zero data honestly', async () => {
    const w = await world();
    await syncItem(w.sync, w.itemId, 'manual');
    const admin = await login(w.api, 'root');
    const mia = await login(w.api, 'mia');
    const get = async (c: typeof mia, q: string) => {
      const res = await c.call(`/insights?from=2026-09&to=2026-11${q}`);
      expect(res.status).toBe(200);
      return (await res.json()) as Insights;
    };

    const empty = await get(mia, '');
    expect(empty).toMatchObject({ currency: null, currencies: [], categories: [] });
    expect(empty.months.every((m) => m.moneyInMinor === 0 && m.spendingMinor === 0)).toBe(true);

    const cardGroup = await shareInGroup(admin.call, 'Card', [w.acct('acct-card')], [w.memberId]);
    const granted = await get(mia, '');
    expect(spendingOf(granted)['2026-10']).toBe(5_000 - 2_000 + 1_800);
    expect(granted.currencies).toEqual(['USD']);
    expect(categoriesOf(granted).Rent).toBeUndefined();
    expect((await get(mia, `&account=${w.acct('acct-checking')}`)).currency).toBeNull();
    expect((await get(mia, '&currency=EUR')).currency).toBe('USD');

    await admin.call(`/admin/groups/${cardGroup}/members`, {
      method: 'PUT',
      body: JSON.stringify({ userIds: [] }),
    });
    expect((await get(mia, '')).currency).toBeNull();
    expect((await w.api.request('/api/insights')).status).toBe(401);
    expect((await mia.call('/insights?from=2026-13')).status).toBe(400);
  });
});

function staticProvider(added: ProviderTransaction[]): TransactionsProvider {
  return {
    async syncPage(_token, cursor) {
      const base = { modified: [], removed: [], accounts, hasMore: false, transactionsUpdateStatus: null };
      return cursor === null
        ? { ...base, added, nextCursor: 'v1' }
        : { ...base, added: [], nextCursor: cursor };
    },
    getAccounts: async () => ({ accounts, institutionName: 'Static' }),
  };
}

async function staticWorld(added: ProviderTransaction[]) {
  const env = setup({ provider: staticProvider(added) });
  await syncItem(env.sync, addFixtureItem(env.db), 'manual');
  const adminId = await addUser(env.db, 'root', 'admin');
  return { ...env, adminId };
}

describe('overview insights edge cases', () => {
  it('caps a reversed range at 24 months instead of failing on rows outside it', async () => {
    const w = await staticWorld([
      tx('old', 'acct-card', '2001-06-15', 1_000, 'Shopping'),
      tx('new', 'acct-card', '2029-12-15', 2_000, 'Shopping'),
    ]);
    const i = computeInsights(w.db, all, { from: '2030-01', to: '2000-01' }, now);
    expect(i).toMatchObject({ from: '2028-02', to: '2030-01' });
    expect(i.months).toHaveLength(24);
    expect(categoriesOf(i)).toEqual({ Shopping: 2_000 });
  });

  it('groups only when two or more categories are left over, and never hides a negative total', async () => {
    const names = Array.from({ length: 10 }, (_, n) => `Cat ${String(n).padStart(2, '0')}`);
    const spend = names.map((name, n) => tx(`s${n}`, 'acct-card', '2026-10-10', 10_000 - n * 100, name));
    const ten = await staticWorld([...spend, tx('back', 'acct-card', '2026-10-11', -500, 'Returns')]);
    const back = listTransactions(ten.db, all, { status: 'all', limit: 200, q: 'back' }).rows[0]!;
    patchAnnotation(ten.db, all, ten.adminId, back.id, { revision: 0, kind: 'refund' }, 1);
    const grouped = computeInsights(ten.db, all, { from: '2026-10', to: '2026-10' }, now).categories;
    expect(grouped.map((c) => c.name)).toEqual([...names.slice(0, 8), '2 other categories', 'Returns']);
    expect(grouped.find((c) => c.name === '2 other categories')!.spendingMinor).toBe(9_200 + 9_100);
    expect(grouped.at(-1)!.spendingMinor).toBe(-500);

    const nine = await staticWorld(spend.slice(0, 9));
    expect(
      computeInsights(nine.db, all, { from: '2026-10', to: '2026-10' }, now).categories.map((c) => c.name),
    ).toEqual(names.slice(0, 9));
  });

  it('a refund mark on an outflow counts as ordinary spending, not as a refund', async () => {
    const w = await staticWorld([tx('odd', 'acct-card', '2026-10-10', 3_000, 'Shopping')]);
    const odd = listTransactions(w.db, all, { status: 'all', limit: 10 }).rows[0]!;
    patchAnnotation(w.db, all, w.adminId, odd.id, { revision: 0, kind: 'refund' }, 1);
    const i = computeInsights(w.db, all, { from: '2026-10', to: '2026-10' }, now);
    expect(i.coverage.refunds).toBe(0);
    expect(spendingOf(i)['2026-10']).toBe(3_000);
  });

  it('reports a range where everything is a marked transfer as nothing counted', async () => {
    const w = await staticWorld([tx('move', 'acct-checking', '2026-10-10', 50_000, 'Transfer')]);
    const move = listTransactions(w.db, all, { status: 'all', limit: 10 }).rows[0]!;
    patchAnnotation(w.db, all, w.adminId, move.id, { revision: 0, kind: 'transfer' }, 1);
    const i = computeInsights(w.db, all, { from: '2026-10', to: '2026-10' }, now);
    expect(i.coverage).toMatchObject({ included: 0, transfersExcluded: 1 });
    expect(i.categories).toEqual([]);
  });
});
