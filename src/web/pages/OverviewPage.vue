<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import ActivityCharts from '@/components/ActivityCharts.vue';
import ScopeHeader from '@/components/ScopeHeader.vue';
import ScopePending from '@/components/ScopePending.vue';
import ScopeUnavailable from '@/components/ScopeUnavailable.vue';
import { useAccounts } from '@/composables/useAccounts.ts';
import { onRevalidate } from '@/composables/useRevalidate.ts';
import { useScope } from '@/composables/useScope.ts';
import { api, errorMessage } from '@/lib/api.ts';
import { formatMinor, formatRelative } from '@/lib/format.ts';
import { useSession } from '@/lib/session.ts';
import type { AccountSummary, Overview } from '../../shared/contracts.ts';

const { isAdmin } = useSession();
const data = ref<Overview | null>(null);
const accounts = ref<AccountSummary[]>([]);
const error = ref('');
const route = useRoute();
const { refresh: refreshShared } = useAccounts();
const group = computed(() => (typeof route.query.group === 'string' ? route.query.group : ''));
const scopedAccount = computed(() => (typeof route.query.account === 'string' ? route.query.account : ''));
const scopeQuery = computed(() => ({
  ...(group.value ? { group: group.value } : {}),
  ...(scopedAccount.value ? { account: scopedAccount.value } : {}),
}));
const groupQuery = computed(() => {
  const q = new URLSearchParams();
  if (group.value) q.set('group', group.value);
  if (scopedAccount.value) q.set('account', scopedAccount.value);
  return q.size ? `?${q}` : '';
});
const { state: scope } = useScope();

let seq = 0;
async function load() {
  const mine = ++seq;
  // An unavailable scope shows an explicit notice, never another scope's numbers.
  if (scope.value.kind !== 'all' && scope.value.kind !== 'group' && scope.value.kind !== 'account') {
    data.value = null;
    error.value = '';
    void refreshShared();
    return;
  }
  try {
    error.value = '';
    const [overviewData, accountList] = await Promise.all([
      api<Overview>(`/overview${groupQuery.value}`),
      api<AccountSummary[]>(`/accounts${groupQuery.value}`),
      refreshShared(),
    ]);
    if (mine !== seq) return;
    [data.value, accounts.value] = [overviewData, accountList];
  } catch (e) {
    if (mine === seq) error.value = errorMessage(e);
  }
}
onMounted(load);
onRevalidate(load);
watch([group, scopedAccount, () => scope.value.kind], load);

const groupLabel = { cash: 'Cash', credit: 'Credit card balances', other: 'Other' } as const;
const reviewLinks = [
  {
    key: 'reconciliation',
    label: 'Changed after reconciling',
    query: { review: 'reconciliation', status: 'all' },
  },
  {
    key: 'lifecycle',
    label: 'Bank lifecycle questions',
    query: { review: 'lifecycle', status: 'all' },
  },
  { key: 'uncategorized', label: 'Uncategorized', query: { review: 'uncategorized' } },
  { key: 'pending', label: 'Pending', query: { status: 'pending' } },
] as const;
</script>

<template>
  <div class="mx-auto w-full max-w-[var(--content-max)]">
    <ScopeHeader>
      <template #actions>
        <span v-if="data" class="hidden text-[12px] text-muted-foreground md:inline"
          >Last sync {{ formatRelative(data.lastSyncAt) }}</span
        >
      </template>
    </ScopeHeader>
    <ScopeUnavailable v-if="scope.kind === 'unavailable'" :state="scope" />
    <ScopePending
      v-else-if="scope.kind === 'loading' || scope.kind === 'error'"
      :failed="scope.kind === 'error'"
    />
    <p v-else-if="error" role="alert" class="m-4 text-[13px] text-destructive">{{ error }}</p>
    <div
      v-else-if="data"
      class="grid grid-cols-1 gap-x-10 gap-y-8 px-3 py-5 md:grid-cols-[minmax(0,1fr)_17rem] md:px-7"
    >
      <ActivityCharts :accounts="accounts" :group="group" class="md:col-span-2" />
      <section aria-labelledby="balances" class="md:hidden">
        <h2 id="balances" class="label-caps">Cached balances</h2>
        <p v-if="!data.groups.length" class="mt-2 text-[13px] text-muted-foreground">No balances yet.</p>
        <div v-for="g in data.groups" :key="`${g.kind}${g.currency}`" class="mt-3">
          <div class="flex items-baseline justify-between border-b pb-1">
            <span class="text-[13px] font-medium">{{ groupLabel[g.kind] }}</span>
            <span class="num text-[17px] font-semibold">{{ formatMinor(g.totalMinor, g.currency) }}</span>
          </div>
          <ul>
            <li
              v-for="a in accounts.filter(
                (x) =>
                  (g.kind === 'cash'
                    ? x.kind === 'depository'
                    : g.kind === 'credit'
                      ? x.kind === 'credit'
                      : !['depository', 'credit'].includes(x.kind)) && x.currency === g.currency,
              )"
              :key="a.id"
              class="flex items-baseline gap-2 border-b py-2 text-[13px]"
            >
              <RouterLink
                :to="{ path: '/transactions', query: { account: a.id } }"
                class="min-w-0 flex-1 truncate hover:underline"
              >
                {{ a.displayName }}<span v-if="a.mask" class="text-muted-foreground"> ··{{ a.mask }}</span>
              </RouterLink>
              <span class="hidden text-[12px] text-muted-foreground sm:inline"
                >fetched {{ formatRelative(a.balanceFetchedAt) }}</span
              >
              <span class="num">{{
                a.balanceCurrentMinor === null ? '—' : formatMinor(a.balanceCurrentMinor, a.currency)
              }}</span>
            </li>
          </ul>
        </div>
        <p class="mt-3 text-[12px] text-muted-foreground">
          Balances are cached from the last bank sync and are not real-time. Credit balances show the amount
          owed.
        </p>
      </section>
      <section aria-labelledby="review" class="md:col-span-2">
        <h2 id="review" class="label-caps">Bookkeeping in this scope</h2>
        <ul class="mt-2 grid grid-cols-2 border-y md:grid-cols-4">
          <li
            v-for="(r, i) in reviewLinks"
            :key="r.key"
            :class="[i % 2 && 'border-l', i > 1 && 'border-t md:border-t-0', i === 2 && 'md:border-l']"
          >
            <RouterLink
              :to="{ path: '/transactions', query: { ...r.query, ...scopeQuery } }"
              class="block px-3 py-2.5 outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring md:px-4"
            >
              <span class="block text-[12px] text-muted-foreground">{{ r.label }}</span>
              <span
                class="num text-[20px] font-semibold"
                :class="data.review[r.key] === 0 && 'text-muted-foreground'"
                >{{ data.review[r.key] }}</span
              >
            </RouterLink>
          </li>
        </ul>
        <p
          v-if="isAdmin && data.syncProblems"
          class="mt-3 rounded-md bg-warning-surface px-3 py-2 text-[13px]"
        >
          {{ data.syncProblems }} bank connection{{ data.syncProblems === 1 ? '' : 's' }} reported an error.
          <RouterLink to="/settings" class="underline">Open settings</RouterLink>
        </p>
      </section>
    </div>
  </div>
</template>
