<script setup lang="ts">
import { ChevronRight } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import { onRevalidate } from '@/composables/useRevalidate.ts';
import { api, errorMessage } from '@/lib/api.ts';
import type { Overview } from '../../shared/contracts.ts';

const data = ref<Overview | null>(null);
const error = ref('');
async function load() {
  try {
    error.value = '';
    data.value = await api<Overview>('/overview');
  } catch (e) {
    error.value = errorMessage(e);
  }
}
onMounted(load);
onRevalidate(load);
const items = [
  {
    key: 'reconciliation',
    title: 'Changed after reconciling',
    body: 'The bank changed the amount, date, or account of a reconciled transaction. Confirm the new values.',
    query: { review: 'reconciliation', status: 'all' },
  },
  {
    key: 'lifecycle',
    title: 'Bank lifecycle questions',
    body: 'The bank removed a transaction you had annotated, or posted one that names a pending charge Mintless never received. Notes are kept.',
    query: { review: 'lifecycle', status: 'all' },
  },
  {
    key: 'uncategorized',
    title: 'Uncategorized',
    body: 'Pending and posted transactions without a category.',
    query: { review: 'uncategorized' },
  },
] as const;
</script>

<template>
  <div class="mx-auto w-full max-w-[var(--content-max)]">
    <PageHeader title="Review" />
    <p v-if="error" role="alert" class="m-4 text-[13px] text-destructive">{{ error }}</p>
    <ul v-else class="max-w-2xl divide-y md:mx-5 md:mt-4 md:rounded-md md:border">
      <li v-for="item in items" :key="item.key">
        <RouterLink
          :to="{ path: '/transactions', query: item.query }"
          class="flex items-center gap-3 px-3 py-3 hover:bg-secondary md:px-4"
        >
          <div class="min-w-0 flex-1">
            <div class="text-[14px] font-medium">{{ item.title }}</div>
            <p class="text-[13px] text-muted-foreground">{{ item.body }}</p>
          </div>
          <span
            class="num text-[15px] font-semibold"
            :class="!data?.review[item.key] && 'text-muted-foreground'"
            >{{ data ? data.review[item.key] : '·' }}</span
          >
          <ChevronRight class="size-4 text-muted-foreground" aria-hidden="true" />
        </RouterLink>
      </li>
    </ul>
  </div>
</template>
