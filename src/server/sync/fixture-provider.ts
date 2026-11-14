import * as v from 'valibot';
import {
  ProviderError,
  type ProviderAccount,
  type ProviderTransaction,
  type TransactionsProvider,
} from './provider.ts';

const FixtureToken = v.object({
  dataset: v.picklist(['household-bank', 'household-card']),
  anchor: v.pipe(v.string(), v.isoDate()),
  seed: v.number(),
});
export type FixtureToken = v.InferOutput<typeof FixtureToken>;

type Snapshot = { accounts: ProviderAccount[]; transactions: Map<string, ProviderTransaction> };
type Change =
  | { kind: 'added'; tx: ProviderTransaction }
  | { kind: 'modified'; tx: ProviderTransaction }
  | { kind: 'removed'; id: string };

const institutionNames: Record<FixtureToken['dataset'], string> = {
  'household-bank': 'Harbor Community Bank (demo)',
  'household-card': 'Summit Card Services (demo)',
};

export function parseFixtureToken(token: string): FixtureToken {
  return v.parse(FixtureToken, JSON.parse(token));
}

export class FixtureProvider implements TransactionsProvider {
  async syncPage(accessToken: string, cursor: string | null, count: number) {
    const token = parseFixtureToken(accessToken);
    const versions = buildVersions(token);
    const position = parseCursor(cursor, versions.length - 1);
    const from = position.from;
    const to = Math.min(from + 1, versions.length - 1);
    const target = versions[to]!;
    const changes = diff(versions[from]!, target);
    const page = changes.slice(position.offset, position.offset + count);
    const hasMore = position.offset + count < changes.length;
    return {
      added: page.flatMap((c) => (c.kind === 'added' ? [c.tx] : [])),
      modified: page.flatMap((c) => (c.kind === 'modified' ? [c.tx] : [])),
      removed: page.flatMap((c) => (c.kind === 'removed' ? [{ providerTransactionId: c.id }] : [])),
      accounts: target.accounts,
      nextCursor: hasMore ? `p${from}>${to}@${position.offset + count}` : `v${to}`,
      hasMore,
      transactionsUpdateStatus: to === 0 ? 'NOT_READY' : 'HISTORICAL_UPDATE_COMPLETE',
    };
  }

  async getAccounts(accessToken: string) {
    const token = parseFixtureToken(accessToken);
    const versions = buildVersions(token);
    return {
      accounts: versions[versions.length - 1]!.accounts,
      institutionName: institutionNames[token.dataset],
    };
  }
}

function parseCursor(cursor: string | null, max: number): { from: number; offset: number } {
  if (cursor === null || cursor === '') return { from: 0, offset: 0 };
  const committed = /^v(\d+)$/.exec(cursor);
  if (committed) return { from: Math.min(Number(committed[1]), max), offset: 0 };
  const page = /^p(\d+)>\d+@(\d+)$/.exec(cursor);
  if (page) return { from: Number(page[1]), offset: Number(page[2]) };
  throw new ProviderError('INVALID_REQUEST', 'Unknown fixture cursor');
}

