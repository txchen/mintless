<script setup lang="ts">
import { ArrowLeftRight, Building2, CircleCheck, LayoutGrid, LogOut, Settings } from '@lucide/vue';
import { onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import ScopeTree from '@/components/ScopeTree.vue';
import { useAccounts } from '@/composables/useAccounts.ts';
import { onRevalidate } from '@/composables/useRevalidate.ts';
import { api } from '@/lib/api.ts';
import { useSession } from '@/lib/session.ts';
import type { Overview } from '../../shared/contracts.ts';

const route = useRoute();
const session = useSession();
const { user } = session;
async function signOut() {
  await session.logout();
  window.location.assign('/login');
}
const { ensure } = useAccounts();
void ensure();

const nav = [
  { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
  { to: '/overview', label: 'Overview', icon: LayoutGrid },
  { to: '/review', label: 'Review', icon: CircleCheck },
  { to: '/accounts', label: 'Accounts', icon: Building2 },
  { to: '/settings', label: 'Settings', icon: Settings },
];
const utilities = [
  { to: '/review', label: 'Review', icon: CircleCheck },
  { to: '/accounts', label: 'Accounts', icon: Building2 },
  { to: '/settings', label: 'Settings', icon: Settings },
];
const active = (to: string) => route.path === to || route.path.startsWith(`${to}/`);

const needsReview = ref(0);
let seq = 0;
async function loadReview() {
  const mine = ++seq;
  try {
    const o = await api<Overview>('/overview');
    if (mine === seq) needsReview.value = o.review.reconciliation + o.review.lifecycle;
  } catch {
    return;
  }
}
onMounted(loadReview);
onRevalidate(loadReview);
watch(() => route.fullPath, loadReview);
</script>

<template>
  <div class="min-h-dvh md:pl-64">
    <aside class="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-rail text-rail-foreground md:flex">
      <RouterLink
        to="/transactions"
        class="mx-3 mt-3.5 mb-3 flex items-center gap-2 rounded-md px-2 py-1 text-[15px] font-semibold tracking-[-0.01em] outline-none focus-visible:ring-2 focus-visible:ring-rail-accent"
      >
        <img src="/favicon.svg" alt="" width="22" height="22" class="size-[22px]" />
        Mintless
      </RouterLink>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        <ScopeTree tone="rail" />
      </div>
      <nav class="grid gap-0.5 border-t border-white/10 px-3 py-2" aria-label="Workspace">
        <RouterLink
          v-for="item in utilities"
          :key="item.to"
          :to="item.to"
          class="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] outline-none hover:bg-rail-active/70 focus-visible:ring-2 focus-visible:ring-rail-accent"
          :class="
            active(item.to)
              ? 'bg-rail-active font-medium shadow-[inset_2px_0_0_var(--rail-accent)]'
              : 'text-rail-foreground/90'
          "
          :aria-current="active(item.to) ? 'page' : undefined"
        >
          <component :is="item.icon" class="size-4 text-rail-muted" aria-hidden="true" />
          <span class="flex-1">{{ item.label }}</span>
          <span
            v-if="item.to === '/review' && needsReview"
            class="num rounded-full bg-rail-active px-1.5 text-[11px] font-semibold"
            :aria-label="`${needsReview} need review`"
            >{{ needsReview }}</span
          >
        </RouterLink>
      </nav>
      <div class="flex items-center gap-2 border-t border-white/10 px-5 py-3 text-[12px]">
        <span
          class="grid size-6 shrink-0 place-items-center rounded-full bg-rail-active text-[11px] font-semibold uppercase"
          aria-hidden="true"
          >{{ user?.username.slice(0, 1) }}</span
        >
        <span class="min-w-0 truncate"
          ><span class="font-medium">{{ user?.username }}</span
          ><span class="text-rail-muted"> · {{ user?.role === 'admin' ? 'Admin' : 'Member' }}</span></span
        >
        <button
          type="button"
          class="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-rail-muted outline-none hover:bg-rail-active hover:text-rail-foreground focus-visible:ring-2 focus-visible:ring-rail-accent"
          aria-label="Sign out"
          title="Sign out"
          @click="signOut"
        >
          <LogOut class="size-4" aria-hidden="true" />
        </button>
      </div>
    </aside>
    <main class="pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <slot />
    </main>
    <nav
      class="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      aria-label="Primary"
    >
      <RouterLink
        v-for="item in nav"
        :key="item.to"
        :to="item.to"
        class="relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground"
        :class="active(item.to) && 'text-primary'"
        :aria-current="active(item.to) ? 'page' : undefined"
      >
        <component :is="item.icon" class="size-5" aria-hidden="true" />
        {{ item.label }}
        <span
          v-if="item.to === '/review' && needsReview"
          class="num absolute top-1.5 left-[calc(50%+6px)] rounded-full bg-warning-surface px-1 text-[10px] font-semibold text-warning-foreground"
          :aria-label="`${needsReview} need review`"
          >{{ needsReview }}</span
        >
      </RouterLink>
    </nav>
  </div>
</template>
