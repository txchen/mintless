<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Amount from '@/components/Amount.vue';
import CategoryBars from '@/components/CategoryBars.vue';
import MonthlyTrend from '@/components/MonthlyTrend.vue';
import NativeSelect from '@/components/NativeSelect.vue';
import { Skeleton } from '@/components/ui/skeleton';
import { onRevalidate } from '@/composables/useRevalidate.ts';
import { api, errorMessage } from '@/lib/api.ts';
import type { AccountSummary, Insights } from '../../shared/contracts.ts';

const props = defineProps<{ accounts: AccountSummary[]; group: string }>();
const route = useRoute();
const router = useRouter();

type Range = '3' | '6' | '12' | 'ytd';
const ranges: { value: Range; label: string }[] = [
  { value: '3', label: 'Last 3 months' },
  { value: '6', label: 'Last 6 months' },
  { value: '12', label: 'Last 12 months' },
  { value: 'ytd', label: 'This year' },
];
const rangeLabel = computed(() => ranges.find((r) => r.value === range.value)!.label.toLowerCase());
const param = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : '');
const range = computed<Range>(() =>
  ranges.some((r) => r.value === param('range')) ? (param('range') as Range) : '6',
);
const account = computed(() => param('account'));
const currency = computed(() => param('currency'));

function setParam(next: Record<string, string>) {
  const query = { ...route.query, ...next };
  for (const [k, v] of Object.entries(query)) if (v === '' || (k === 'range' && v === '6')) delete query[k];
  void router.replace({ query });
}

function monthsFor(r: Range) {
  const now = new Date();
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const from =
    r === 'ytd'
      ? new Date(Date.UTC(now.getUTCFullYear(), 0, 1))
      : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - Number(r) + 1, 1));
  const key = (d: Date) => d.toISOString().slice(0, 7);
  return { from: key(from), to: key(to) };
}

const data = ref<Insights | null>(null);
const loading = ref(false);
const error = ref('');
let seq = 0;

async function load() {
  const mine = ++seq;
  loading.value = true;
  error.value = '';
  const params = new URLSearchParams(monthsFor(range.value));
  if (account.value) params.set('account', account.value);
  if (currency.value) params.set('currency', currency.value);
  if (props.group) params.set('group', props.group);
  try {
    const result = await api<Insights>(`/insights?${params}`);
    if (mine === seq) data.value = result;
  } catch (e) {
    if (mine === seq) error.value = errorMessage(e);
  } finally {
    if (mine === seq) loading.value = false;
  }
}
watch([range, account, currency, () => props.group], load, { immediate: true });
onRevalidate(load);

const totals = computed(() => {
  const months = data.value?.months ?? [];
  const moneyIn = months.reduce((n, m) => n + m.moneyInMinor, 0);
  const spending = months.reduce((n, m) => n + m.spendingMinor, 0);
  const net = moneyIn - spending;
  return [
    { label: 'Money in', minor: moneyIn, tone: '', net: false },
    { label: 'Spending', minor: spending, tone: '', net: false },
    {
      label: 'Net · money in − spending',
      minor: net,
      tone: net < 0 ? 'text-warning-foreground' : 'text-inflow',
      net: true,
    },
  ];
});
const summaryLine = computed(() => {
  const c = data.value?.coverage;
  if (!c || !data.value) return '';
  const excluded = [
    c.pendingExcluded && `${c.pendingExcluded} pending`,
    c.transfersExcluded && `${c.transfersExcluded} marked transfers`,
    c.otherCurrencies && `${c.otherCurrencies} in other currencies`,
  ].filter(Boolean);
  return `${data.value.currency} · ${rangeLabel.value} · ${c.included} posted transactions counted${excluded.length ? `; excludes ${excluded.join(', ')}` : ''}.`;
});
const caveat = computed(() => {
  const c = data.value?.coverage;
  if (!c) return '';
  const parts = [
    c.bankTransferLike && `${c.bankTransferLike} possible transfers counted`,
    c.unclassifiedInflows && `${c.unclassifiedInflows} unmarked inflows in money in`,
  ].filter(Boolean);
  return parts.join(' · ');
});
const hasData = computed(() => Boolean(data.value?.currency && data.value.coverage.included));
const allTransfers = computed(() => (data.value?.coverage.transfersExcluded ?? 0) > 0);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const coverage = computed(() => {
  const c = data.value?.coverage;
  if (!c) return [];
  return [
    `Posted transactions only: ${plural(c.included, 'transaction', 'transactions')} counted.`,
    c.pendingExcluded
      ? `${plural(c.pendingExcluded, 'pending transaction is', 'pending transactions are')} excluded until posted.`
      : '',
    c.transfersExcluded
      ? `${plural(c.transfersExcluded, 'transfer or payment', 'transfers or payments')} you marked are left out.`
      : '',
    c.refunds
      ? `${plural(c.refunds, 'refund', 'refunds')} you marked reduce spending in their category.`
      : '',
    c.unclassifiedInflows
      ? `Money in includes every other inflow (${c.unclassifiedInflows}), such as pay, interest, and any refund or transfer you have not marked.`
      : '',
    c.bankTransferLike
      ? `The bank labels ${plural(c.bankTransferLike, 'counted transaction', 'counted transactions')} as a transfer or payment. Mintless does not guess; mark them as Transfer or payment to leave them out.`
      : '',
    c.otherCurrencies
      ? `${plural(c.otherCurrencies, 'transaction', 'transactions')} in other currencies are not converted or added.`
      : '',
  ].filter(Boolean);
});
</script>