function diff(before: Snapshot, after: Snapshot): Change[] {
  const changes: Change[] = [];
  for (const [id, tx] of after.transactions) {
    const prior = before.transactions.get(id);
    if (!prior) changes.push({ kind: 'added', tx });
    else if (JSON.stringify(prior) !== JSON.stringify(tx)) changes.push({ kind: 'modified', tx });
  }
  for (const id of before.transactions.keys()) {
    if (!after.transactions.has(id)) changes.push({ kind: 'removed', id });
  }
  return changes;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

type Spend = { merchant: string; category: string; min: number; max: number; weight: number };

const cardSpend: Spend[] = [
  { merchant: 'Whole Foods Market', category: 'Groceries', min: 2400, max: 18800, weight: 5 },
  { merchant: 'Trader Joe’s', category: 'Groceries', min: 1800, max: 9600, weight: 4 },
  { merchant: 'Blue Bottle Coffee', category: 'Dining', min: 450, max: 1400, weight: 5 },
  { merchant: 'Tartine Manufactory', category: 'Dining', min: 2200, max: 9800, weight: 3 },
  { merchant: 'Shell', category: 'Transportation', min: 3200, max: 7400, weight: 2 },
  { merchant: 'Lyft', category: 'Transportation', min: 900, max: 4600, weight: 2 },
  { merchant: 'Amazon', category: 'Shopping', min: 1299, max: 15999, weight: 4 },
  { merchant: 'Target', category: 'Shopping', min: 1500, max: 12000, weight: 2 },
  { merchant: 'Walgreens', category: 'Health', min: 600, max: 4200, weight: 1 },
  {
    merchant: 'The Very Long Neighborhood Hardware and Garden Supply Cooperative',
    category: 'Home',
    min: 1800,
    max: 26000,
    weight: 1,
  },
];

function buildVersions(token: FixtureToken): Snapshot[] {
  const rand = mulberry32(token.seed);
  const pick = <T extends { weight: number }>(items: T[]): T => {
    const total = items.reduce((s, i) => s + i.weight, 0);
    let r = rand() * total;
    for (const item of items) if ((r -= item.weight) < 0) return item;
    return items[items.length - 1]!;
  };
  const amount = (min: number, max: number) => Math.round(min + rand() * (max - min));
  const prefix = `${token.dataset}-${token.seed}`;
  let counter = 0;
  const make = (
    account: string,
    date: string,
    name: string,
    amountMinor: number,
    category: string | null,
    extra: Partial<ProviderTransaction> = {},
  ): ProviderTransaction => {
    const id = extra.providerTransactionId ?? `${prefix}-tx-${String(++counter).padStart(4, '0')}`;
    return {
      providerTransactionId: id,
      providerAccountId: `${prefix}-${account}`,
      pending: false,
      pendingTransactionId: null,
      amountMinor,
      currency: 'USD',
      date,
      authorizedDate: date,
      name: name.toUpperCase(),
      merchantName: name,
      category,
      raw: { fixture: true },
      ...extra,
    };
  };

  const today = token.anchor;
  const history = new Map<string, ProviderTransaction>();
  const put = (tx: ProviderTransaction) => history.set(tx.providerTransactionId, tx);

  if (token.dataset === 'household-bank') {
    for (let day = -84; day <= -1; day++) {
      const date = addDays(today, day);
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (dow === 5 && Math.abs(day) % 14 < 7)
        put(make('checking', date, 'Northwind Payroll', -412_550, 'Income'));
      if (date.endsWith('-01')) {
        put(make('checking', date, 'Maple Street Apartments', 285_000, 'Rent'));
        put(make('checking', date, 'Transfer to Savings', 50_000, 'Transfer'));
        put(make('savings', date, 'Transfer from Checking', -50_000, 'Transfer'));
      }
      if (date.endsWith('-05'))
        put(make('checking', date, 'Pacific Gas & Electric', amount(9_000, 16_000), 'Utilities'));
      if (date.endsWith('-12')) {
        const payment = amount(120_000, 180_000);
        put(make('checking', date, 'Harbor Card Payment', payment, 'Credit card payment'));
        put(make('credit', date, 'Payment Received', -payment, 'Credit card payment'));
      }
      if (date.endsWith('-28')) put(make('savings', date, 'Interest Paid', -amount(300, 900), 'Interest'));
      const daily = rand() < 0.35 ? 2 : 1;
      for (let i = 0; i < daily; i++) {
        const s = pick(cardSpend);
        put(make('credit', date, s.merchant, amount(s.min, s.max), s.category));
      }
    }
  } else {
    for (let day = -60; day <= -1; day++) {
      if (rand() < 0.55) {
        const s = pick(cardSpend);
        put(make('card', addDays(today, day), s.merchant, amount(s.min, s.max), s.category));
      }
    }
  }

  const accounts = (version: number): ProviderAccount[] => {
    const shift = version * 1_731;
    if (token.dataset === 'household-card') {
      return [
        account(
          'card',
          'Summit Rewards Visa',
          'credit',
          'credit card',
          '7741',
          84_210 + shift,
          null,
          1_000_000,
        ),
      ];
    }
    return [
      account(
        'checking',
        'Everyday Checking',
        'depository',
        'checking',
        '0142',
        1_284_377 - shift,
        1_270_112 - shift,
        null,
      ),
      account(
        'savings',
        'Rainy Day Savings',
        'depository',
        'savings',
        '9930',
        2_610_005 + shift,
        2_610_005 + shift,
        null,
      ),
      account(
        'credit',
        'Harbor Cash Back Card',
        'credit',
        'credit card',
        '3318',
        162_944 + shift,
        837_056 - shift,
        1_000_000,
      ),
    ];
  };
  function account(
    id: string,
    name: string,
    type: string,
    subtype: string,
    mask: string,
    current: number,
    available: number | null,
    limit: number | null,
  ): ProviderAccount {
    return {
      providerAccountId: `${prefix}-${id}`,
      name,
      officialName: null,
      mask,
      type,
      subtype,
      persistentAccountId: `${prefix}-persistent-${id}`,
      currency: 'USD',
      balances: { currentMinor: current, availableMinor: available, limitMinor: limit },
    };
  }

  const snapshot = (version: number, txs: Map<string, ProviderTransaction>): Snapshot => ({
    accounts: accounts(version),
    transactions: new Map(txs),
  });
  const empty = snapshot(0, new Map());

  const ids = (n: string) => `${prefix}-${n}`;
  const acct = token.dataset === 'household-bank' ? 'credit' : 'card';
  const v1 = new Map(history);
  const pendingDinner = make(acct, addDays(today, -1), 'Nopa Restaurant', 4_210, 'Dining', {
    providerTransactionId: ids('pending-dinner'),
    pending: true,
  });
  const pendingFuel = make(acct, addDays(today, 0), 'Chevron', 3_500, 'Transportation', {
    providerTransactionId: ids('pending-fuel'),
    pending: true,
  });
  v1.set(pendingDinner.providerTransactionId, pendingDinner);
  v1.set(pendingFuel.providerTransactionId, pendingFuel);

  const v2 = new Map(v1);
  v2.delete(pendingDinner.providerTransactionId);
  v2.delete(pendingFuel.providerTransactionId);
  const postedDinner = make(acct, addDays(today, 0), 'Nopa Restaurant', 5_052, 'Dining', {
    providerTransactionId: ids('posted-dinner'),
    pendingTransactionId: pendingDinner.providerTransactionId,
  });
  v2.set(postedDinner.providerTransactionId, postedDinner);
  const pendingGroceries = make(acct, addDays(today, 1), 'Rainbow Grocery', 6_320, 'Groceries', {
    providerTransactionId: ids('pending-groceries'),
    pending: true,
  });
  v2.set(pendingGroceries.providerTransactionId, pendingGroceries);
  const renamed = [...history.values()].find((t) => t.merchantName === 'Amazon');
  if (renamed)
    v2.set(renamed.providerTransactionId, {
      ...renamed,
      name: 'AMAZON MARKETPLACE',
      merchantName: 'Amazon Marketplace',
    });

  const v3 = new Map(v2);
  v3.delete(pendingGroceries.providerTransactionId);
  v3.set(
    ids('posted-groceries'),
    make(acct, addDays(today, 1), 'Rainbow Grocery', 6_320, 'Groceries', {
      providerTransactionId: ids('posted-groceries'),
      pendingTransactionId: pendingGroceries.providerTransactionId,
    }),
  );
  const refunded = [...history.values()].find(
    (t) => t.category === 'Shopping' && t.providerAccountId.endsWith(acct),
  );
  if (refunded) {
    v3.set(
      ids('refund'),
      make(acct, addDays(today, 2), `${refunded.merchantName} Refund`, -refunded.amountMinor, 'Shopping', {
        providerTransactionId: ids('refund'),
      }),
    );
  }
  const corrected = [...history.values()].find((t) => t.category === 'Utilities' || t.category === 'Health');
  if (corrected)
    v3.set(corrected.providerTransactionId, { ...corrected, amountMinor: corrected.amountMinor - 160 });

  return [empty, snapshot(1, v1), snapshot(2, v2), snapshot(3, v3)];
}
