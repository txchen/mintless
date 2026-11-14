<script setup lang="ts">
import { computed } from 'vue';
import { currencyExponent } from '../../shared/money.ts';

const props = defineProps<{ minor: number; currency: string; removed?: boolean; unsigned?: boolean }>();
const parts = computed(() => {
  const inflow = props.minor < 0;
  const exponent = currencyExponent(props.currency);
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: props.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).formatToParts(Math.abs(props.minor) / 10 ** exponent);
  const split = formatted.findIndex((p) => p.type === 'decimal');
  const join = (list: Intl.NumberFormatPart[]) => list.map((p) => p.value).join('');
  const sign = props.unsigned ? '' : inflow ? '+' : '−';
  return {
    inflow,
    whole: sign + join(split < 0 ? formatted : formatted.slice(0, split)),
    fraction: split < 0 ? '' : join(formatted.slice(split)),
  };
});
</script>

<template>
  <span
    class="num whitespace-nowrap"
    :class="[parts.inflow && !unsigned && 'text-inflow', removed && 'text-muted-foreground line-through']"
    >{{ parts.whole }}<span class="text-[0.86em] font-normal">{{ parts.fraction }}</span
    ><span v-if="!unsigned" class="sr-only">{{ parts.inflow ? ' inflow' : ' outflow' }}</span></span
  >
</template>
