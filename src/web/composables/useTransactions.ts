import { ref, watch, type InjectionKey, type Ref } from 'vue';
import type { LocationQuery, LocationQueryRaw } from 'vue-router';
import type { StatusFilter, TransactionPage, TransactionRow } from '../../shared/contracts.ts';
import { api, errorMessage } from '../lib/api.ts';

export type Filters = {
  q: string;
  group: string;
  account: string;
  status: StatusFilter;
  review: '' | 'any' | 'reconciliation' | 'lifecycle' | 'uncategorized';
  reconciled: '' | 'yes' | 'no';
  category: string;
  from: string;
  to: string;
};

export const defaultFilters: Filters = {
  q: '',
  group: '',
  account: '',
  status: 'active',
  review: '',
  reconciled: '',
  category: '',
  from: '',
  to: '',
};

const keys = Object.keys(defaultFilters) as (keyof Filters)[];

export function filtersFromQuery(query: LocationQuery): Filters {
  const pick = (k: keyof Filters) =>
    typeof query[k] === 'string' ? (query[k] as string) : defaultFilters[k];
  return Object.fromEntries(keys.map((k) => [k, pick(k)])) as Filters;
}

export function filtersToQuery(f: Filters): LocationQueryRaw {
  return Object.fromEntries(keys.filter((k) => f[k] !== defaultFilters[k]).map((k) => [k, f[k]]));
}

export const activeFilterCount = (f: Filters) =>
  keys.filter((k) => k !== 'q' && k !== 'group' && k !== 'account' && f[k] !== defaultFilters[k]).length;

export function apiQuery(f: Filters, extra: Record<string, string> = {}) {
  const params = new URLSearchParams();
  for (const k of keys) if (f[k] !== '') params.set(k, f[k]);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return params.toString();
}

export type TransactionList = {
  rows: Ref<TransactionRow[]>;
  upsert: (row: TransactionRow) => void;
  remove: (id: string) => void;
  lostAccess: () => Promise<void>;
};

export const transactionListKey: InjectionKey<TransactionList> = Symbol('transaction-list');

export function useTransactionList(filters: Ref<Filters>) {
  const rows = ref<TransactionRow[]>([]);
  const nextCursor = ref<string | null>(null);
  const loading = ref(false);
  const loadingMore = ref(false);
  const error = ref('');
  let controller: AbortController | undefined;
  let generation = 0;

  async function reload(limit = 80) {
    const mine = ++generation;
    controller?.abort();
    controller = new AbortController();
    loading.value = true;
    error.value = '';
    try {
      const page = await api<TransactionPage>(
        `/transactions?${apiQuery(filters.value, { limit: String(limit) })}`,
        {
          signal: controller.signal,
        },
      );
      if (mine !== generation) return;
      rows.value = page.rows;
      nextCursor.value = page.nextCursor;
    } catch (e) {
      if ((e as Error).name === 'AbortError' || mine !== generation) return;
      error.value = errorMessage(e);
    } finally {
      if (mine === generation) loading.value = false;
    }
  }

  async function loadMore() {
    if (!nextCursor.value || loadingMore.value || loading.value) return;
    loadingMore.value = true;
    const mine = generation;
    const signal = controller?.signal;
    try {
      const page = await api<TransactionPage>(
        `/transactions?${apiQuery(filters.value, { limit: '80', cursor: nextCursor.value })}`,
        { signal },
      );
      if (mine !== generation) return;
      const seen = new Set(rows.value.map((r) => r.id));
      rows.value = [...rows.value, ...page.rows.filter((r) => !seen.has(r.id))];
      nextCursor.value = page.nextCursor;
    } catch (e) {
      if (mine === generation && (e as Error).name !== 'AbortError') error.value = errorMessage(e);
    } finally {
      loadingMore.value = false;
    }
  }

  watch(filters, () => reload(), { deep: true, immediate: true });

  return {
    rows,
    nextCursor,
    loading,
    loadingMore,
    error,
    reload,
    revalidate: () => reload(Math.min(200, Math.max(80, rows.value.length))),
    loadMore,
    upsert(row: TransactionRow) {
      const index = rows.value.findIndex((r) => r.id === row.id);
      if (index >= 0) rows.value.splice(index, 1, row);
    },
    remove(id: string) {
      rows.value = rows.value.filter((r) => r.id !== id);
    },
  };
}
