import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Insights, InsightsFilter } from '../shared/contracts.ts';
import type { Db } from './db/client.ts';
import { annotations, canonicalTransactions } from './db/schema.ts';
import { inScope, type AccountScope } from './http/context.ts';

const MAX_MONTHS = 24;
const TOP_CATEGORIES = 8;
const bankTransferLike = /transfer|payment|loan/i;

const monthKey = (d: Date) => d.toISOString().slice(0, 7);

function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return monthKey(new Date(Date.UTC(y, m - 1 + delta, 1)));
}

function monthsBetween(from: string, to: string) {
  const out: string[] = [];
  for (let m = from; m <= to && out.length < MAX_MONTHS; m = shiftMonth(m, 1)) out.push(m);
  return out;
}

export function resolveRange(filter: InsightsFilter, now: number) {
  const end = filter.to ?? monthKey(new Date(now));
  const start = filter.from ?? shiftMonth(end, -5);
  const [from, to] = start > end ? [end, start] : [start, end];
  const earliest = shiftMonth(to, -(MAX_MONTHS - 1));
  return { from: from < earliest ? earliest : from, to };
}

export function computeInsights(db: Db, scope: AccountScope, filter: InsightsFilter, now: number): Insights {
  const { from, to } = resolveRange(filter, now);
  const inAccounts = and(
    inScope(scope, canonicalTransactions.canonicalAccountId),
    filter.account ? eq(canonicalTransactions.canonicalAccountId, filter.account) : undefined,
    gte(canonicalTransactions.date, `${from}-01`),
    lt(canonicalTransactions.date, `${shiftMonth(to, 1)}-01`),
  );

  const currencies = db
    .select({ currency: canonicalTransactions.currency, n: sql<number>`count(*)` })
    .from(canonicalTransactions)
    .where(and(inAccounts, eq(canonicalTransactions.status, 'posted')))
    .groupBy(canonicalTransactions.currency)
    .orderBy(sql`count(*) desc`, canonicalTransactions.currency)
    .all();
  const currency =
    filter.currency && currencies.some((c) => c.currency === filter.currency)
      ? filter.currency
      : (currencies[0]?.currency ?? null);

  const months = monthsBetween(from, to).map((month) => ({ month, moneyInMinor: 0, spendingMinor: 0 }));
  const coverage = {
    included: 0,
    pendingExcluded: 0,
    transfersExcluded: 0,
    refunds: 0,
    unclassifiedInflows: 0,
    bankTransferLike: 0,
    otherCurrencies: currencies.filter((c) => c.currency !== currency).reduce((n, c) => n + c.n, 0),
  };
  if (currency === null) return { currency, currencies: [], from, to, months, categories: [], coverage };

  const inCurrency = and(inAccounts, eq(canonicalTransactions.currency, currency));
  coverage.pendingExcluded = db
    .select({ n: sql<number>`count(*)` })
    .from(canonicalTransactions)
    .where(and(inCurrency, eq(canonicalTransactions.status, 'pending')))
    .get()!.n;

  const rows = db
    .select({
      date: canonicalTransactions.date,
      amountMinor: canonicalTransactions.amountMinor,
      providerCategory: canonicalTransactions.providerCategory,
      category: annotations.category,
      kind: annotations.kind,
    })
    .from(canonicalTransactions)
    .leftJoin(annotations, eq(annotations.canonicalTransactionId, canonicalTransactions.id))
    .where(and(inCurrency, eq(canonicalTransactions.status, 'posted')))
    .all();

  const byMonth = new Map(months.map((m) => [m.month, m]));
  const byCategory = new Map<
    string,
    { name: string; spendingMinor: number; count: number; source: 'user' | 'bank' | 'none' }
  >();
  for (const row of rows) {
    if (row.kind === 'transfer') {
      coverage.transfersExcluded++;
      continue;
    }
    coverage.included++;
    if (
      row.kind === null &&
      row.category === null &&
      row.providerCategory &&
      bankTransferLike.test(row.providerCategory)
    ) {
      coverage.bankTransferLike++;
    }
    const month = byMonth.get(row.date.slice(0, 7))!;
    const isSpending = row.kind === 'refund' || row.amountMinor > 0;
    if (!isSpending) {
      month.moneyInMinor -= row.amountMinor;
      coverage.unclassifiedInflows++;
      continue;
    }
    if (row.kind === 'refund' && row.amountMinor < 0) coverage.refunds++;
    month.spendingMinor += row.amountMinor;
    const name = row.category ?? row.providerCategory ?? 'Uncategorized';
    const source = row.category ? 'user' : row.providerCategory ? 'bank' : 'none';
    const bucket = byCategory.get(name) ?? { name, spendingMinor: 0, count: 0, source };
    if (source === 'user') bucket.source = 'user';
    bucket.spendingMinor += row.amountMinor;
    bucket.count++;
    byCategory.set(name, bucket);
  }

  const sorted = [...byCategory.values()].sort(
    (a, b) => b.spendingMinor - a.spendingMinor || a.name.localeCompare(b.name),
  );
  const positive = sorted.filter((c) => c.spendingMinor >= 0);
  const keep = positive.length > TOP_CATEGORIES + 1 ? TOP_CATEGORIES : positive.length;
  const top = [...positive.slice(0, keep), ...sorted.filter((c) => c.spendingMinor < 0)];
  const rest = positive.slice(keep);
  const categories = rest.length
    ? [
        ...top.filter((c) => c.spendingMinor >= 0),
        {
          name: `${rest.length} other categories`,
          spendingMinor: rest.reduce((n, c) => n + c.spendingMinor, 0),
          count: rest.reduce((n, c) => n + c.count, 0),
          source: 'none' as const,
        },
        ...top.filter((c) => c.spendingMinor < 0),
      ]
    : top;

  return {
    currency,
    currencies: currencies.map((c) => c.currency).sort(),
    from,
    to,
    months,
    categories,
    coverage,
  };
}
