<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { formatMinor } from '@/lib/format.ts';
import type { Insights } from '../../shared/contracts.ts';

const props = defineProps<{ months: Insights['months']; currency: string }>();

const selected = ref(props.months.length - 1);
watch(
  () => props.months.length,
  (n) => (selected.value = n - 1),
);

const monthName = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
const monthYear = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const asDate = (m: string) => new Date(`${m}-01T00:00:00Z`);

const scale = computed(() => {
  const high = Math.max(0, ...props.months.flatMap((m) => [m.moneyInMinor, m.spendingMinor]));
  const low = Math.min(0, ...props.months.map((m) => m.spendingMinor));
  const span = high - low || 1;
  return { zero: (high / span) * 100, pct: (v: number) => (Math.abs(v) / span) * 100 };
});

const bar = (value: number) =>
  value >= 0
    ? { bottom: `${100 - scale.value.zero}%`, height: `${scale.value.pct(value)}%` }
    : { top: `${scale.value.zero}%`, height: `${scale.value.pct(value)}%` };

const current = computed(() => props.months[selected.value] ?? props.months[props.months.length - 1]);
const money = (v: number) => formatMinor(v, props.currency);

function onKey(e: KeyboardEvent) {
  const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  selected.value = Math.min(props.months.length - 1, Math.max(0, selected.value + step));
  (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')[selected.value]?.focus();
}
</script>

<template>
  <div>
    <div
      v-if="current"
      class="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[13px]"
      aria-live="polite"
    >
      <span class="font-medium">{{ monthYear.format(asDate(current.month)) }}</span>
      <span
        ><span class="mr-1 inline-block size-2 rounded-sm bg-chart-in" aria-hidden="true" />Money in
        <span class="num font-medium">{{ money(current.moneyInMinor) }}</span></span
      >
      <span
        ><span class="mr-1 inline-block size-2 rounded-sm bg-chart-out" aria-hidden="true" />Spending
        <span class="num font-medium">{{ money(current.spendingMinor) }}</span></span
      >
      <span class="text-muted-foreground"
        >Net <span class="num">{{ money(current.moneyInMinor - current.spendingMinor) }}</span></span
      >
    </div>
    <div class="mt-2 flex h-36 items-stretch gap-1" role="radiogroup" aria-label="Month" @keydown="onKey">
      <button
        v-for="(m, i) in months"
        :key="m.month"
        type="button"
        role="radio"
        :aria-checked="i === selected"
        :tabindex="i === selected ? 0 : -1"
        :aria-label="`${monthYear.format(asDate(m.month))}: money in ${money(m.moneyInMinor)}, spending ${money(m.spendingMinor)}`"
        class="group flex min-w-0 flex-1 flex-col rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :class="i === selected ? 'bg-secondary' : 'hover:bg-secondary/60'"
        @click="selected = i"
      >
        <div class="relative w-full flex-1">
          <div class="absolute inset-x-0 border-t border-border" :style="{ top: `${scale.zero}%` }" />
          <div class="absolute inset-x-[20%] flex h-full gap-[12%]">
            <div class="relative flex-1">
              <div class="absolute inset-x-0 rounded-t-[2px] bg-chart-in" :style="bar(m.moneyInMinor)" />
            </div>
            <div class="relative flex-1">
              <div
                class="absolute inset-x-0 bg-chart-out"
                :class="m.spendingMinor < 0 ? 'rounded-b-[2px]' : 'rounded-t-[2px]'"
                :style="bar(m.spendingMinor)"
              />
            </div>
          </div>
        </div>
        <span
          class="mt-1 text-center text-[11px] text-muted-foreground"
          :class="i === selected && 'font-medium text-foreground'"
          >{{ monthName.format(asDate(m.month)) }}</span
        >
      </button>
    </div>
  </div>
</template>
