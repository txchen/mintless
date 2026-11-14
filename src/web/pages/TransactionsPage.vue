<script setup lang="ts">
import { useIntersectionObserver, useMediaQuery } from '@vueuse/core';
import { Download, Search, SlidersHorizontal, X } from '@lucide/vue';
import { computed, nextTick, provide, ref, useTemplateRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AccountLabel from '@/components/AccountLabel.vue';
import GroupSelect from '@/components/GroupSelect.vue';
import Amount from '@/components/Amount.vue';
import NativeSelect from '@/components/NativeSelect.vue';
import StatusMarks from '@/components/StatusMarks.vue';
import ScopeHeader from '@/components/ScopeHeader.vue';
import ScopePending from '@/components/ScopePending.vue';
import ScopeUnavailable from '@/components/ScopeUnavailable.vue';
import TransactionTable from '@/components/TransactionTable.vue';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useAccounts } from '@/composables/useAccounts.ts';
import { useColumnWidths } from '@/composables/useColumnWidths.ts';
import { onRevalidate } from '@/composables/useRevalidate.ts';
import { useScope } from '@/composables/useScope.ts';
import {
  activeFilterCount,
  apiQuery,
  defaultFilters,
  filtersFromQuery,
  filtersToQuery,
  transactionListKey,
  useTransactionList,
  type Filters,
} from '@/composables/useTransactions.ts';
import { formatDay, formatShortDate } from '@/lib/format.ts';
import type { TransactionRow } from '../../shared/contracts.ts';

const route = useRoute();
const router = useRouter();
const wide = useMediaQuery('(min-width: 768px)');
const desktop = useMediaQuery('(min-width: 1024px)');
const { accounts, categories, groups: groupList, ensure, refresh: refreshAccounts } = useAccounts();
void ensure();

const filters = computed<Filters>(() => filtersFromQuery(route.query));
const { state: scope } = useScope();
const list = useTransactionList(filters);
async function revalidateAll() {
  void list.revalidate();
  // A scope that disappears on refresh is reported by useScope, never rewritten.
  await refreshAccounts();
}
onRevalidate(revalidateAll);
provide(transactionListKey, {
  rows: list.rows,
  upsert: list.upsert,
  remove: list.remove,
  lostAccess: revalidateAll,
});

const { customized: columnsCustomized, reset: resetColumns } = useColumnWidths();
const selectedId = computed(() => (typeof route.params.id === 'string' ? route.params.id : null));
const panelOpen = computed(() => selectedId.value !== null);

function setFilters(next: Partial<Filters>) {
  void router.replace({ path: '/transactions', query: filtersToQuery({ ...filters.value, ...next }) });
}

const search = ref(filters.value.q);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, (q) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => setFilters({ q: q.trim() }), 250);
});
watch(
  () => filters.value.q,
  (q) => {
    if (q !== search.value.trim()) search.value = q;
  },
);

const accountsFor = (group: string) => accounts.value.filter((a) => !group || a.groupId === group);
const optionsFor = (group: string) => [
  { value: '', label: 'All' },
  ...accountsFor(group).map((a) => ({
    value: a.id,
    label: a.mask ? `${a.displayName} ··${a.mask}` : a.displayName,
  })),
];
const accountOptions = computed(() => optionsFor(filters.value.group));
const draftAccountOptions = computed(() => optionsFor(draft.value.group));
const statusOptions = [
  { value: 'active', label: 'Pending + posted' },
  { value: 'posted', label: 'Posted' },
  { value: 'pending', label: 'Pending' },
  { value: 'removed', label: 'Removed' },
  { value: 'all', label: 'All, incl. removed' },
];
const reviewOptions = [
  { value: '', label: 'Any' },
  { value: 'any', label: 'Needs review' },
  { value: 'reconciliation', label: 'Changed after reconcile' },
  { value: 'lifecycle', label: 'Bank lifecycle questions' },
  { value: 'uncategorized', label: 'Uncategorized' },
];
const reconciledOptions = [
  { value: '', label: 'Any' },
  { value: 'no', label: 'Not reconciled' },
  { value: 'yes', label: 'Reconciled' },
];
const categoryOptions = computed(() => [
  { value: '', label: 'All' },
  ...categories.value.map((c) => ({ value: c, label: c })),
]);

