<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import Amount from '@/components/Amount.vue';
import { useAccounts } from '@/composables/useAccounts.ts';
import { useScope } from '@/composables/useScope.ts';
import { formatRelative } from '@/lib/format.ts';
import type { AccountSummary } from '../../shared/contracts.ts';

const props = defineProps<{ tone: 'rail' | 'sheet' }>();
const emit = defineEmits<{ navigate: [] }>();
const route = useRoute();
const { accounts, groups } = useAccounts();
const { state } = useScope();

const page = computed(() => (route.path.startsWith('/overview') ? '/overview' : '/transactions'));
const sections = computed(() =>
  groups.value
    .map((g) => ({ group: g, accounts: accounts.value.filter((a) => a.groupId === g.id) }))
    .filter((s) => s.accounts.length || !s.group.protected || isGroup(s.group.id)),
);

function keep(next: Record<string, string | undefined>) {
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(route.query))
    if (typeof v === 'string' && k !== 'group' && k !== 'account') query[k] = v;
  for (const [k, v] of Object.entries(next)) if (v) query[k] = v;
  return { path: page.value, query };
}
// Exactly one entry is current, and none while the requested scope is unavailable.
const isAll = computed(() => state.value.kind === 'all');
const isGroup = (id: string) => state.value.kind === 'group' && state.value.group.id === id;
const isAccount = (id: string) => state.value.kind === 'account' && state.value.account.id === id;
const balanceLabel = (a: AccountSummary) =>
  a.balanceCurrentMinor === null
    ? 'No cached balance'
    : `${a.kind === 'credit' ? 'Owed' : 'Balance'}, cached, fetched ${formatRelative(a.balanceFetchedAt)}`;

const c = computed(() =>
  props.tone === 'rail'
    ? {
        item: 'text-rail-foreground hover:bg-rail-active/70 focus-visible:ring-rail-accent',
        active: 'bg-rail-active text-rail-foreground shadow-[inset_2px_0_0_var(--rail-accent)]',
        muted: 'text-rail-muted',
      }
    : {
        item: 'text-foreground hover:bg-secondary focus-visible:ring-ring',
        active: 'bg-accent text-accent-foreground shadow-[inset_2px_0_0_var(--primary)]',
        muted: 'text-muted-foreground',
      },
);
</script>

<template>
  <nav aria-label="Account scope" class="grid grid-cols-[minmax(0,1fr)] gap-0.5 text-[13px]">
    <RouterLink
      :to="keep({})"
      class="flex min-h-9 items-center rounded-md px-2.5 font-medium outline-none focus-visible:ring-2"
      :class="[c.item, isAll && c.active]"
      :aria-current="isAll ? 'page' : undefined"
      @click="emit('navigate')"
      >All accounts</RouterLink
    >
    <section
      v-for="s in sections"
      :key="s.group.id"
      :aria-label="s.group.name"
      class="mt-3 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-0.5"
    >
      <RouterLink
        :to="keep({ group: s.group.id })"
        class="flex min-h-8 items-center justify-between gap-2 rounded-md px-2.5 text-[10.5px] font-semibold tracking-[0.06em] uppercase outline-none focus-visible:ring-2"
        :class="[c.item, isGroup(s.group.id) ? c.active : c.muted]"
        :aria-current="isGroup(s.group.id) ? 'page' : undefined"
        @click="emit('navigate')"
      >
        <span class="min-w-0 truncate" :title="s.group.name">{{ s.group.name }}</span>
        <span class="shrink-0 font-medium normal-case tracking-normal">{{
          s.group.protected ? 'admins only' : s.accounts.length
        }}</span>
      </RouterLink>
      <p v-if="!s.accounts.length" class="px-2.5 py-1 text-[12px]" :class="c.muted">No accounts yet</p>
      <RouterLink
        v-for="a in s.accounts"
        :key="a.id"
        :to="keep({ group: s.group.id, account: a.id })"
        class="block rounded-md py-1.5 pr-2.5 pl-4 outline-none focus-visible:ring-2"
        :class="[c.item, isAccount(a.id) && c.active]"
        :aria-current="isAccount(a.id) ? 'page' : undefined"
        :title="`${a.displayName}${a.mask ? ` ending ${a.mask}` : ''} · ${balanceLabel(a)}`"
        @click="emit('navigate')"
      >
        <span class="flex min-w-0 items-baseline gap-1"
          ><span class="min-w-0 truncate">{{ a.displayName }}</span
          ><span v-if="a.mask" class="num shrink-0" :class="c.muted">··{{ a.mask }}</span></span
        >
        <span class="num mt-0.5 flex items-baseline gap-1.5 text-[12px]">
          <template v-if="a.balanceCurrentMinor !== null">
            <span :class="c.muted">{{ a.kind === 'credit' ? 'Owed' : 'Balance' }}</span>
            <Amount :minor="a.balanceCurrentMinor" :currency="a.currency" unsigned />
            <span v-if="a.currency !== 'USD'" class="text-[10.5px]" :class="c.muted">{{ a.currency }}</span>
          </template>
          <span v-else :class="c.muted">No cached balance</span>
          <span class="sr-only">, {{ balanceLabel(a) }}</span>
        </span>
      </RouterLink>
    </section>
  </nav>
</template>
