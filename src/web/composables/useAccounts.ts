import { ref } from 'vue';
import type { AccountSummary, GroupSummary } from '../../shared/contracts.ts';
import { api } from '../lib/api.ts';

const accounts = ref<AccountSummary[]>([]);
const categories = ref<string[]>([]);
const groups = ref<GroupSummary[]>([]);
const loaded = ref(false);
const failed = ref(false);
let inflight: Promise<void> | undefined;
let generation = 0;

function refresh() {
  const current = ++generation;
  inflight = Promise.all([
    api<AccountSummary[]>('/accounts'),
    api<string[]>('/categories'),
    api<GroupSummary[]>('/groups'),
  ])
    .then(([a, c, g]) => {
      if (current !== generation) return;
      accounts.value = a;
      categories.value = c;
      groups.value = g;
      loaded.value = true;
      failed.value = false;
    })
    .catch(() => {
      if (current === generation) failed.value = true;
    });
  return inflight;
}

export function resetAccounts() {
  generation++;
  inflight = undefined;
  accounts.value = [];
  categories.value = [];
  groups.value = [];
  loaded.value = false;
  failed.value = false;
}

export function useAccounts() {
  return { accounts, categories, groups, loaded, failed, refresh, ensure: () => inflight ?? refresh() };
}