const filterCount = computed(() => activeFilterCount(filters.value));
const drawerOpen = ref(false);
const draft = ref<Filters>({ ...defaultFilters });
function openDrawer() {
  draft.value = { ...filters.value };
  drawerOpen.value = true;
}
function applyDraft() {
  setFilters({ ...draft.value, q: filters.value.q });
  drawerOpen.value = false;
}
function resetDraft() {
  draft.value = {
    ...defaultFilters,
    q: filters.value.q,
    group: filters.value.group,
    account: filters.value.account,
  };
}

const groups = computed(() => {
  const out: { date: string; rows: TransactionRow[] }[] = [];
  for (const row of list.rows.value) {
    const last = out[out.length - 1];
    if (last?.date === row.date) last.rows.push(row);
    else out.push({ date: row.date, rows: [row] });
  }
  return out;
});

const sentinel = useTemplateRef<HTMLElement>('sentinel');
useIntersectionObserver(sentinel, ([entry]) => entry?.isIntersecting && void list.loadMore(), {
  rootMargin: '400px',
});

const detailLink = (row: TransactionRow) => ({ path: `/transactions/${row.id}`, query: route.query });
const exportHref = computed(() => `/api/transactions/export.csv?${apiQuery(filters.value)}`);
const title = (row: TransactionRow) => row.merchantName ?? row.name;
const categoryOf = (row: TransactionRow) => row.annotation.category ?? null;

watch(selectedId, async (id, previous) => {
  if (id || !previous) return;
  await nextTick();
  document.querySelector<HTMLElement>(`[data-row-link="${previous}"]`)?.focus({ preventScroll: true });
});
</script>

