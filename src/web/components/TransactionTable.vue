<script setup lang="ts">
import { useElementSize } from '@vueuse/core';
import { computed, onBeforeUnmount, ref, useTemplateRef } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import AccountLabel from '@/components/AccountLabel.vue';
import Amount from '@/components/Amount.vue';
import StatusMarks from '@/components/StatusMarks.vue';
import { useColumnWidths } from '@/composables/useColumnWidths.ts';
import { columnSpec, layoutColumns, type ColumnId, type ColumnWidths } from '@/lib/columns.ts';
import { formatShortDate } from '@/lib/format.ts';
import type { TransactionRow } from '../../shared/contracts.ts';

const props = defineProps<{
  rows: TransactionRow[];
  selectedId: string | null;
  loading: boolean;
  link: (row: TransactionRow) => RouteLocationRaw;
}>();

const scroller = useTemplateRef<HTMLElement>('scroller');
const { width: available } = useElementSize(scroller);
const { widths: userWidths, preview, restore, commit, resetColumn } = useColumnWidths();

const visible = computed<ColumnId[]>(() => {
  const w = available.value;
  if (w && w < 700) return ['date', 'description', 'account', 'amount'];
  if (w && w < 900) return ['date', 'description', 'account', 'status', 'amount'];
  return ['date', 'description', 'account', 'category', 'status', 'amount'];
});
const inline = computed(() => ({
  category: !visible.value.includes('category'),
  status: !visible.value.includes('status'),
}));
const layout = computed(() => layoutColumns(available.value || 1000, userWidths.value, visible.value));

const resizing = ref<{
  id: ColumnId;
  startX: number;
  startWidth: number;
  snapshot: ColumnWidths;
  pointerId: number;
} | null>(null);

function startDrag(id: ColumnId, e: PointerEvent) {
  if (e.button !== 0 || resizing.value) return;
  e.preventDefault();
  e.stopPropagation();
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  resizing.value = {
    id,
    startX: e.clientX,
    startWidth: layout.value.widths[id],
    snapshot: { ...userWidths.value },
    pointerId: e.pointerId,
  };
  document.documentElement.classList.add('select-none', 'cursor-col-resize');
  window.addEventListener('keydown', cancelOnEscape, { capture: true });
}

function cancelOnEscape(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  endDrag(true);
}

function moveDrag(e: PointerEvent) {
  const r = resizing.value;
  if (!r || e.pointerId !== r.pointerId) return;
  preview(r.id, r.startWidth + e.clientX - r.startX);
}

function endDrag(cancel: boolean) {
  const r = resizing.value;
  if (!r) return;
  if (cancel) restore(r.snapshot);
  else commit();
  resizing.value = null;
  document.documentElement.classList.remove('select-none', 'cursor-col-resize');
  window.removeEventListener('keydown', cancelOnEscape, { capture: true });
}

function onHandleKey(id: ColumnId, e: KeyboardEvent) {
  if (e.key === 'Escape' && resizing.value) return endDrag(true);
  const step = e.shiftKey ? 48 : 16;
  const delta = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
  if (!delta && e.key !== 'Home' && e.key !== 'End') return;
  e.preventDefault();
  if (e.key === 'Home') preview(id, columnSpec[id].min);
  else if (e.key === 'End') preview(id, columnSpec[id].max);
  else preview(id, layout.value.widths[id] + delta);
  commit();
}

onBeforeUnmount(() => endDrag(true));

const align = (id: ColumnId) => (id === 'amount' ? 'text-right' : 'text-left');
const title = (row: TransactionRow) => row.merchantName ?? row.name;
</script>