<template>
  <section aria-labelledby="activity" class="min-w-0">
    <div class="flex flex-wrap items-center gap-2">
      <h2 id="activity" class="label-caps mr-auto">Activity</h2>
      <NativeSelect
        :model-value="range"
        label="Range"
        :options="ranges"
        variant="chip"
        default-value="6"
        @update:model-value="setParam({ range: $event })"
      />

      <div
        v-if="data && data.currencies.length > 1"
        class="flex rounded-md border p-0.5"
        role="group"
        aria-label="Currency"
      >
        <button
          v-for="c in data.currencies"
          :key="c"
          type="button"
          :aria-pressed="c === data.currency"
          class="h-7 rounded px-2 text-[12px]"
          :class="c === data.currency ? 'bg-secondary font-medium' : 'text-muted-foreground'"
          @click="setParam({ currency: c })"
        >
          {{ c }}
        </button>
      </div>
      <span v-else-if="data?.currency" class="text-[12px] text-muted-foreground">{{ data.currency }}</span>
    </div>

    <p v-if="error" role="alert" class="mt-3 rounded-md bg-warning-surface px-3 py-2 text-[13px]">
      {{ error }} <button class="ml-1 underline" @click="load">Retry</button>
    </p>
    <div
      v-else-if="!data"
      class="mt-3 grid gap-4 md:grid-cols-[3fr_2fr]"
      aria-busy="true"
      aria-label="Loading activity"
    >
      <Skeleton class="h-44" /><Skeleton class="h-44" />
    </div>
    <p v-else-if="!hasData" class="mt-3 text-[13px] text-muted-foreground">
      <template v-if="allTransfers">
        Nothing is counted in this range: all {{ data.coverage.transfersExcluded }} posted transactions are
        marked as transfers or payments.
      </template>
      <template v-else
        >No posted transactions in this range{{ account ? ' for this account' : '' }}.</template
      >
    </p>
    <div v-else class="mt-3 grid gap-x-10 gap-y-6 md:grid-cols-[3fr_2fr]" :class="loading && 'opacity-60'">
      <dl class="grid grid-cols-1 border-y sm:grid-cols-3 md:col-span-2">
        <div
          v-for="(t, i) in totals"
          :key="t.label"
          class="flex min-w-0 items-baseline justify-between gap-3 py-2.5 sm:block sm:py-3"
          :class="i > 0 && 'border-t sm:border-t-0 sm:border-l sm:pl-5'"
        >
          <dt class="label-caps">{{ t.label }}</dt>
          <dd class="text-[17px] font-semibold tracking-[-0.01em] sm:mt-1 md:text-[22px]">
            <span :class="t.tone"
              ><span v-if="t.net" aria-hidden="true">{{ t.minor < 0 ? '−' : '+' }}</span
              ><span v-if="t.net" class="sr-only">{{ t.minor < 0 ? 'minus ' : 'plus ' }}</span
              ><Amount :minor="t.minor" :currency="data.currency!" unsigned
            /></span>
          </dd>
        </div>
      </dl>
      <figure class="min-w-0">
        <figcaption class="mb-2 text-[13px] font-medium">Money in and spending by month</figcaption>
        <MonthlyTrend :months="data.months" :currency="data.currency!" />
      </figure>
      <figure class="min-w-0">
        <figcaption class="mb-2 text-[13px] font-medium">
          Spending by category
          <span class="font-normal text-muted-foreground">· total for {{ rangeLabel }}</span>
        </figcaption>
        <CategoryBars
          v-if="data.categories.length"
          :categories="data.categories"
          :currency="data.currency!"
        />
        <p v-else class="text-[13px] text-muted-foreground">No spending in this range.</p>
      </figure>
      <div class="text-[12px] leading-snug text-muted-foreground md:col-span-2">
        <p>
          {{ summaryLine }}
          <span v-if="caveat" class="ml-1 rounded bg-warning-surface px-1.5 py-0.5 text-warning-foreground">{{
            caveat
          }}</span>
        </p>
        <details class="mt-1.5">
          <summary class="cursor-pointer text-foreground/80 underline-offset-2 hover:underline">
            How this is counted
          </summary>
          <ul class="mt-1 space-y-0.5">
            <li v-for="line in coverage" :key="line">{{ line }}</li>
            <li>
              Categories use your label, or the bank's when you have not set one. Spending is outflows minus
              marked refunds. Net is money in minus spending; it is not a balance.
            </li>
          </ul>
        </details>
      </div>
    </div>
  </section>
</template>