<template>
  <div
    class="mx-auto lg:flex"
    :style="{ maxWidth: panelOpen ? 'calc(var(--content-max) + var(--panel-w))' : 'var(--content-max)' }"
  >
    <section
      class="min-w-0 flex-1"
      :aria-hidden="panelOpen && !desktop ? 'true' : undefined"
      :inert="panelOpen && !desktop"
    >
      <ScopeHeader>
        <template #actions>
          <Button
            v-if="wide && columnsCustomized"
            variant="ghost"
            size="sm"
            class="text-muted-foreground"
            @click="resetColumns"
          >
            Reset columns
          </Button>
          <Button
            v-if="scope.kind === 'all' || scope.kind === 'group' || scope.kind === 'account'"
            as="a"
            :href="exportHref"
            variant="outline"
            size="sm"
            class="hidden md:inline-flex"
          >
            <Download aria-hidden="true" /> Export CSV
          </Button>
        </template>
      </ScopeHeader>
      <ScopeUnavailable v-if="scope.kind === 'unavailable'" :state="scope" />
      <ScopePending
        v-else-if="scope.kind === 'loading' || scope.kind === 'error'"
        :failed="scope.kind === 'error'"
      />
      <template v-else>
        <header class="sticky top-0 z-20 border-b bg-background/95 px-3 py-2 backdrop-blur md:px-7">
          <div class="flex items-center gap-1.5">
            <div class="relative mr-1 min-w-0 flex-1 md:max-w-60 md:min-w-40">
              <Search
                class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                v-model="search"
                type="search"
                placeholder="Search merchant, note, tag"
                aria-label="Search transactions"
                class="h-9 pl-8 text-[14px] md:h-8 md:text-[13px]"
              />
            </div>
            <template v-if="wide">
              <NativeSelect
                :model-value="filters.account"
                label="Account"
                :options="accountOptions"
                variant="chip"
                @update:model-value="setFilters({ account: $event })"
              />
              <NativeSelect
                :model-value="filters.status"
                label="Status"
                :options="statusOptions"
                variant="chip"
                @update:model-value="setFilters({ status: $event as Filters['status'] })"
              />
              <NativeSelect
                :model-value="filters.review"
                label="Review"
                :options="reviewOptions"
                variant="chip"
                @update:model-value="setFilters({ review: $event as Filters['review'] })"
              />
              <NativeSelect
                :model-value="filters.reconciled"
                label="Reconciled"
                :options="reconciledOptions"
                variant="chip"
                :class="panelOpen ? 'hidden 2xl:inline-flex' : 'hidden xl:inline-flex'"
                @update:model-value="setFilters({ reconciled: $event as Filters['reconciled'] })"
              />
              <Button
                v-if="filterCount"
                variant="ghost"
                size="sm"
                class="text-muted-foreground"
                @click="
                  setFilters({
                    ...defaultFilters,
                    q: filters.q,
                    group: filters.group,
                    account: filters.account,
                  })
                "
              >
                <X aria-hidden="true" /> Clear
              </Button>
            </template>
            <Button
              v-else
              variant="outline"
              class="h-9 shrink-0"
              :aria-label="`Filters${filterCount ? `, ${filterCount} active` : ''}`"
              @click="openDrawer"
            >
              <SlidersHorizontal aria-hidden="true" />
              Filters
              <span
                v-if="filterCount"
                class="rounded-full bg-primary px-1.5 text-[11px] leading-4 text-primary-foreground"
                >{{ filterCount }}</span
              >
            </Button>
          </div>
        </header>

        <p
          v-if="list.error.value"
          role="alert"
          class="mx-3 mt-3 rounded-md bg-warning-surface px-3 py-2 text-[13px] md:mx-5"
        >
          {{ list.error.value }}
          <button class="ml-2 underline" @click="list.reload()">Retry</button>
        </p>

        <div
          v-if="list.loading.value && !list.rows.value.length"
          class="space-y-2 px-3 py-4 md:px-5"
          aria-busy="true"
          aria-label="Loading transactions"
        >
          <Skeleton v-for="i in 8" :key="i" class="h-10 w-full" />
        </div>

        <div
          v-else-if="!list.rows.value.length && !list.error.value"
          class="px-5 py-16 text-center text-[13px] text-muted-foreground"
        >
          <template v-if="filterCount || filters.q">
            No transactions match these filters.
            <button
              class="ml-1 text-foreground underline"
              @click="setFilters({ ...defaultFilters, group: filters.group, account: filters.account })"
            >
              Clear filters
            </button>
          </template>
          <template v-else>No transactions yet. They appear after the first bank sync.</template>
        </div>

        <TransactionTable
          v-else-if="wide"
          :rows="list.rows.value"
          :selected-id="selectedId"
          :loading="list.loading.value"
          :link="detailLink"
        />

        <div v-else :class="list.loading.value && 'opacity-60'">
          <section v-for="group in groups" :key="group.date" :aria-label="formatDay(group.date)">
            <h2
              class="sticky top-[3.3rem] z-10 border-b bg-secondary/95 px-3 py-1 text-[12px] font-medium text-muted-foreground backdrop-blur"
            >
              {{ formatDay(group.date) }}
            </h2>
            <RouterLink
              v-for="row in group.rows"
              :key="row.id"
              :to="detailLink(row)"
              :data-row-link="row.id"
              class="flex min-h-14 items-center gap-3 border-b px-3 py-2 outline-none focus-visible:bg-accent active:bg-secondary"
              :class="row.status === 'removed' && 'text-muted-foreground'"
            >
              <div class="min-w-0 flex-1">
                <div class="truncate text-[15px] font-medium">{{ title(row) }}</div>
                <div class="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
                  <AccountLabel
                    :name="row.accountName"
                    :mask="row.accountMask"
                    class="max-w-[62%] shrink-0"
                  />
                  <span aria-hidden="true">·</span>
                  <span class="min-w-0 truncate">{{ categoryOf(row) ?? 'Uncategorized' }}</span>
                  <StatusMarks :row="row" class="ml-auto shrink-0" />
                </div>
                <div v-if="row.annotation.note" class="truncate text-[12px] text-muted-foreground">
                  {{ row.annotation.note }}
                </div>
              </div>
              <Amount
                :minor="row.amountMinor"
                :currency="row.currency"
                :removed="row.status === 'removed'"
                class="text-[15px] font-medium"
              />
            </RouterLink>
          </section>
        </div>

        <div ref="sentinel" class="h-px" />
        <p v-if="list.loadingMore.value" class="py-4 text-center text-[12px] text-muted-foreground">
          Loading more…
        </p>
        <p
          v-else-if="list.rows.value.length && !list.nextCursor.value"
          class="py-6 text-center text-[12px] text-muted-foreground"
        >
          {{ list.rows.value.length }} transactions
        </p>
      </template>
    </section>

    <RouterView v-slot="{ Component }">
      <aside
        v-if="Component"
        class="fixed inset-0 z-40 bg-background lg:sticky lg:top-0 lg:z-0 lg:h-dvh lg:w-[var(--panel-w)] lg:shrink-0 lg:border-l"
        aria-label="Transaction details"
      >
        <component :is="Component" :key="selectedId" />
      </aside>
    </RouterView>

    <Drawer v-model:open="drawerOpen">
      <DrawerContent class="pb-[env(safe-area-inset-bottom)]">
        <DrawerHeader class="pb-2 text-left">
          <DrawerTitle>Filters</DrawerTitle>
          <DrawerDescription class="sr-only">Narrow the transaction list</DrawerDescription>
        </DrawerHeader>
        <div class="grid gap-3 overflow-y-auto px-4 pb-2 text-[14px]">
          <label v-if="groupList.length > 1" class="grid gap-1"
            ><span class="text-[12px] text-muted-foreground">Group</span
            ><GroupSelect
              :model-value="draft.group"
              :groups="groupList"
              class="[&_select]:h-10 [&_select]:text-[15px]"
              @update:model-value="((draft.group = $event), (draft.account = ''))"
          /></label>
          <label class="grid gap-1"
            ><span class="text-[12px] text-muted-foreground">Account</span
            ><NativeSelect
              v-model="draft.account"
              label="Account"
              :options="draftAccountOptions"
              class="[&_select]:h-10 [&_select]:text-[15px]"
          /></label>
          <label class="grid gap-1"
            ><span class="text-[12px] text-muted-foreground">Status</span
            ><NativeSelect
              v-model="draft.status"
              label="Status"
              :options="statusOptions"
              class="[&_select]:h-10 [&_select]:text-[15px]"
          /></label>
          <label class="grid gap-1"
            ><span class="text-[12px] text-muted-foreground">Review</span
            ><NativeSelect
              v-model="draft.review"
              label="Review"
              :options="reviewOptions"
              class="[&_select]:h-10 [&_select]:text-[15px]"
          /></label>
          <label class="grid gap-1"
            ><span class="text-[12px] text-muted-foreground">Reconciled</span
            ><NativeSelect
              v-model="draft.reconciled"
              label="Reconciled"
              :options="reconciledOptions"
              class="[&_select]:h-10 [&_select]:text-[15px]"
          /></label>
          <label class="grid gap-1"
            ><span class="text-[12px] text-muted-foreground">Category</span
            ><NativeSelect
              v-model="draft.category"
              label="Category"
              :options="categoryOptions"
              class="[&_select]:h-10 [&_select]:text-[15px]"
          /></label>
          <div class="grid grid-cols-2 gap-2">
            <label class="grid gap-1"
              ><span class="text-[12px] text-muted-foreground">From</span
              ><Input v-model="draft.from" type="date" class="h-10"
            /></label>
            <label class="grid gap-1"
              ><span class="text-[12px] text-muted-foreground">To</span
              ><Input v-model="draft.to" type="date" class="h-10"
            /></label>
          </div>
        </div>
        <DrawerFooter class="flex-row gap-2">
          <Button variant="outline" class="h-11 flex-1" @click="resetDraft">Reset</Button>
          <Button class="h-11 flex-1" @click="applyDraft">Apply</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  </div>
</template>
