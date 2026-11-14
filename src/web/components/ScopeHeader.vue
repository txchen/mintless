<script setup lang="ts">
import { ChevronDown } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import Amount from '@/components/Amount.vue';
import ScopeTree from '@/components/ScopeTree.vue';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { useAccounts } from '@/composables/useAccounts.ts';
import { useScope } from '@/composables/useScope.ts';
import { formatRelative } from '@/lib/format.ts';

const route = useRoute();
const { accounts, groups } = useAccounts();
const picker = ref(false);

const groupId = computed(() => (typeof route.query.group === 'string' ? route.query.group : ''));
const accountId = computed(() => (typeof route.query.account === 'string' ? route.query.account : ''));
const { state } = useScope();
const account = computed(() => (state.value.kind === 'account' ? state.value.account : null));
const group = computed(() =>
  state.value.kind === 'account'
    ? state.value.group
    : state.value.kind === 'group'
      ? state.value.group
      : null,
);
const unavailableTitle = {
  account: 'Account unavailable',
  group: 'Group unavailable',
  mismatch: 'Account not in this group',
} as const;
const scope = computed(() => {
  if (state.value.kind === 'unavailable')
    return { kicker: 'Scope', title: unavailableTitle[state.value.reason], mask: null };
  if (state.value.kind === 'loading') return { kicker: 'Scope', title: 'Loading…', mask: null };
  if (state.value.kind === 'error') return { kicker: 'Scope', title: 'Scope not loaded', mask: null };
  if (account.value)
    return {
      kicker: group.value?.name ?? 'Account',
      title: account.value.displayName,
      mask: account.value.mask,
    };
  if (group.value) return { kicker: 'Group', title: group.value.name, mask: null };
  return { kicker: 'Scope', title: 'All accounts', mask: null };
});
const meta = computed(() => {
  if (account.value) return null;
  if (state.value.kind === 'unavailable') return 'From the link you opened';
  if (state.value.kind === 'loading' || state.value.kind === 'error') return '';
  const list = group.value ? accounts.value.filter((a) => a.groupId === group.value!.id) : accounts.value;
  const n = list.length;
  const groupCount = new Set(list.map((a) => a.groupId)).size;
  return group.value
    ? `${n} ${n === 1 ? 'account' : 'accounts'}${group.value.protected ? ' · admins only' : ''}`
    : `${n} ${n === 1 ? 'account' : 'accounts'} in ${groupCount} ${groupCount === 1 ? 'group' : 'groups'}`;
});
const scopeQuery = computed(() => ({
  ...(groupId.value ? { group: groupId.value } : {}),
  ...(accountId.value ? { account: accountId.value } : {}),
}));
const tabs = [
  { to: '/transactions', label: 'Transactions' },
  { to: '/overview', label: 'Overview' },
];
const activeTab = (to: string) => route.path === to || route.path.startsWith(`${to}/`);
</script>

<template>
  <header class="border-b bg-card">
    <div class="flex flex-wrap items-end gap-x-4 gap-y-2 px-3 pt-3 md:px-7 md:pt-5">
      <div class="min-w-0 flex-1">
        <p class="label-caps">{{ scope.kicker }}</p>
        <h1
          class="flex min-w-0 items-baseline gap-2 text-[20px] leading-tight font-semibold tracking-[-0.02em] md:text-[24px]"
        >
          <span class="min-w-0 truncate" :title="scope.title">{{ scope.title }}</span>
          <span
            v-if="scope.mask"
            class="num shrink-0 text-[15px] font-medium text-muted-foreground md:text-[17px]"
            >··{{ scope.mask }}</span
          >
        </h1>
        <p class="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[13px] text-muted-foreground">
          <template v-if="account">
            <template v-if="account.balanceCurrentMinor !== null">
              <span>{{ account.kind === 'credit' ? 'Owed' : 'Balance' }}</span>
              <span class="text-[15px] font-semibold text-foreground"
                ><Amount :minor="account.balanceCurrentMinor" :currency="account.currency" unsigned />
                <span class="ml-1 text-[12px] font-normal text-muted-foreground">{{
                  account.currency
                }}</span></span
              >
              <span>cached · fetched {{ formatRelative(account.balanceFetchedAt) }}</span>
            </template>
            <span v-else>No cached balance yet</span>
          </template>
          <span v-else>{{ meta }}</span>
        </p>
      </div>
      <div class="flex items-center gap-1 pb-1">
        <slot name="actions" />
        <button
          type="button"
          class="inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
          @click="picker = true"
        >
          Scope<ChevronDown class="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
    <nav class="mt-2 flex gap-5 px-3 md:px-7" aria-label="Scope views">
      <RouterLink
        v-for="t in tabs"
        :key="t.to"
        :to="{ path: t.to, query: scopeQuery }"
        class="-mb-px border-b-2 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :class="
          activeTab(t.to)
            ? 'border-primary font-semibold text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground'
        "
        :aria-current="activeTab(t.to) ? 'page' : undefined"
        >{{ t.label }}</RouterLink
      >
    </nav>
    <Drawer v-model:open="picker">
      <DrawerContent class="pb-[env(safe-area-inset-bottom)]">
        <DrawerHeader class="pb-1 text-left">
          <DrawerTitle>Scope</DrawerTitle>
          <DrawerDescription>Show one account, one group, or everything you can see.</DrawerDescription>
        </DrawerHeader>
        <div class="max-h-[65dvh] overflow-y-auto px-3 pb-4">
          <ScopeTree tone="sheet" @navigate="picker = false" />
        </div>
      </DrawerContent>
    </Drawer>
  </header>
</template>