<template>
  <div
    ref="scroller"
    class="overflow-x-auto overscroll-x-contain"
    :class="loading && 'opacity-60'"
    role="region"
    aria-label="Transactions"
    :tabindex="available && layout.total > available ? 0 : undefined"
  >
    <table
      class="table-fixed border-separate border-spacing-0 text-[13px]"
      :style="{ width: `${layout.total}px` }"
    >
      <colgroup>
        <col v-for="id in visible" :key="id" :style="{ width: `${layout.widths[id]}px` }" />
      </colgroup>
      <thead>
        <tr>
          <th
            v-for="(id, i) in visible"
            :key="id"
            scope="col"
            class="label-caps relative h-8 border-b border-border bg-secondary/40 px-3 first:pl-6 last:pr-6"
            :class="align(id)"
          >
            <span class="block truncate">{{ columnSpec[id].label }}</span>
            <span
              v-if="i < visible.length - 1"
              role="separator"
              aria-orientation="vertical"
              tabindex="0"
              :aria-label="`Resize ${columnSpec[id].label} column`"
              :aria-valuenow="layout.widths[id]"
              :aria-valuemin="columnSpec[id].min"
              :aria-valuemax="columnSpec[id].max"
              class="group/resize absolute inset-y-0 -right-1.5 z-10 flex w-3 cursor-col-resize touch-none justify-center outline-none"
              @pointerdown="startDrag(id, $event)"
              @pointermove="moveDrag"
              @pointerup="endDrag(false)"
              @pointercancel="endDrag(true)"
              @lostpointercapture="endDrag(false)"
              @keydown="onHandleKey(id, $event)"
              @click.stop.prevent
              @dblclick.stop.prevent="resetColumn(id)"
            >
              <span
                class="my-1.5 w-px bg-border transition-colors group-hover/resize:w-0.5 group-hover/resize:bg-ring group-focus-visible/resize:w-0.5 group-focus-visible/resize:bg-ring"
                :class="resizing?.id === id && 'w-0.5 bg-ring'"
              />
            </span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.id"
          class="group relative"
          :class="[
            row.id === selectedId ? 'bg-accent' : 'hover:bg-secondary/60',
            row.status === 'removed' && 'text-muted-foreground',
          ]"
        >
          <template v-for="id in visible" :key="id">
            <td
              v-if="id === 'date'"
              class="num border-b border-border/50 py-2.5 pr-3 pl-6 text-[12.5px] whitespace-nowrap text-muted-foreground"
              :class="row.id === selectedId && 'shadow-[inset_2px_0_0_var(--primary)]'"
            >
              {{ formatShortDate(row.date) }}
            </td>
            <td v-else-if="id === 'description'" class="border-b border-border/50 px-3 py-2">
              <div class="flex min-w-0 items-center gap-2">
                <RouterLink
                  :to="link(row)"
                  :data-row-link="row.id"
                  class="min-w-0 truncate font-medium text-foreground outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                  :class="
                    row.status === 'removed' &&
                    'text-muted-foreground line-through decoration-muted-foreground/60'
                  "
                  :title="title(row)"
                  >{{ title(row) }}</RouterLink
                >
                <StatusMarks v-if="inline.status" :row="row" class="shrink-0" />
              </div>
              <div
                v-if="row.annotation.note || row.annotation.tags.length || inline.category"
                class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground"
              >
                <span v-if="inline.category" class="shrink-0">{{
                  row.annotation.category ?? 'Uncategorized'
                }}</span>
                <span v-for="tag in row.annotation.tags" :key="tag" class="shrink-0 rounded bg-secondary px-1"
                  >#{{ tag }}</span
                >
                <span class="min-w-0 truncate">{{ row.annotation.note }}</span>
              </div>
            </td>
            <td
              v-else-if="id === 'account'"
              class="border-b border-border/50 px-3 py-2.5 text-muted-foreground"
            >
              <AccountLabel :name="row.accountName" :mask="row.accountMask" class="max-w-full" />
            </td>
            <td
              v-else-if="id === 'category'"
              class="truncate border-b border-border/50 px-3 py-2"
              :class="row.annotation.category ? 'text-foreground' : 'text-[12px] text-muted-foreground'"
            >
              {{ row.annotation.category ?? 'Uncategorized' }}
            </td>
            <td v-else-if="id === 'status'" class="border-b border-border/50 px-3 py-2">
              <StatusMarks :row="row" />
            </td>
            <td
              v-else
              class="border-b border-border/50 py-2.5 pr-6 pl-3 text-right text-[13.5px] font-medium"
            >
              <Amount :minor="row.amountMinor" :currency="row.currency" :removed="row.status === 'removed'" />
            </td>
          </template>
        </tr>
      </tbody>
    </table>
  </div>
</template>
