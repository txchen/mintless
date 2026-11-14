<script setup lang="ts">
import { computed } from 'vue';
import { formatMinor } from '@/lib/format.ts';
import type { Insights } from '../../shared/contracts.ts';

const props = defineProps<{ categories: Insights['categories']; currency: string }>();

const scale = computed(() => {
  const pos = Math.max(0, ...props.categories.map((c) => c.spendingMinor));
  const neg = Math.max(0, ...props.categories.map((c) => -c.spendingMinor));
  const span = pos + neg || 1;
  return { zero: (neg / span) * 100, pct: (v: number) => (Math.abs(v) / span) * 100 };
});

const bar = (v: number) =>
  v >= 0
    ? { left: `${scale.value.zero}%`, width: `${scale.value.pct(v)}%` }
    : { right: `${100 - scale.value.zero}%`, width: `${scale.value.pct(v)}%` };
</script>

<template>
  <ul class="space-y-2">
    <li v-for="c in categories" :key="c.name" class="text-[13px]">
      <div class="flex items-baseline gap-2">
        <span class="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {{ c.name }}
          <span v-if="c.source === 'bank'" class="text-[11px] text-muted-foreground">bank label</span>
        </span>
        <span class="text-[11px] whitespace-nowrap text-muted-foreground"
          >{{ c.count }} {{ c.count === 1 ? 'txn' : 'txns' }}</span
        >
        <span class="num w-24 shrink-0 text-right font-medium" :class="c.spendingMinor < 0 && 'text-inflow'">
          {{ formatMinor(c.spendingMinor, currency) }}
        </span>
      </div>
      <div class="relative mt-0.5 h-1.5 rounded-full bg-secondary" aria-hidden="true">
        <div
          v-if="scale.zero > 0"
          class="absolute inset-y-[-2px] w-px bg-border"
          :style="{ left: `${scale.zero}%` }"
        />
        <div
          class="absolute inset-y-0 rounded-full"
          :class="c.spendingMinor < 0 ? 'border border-inflow bg-inflow/30' : 'bg-chart-out'"
          :style="bar(c.spendingMinor)"
        />
      </div>
    </li>
  </ul>
</template>
