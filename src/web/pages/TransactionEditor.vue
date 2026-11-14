<script setup lang="ts">
import { AlertTriangle, ArrowLeft, Check, History, X } from '@lucide/vue';
import { onKeyStroke } from '@vueuse/core';
import { computed, inject, nextTick, onMounted, ref, useTemplateRef } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import Amount from '@/components/Amount.vue';
import StatusMarks from '@/components/StatusMarks.vue';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useAccounts } from '@/composables/useAccounts.ts';
import { onRevalidate } from '@/composables/useRevalidate.ts';
import { transactionListKey } from '@/composables/useTransactions.ts';
import { ApiError, api, errorMessage } from '@/lib/api.ts';
import { displayAmount, formatDay, formatStamp } from '@/lib/format.ts';
import type {
  AnnotationConflict,
  AnnotationPatch,
  TransactionDetail,
  TransactionRow,
} from '../../shared/contracts.ts';

const props = defineProps<{ id: string }>();
const route = useRoute();
const router = useRouter();
// Scope the request to the active tree scope so a deep link cannot open or edit
// a transaction outside it; the server answers 404 and lostAccess takes over.
const scopeQs = () => {
  const params = new URLSearchParams();
  for (const k of ['group', 'account'] as const)
    if (typeof route.query[k] === 'string' && route.query[k]) params.set(k, route.query[k] as string);
  const s = params.toString();
  return s ? `?${s}` : '';
};
const list = inject(transactionListKey);
const { categories, refresh: refreshAccounts } = useAccounts();

type Kind = '' | 'refund' | 'transfer';
type Draft = {
  category: string;
  kind: Kind;
  tags: string[];
  owner: string;
  note: string;
  isReconciled: boolean;
};

const detail = ref<TransactionDetail | null>(null);
const loadError = ref('');
const saving = ref(false);
const draft = ref<Draft>({ category: '', kind: '', tags: [], owner: '', note: '', isReconciled: false });
const tagInput = ref('');
const conflict = ref<TransactionRow | null>(null);
const heading = useTemplateRef<HTMLElement>('heading');

const toDraft = (row: TransactionRow): Draft => ({
  category: row.annotation.category ?? '',
  kind: row.annotation.kind ?? '',
  tags: [...row.annotation.tags],
  owner: row.annotation.owner ?? '',
  note: row.annotation.note,
  isReconciled: row.annotation.isReconciled,
});

const baseline = computed(() => (detail.value ? toDraft(detail.value) : null));
const dirty = computed(
  () => baseline.value !== null && JSON.stringify(baseline.value) !== JSON.stringify(normalized(draft.value)),
);

function normalized(d: Draft): Draft {
  return {
    category: d.category.trim(),
    kind: d.kind,
    tags: d.tags,
    owner: d.owner.trim(),
    note: d.note,
    isReconciled: d.isReconciled,
  };
}

async function load() {
  loadError.value = '';
  const draftAtStart = JSON.stringify(normalized(draft.value));
  try {
    const fresh = await api<TransactionDetail>(`/transactions/${props.id}${scopeQs()}`);
    const keepDraft = dirty.value || JSON.stringify(normalized(draft.value)) !== draftAtStart;
    const current = detail.value;
    const moved =
      current !== null &&
      (fresh.amountMinor !== current.amountMinor ||
        fresh.date !== current.date ||
        fresh.accountId !== current.accountId);
    if (keepDraft && moved && draft.value.isReconciled && !current.annotation.isReconciled) {
      conflict.value = fresh;
      return;
    }
    detail.value = fresh;
    if (!keepDraft) draft.value = toDraft(fresh);
  } catch (e) {
    loadError.value = errorMessage(e);
    if (e instanceof ApiError && e.status === 404) lostAccess();
  }
}

function lostAccess() {
  list?.remove(props.id);
  void list?.lostAccess();
}

onRevalidate(() => !saving.value && load());
onMounted(async () => {
  await load();
  await nextTick();
  heading.value?.focus({ preventScroll: true });
});

function patchFrom(d: Draft, revision: number, extra: Partial<AnnotationPatch> = {}): AnnotationPatch {
  const n = normalized(d);
  return {
    revision,
    category: n.category || null,
    kind: n.kind || null,
    tags: n.tags,
    owner: n.owner || null,
    note: n.note,
    isReconciled: n.isReconciled,
    ...(detail.value
      ? {
          seen: {
            amountMinor: detail.value.amountMinor,
            date: detail.value.date,
            accountId: detail.value.accountId,
          },
        }
      : {}),
    ...extra,
  };
}

function applyRow(row: TransactionRow) {
  if (!detail.value) return;
  detail.value = { ...detail.value, ...row };
  list?.upsert(row);
}

async function send(patch: AnnotationPatch, message = 'Saved') {
  saving.value = true;
  const sent = JSON.stringify(normalized(draft.value));
  try {
    const row = await api<TransactionRow>(`/transactions/${props.id}/annotation${scopeQs()}`, {
      method: 'PATCH',
      body: patch,
    });
    const typedSinceSend = JSON.stringify(normalized(draft.value)) !== sent;
    applyRow(row);
    if (!typedSinceSend) draft.value = toDraft(row);
    void refreshAccounts();
    toast.success(message);
    void load();
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      conflict.value = (e.body as AnnotationConflict).current;
      return false;
    }
    if (e instanceof ApiError && e.status === 404) {
      lostAccess();
      loadError.value = errorMessage(e);
    }
    toast.error(errorMessage(e));
    return false;
  } finally {
    saving.value = false;
  }
}

const save = () => detail.value && send(patchFrom(draft.value, detail.value.annotation.revision));

async function acknowledge() {
  if (!detail.value) return;
  await send(
    patchFrom(baseline.value!, detail.value.annotation.revision, { acknowledgeReview: true }),
    'Review cleared',
  );
}

const valuesChanged = computed(() => {
  const c = conflict.value;
  const d = detail.value;
  return Boolean(
    c && d && (c.amountMinor !== d.amountMinor || c.date !== d.date || c.accountId !== d.accountId),
  );
});

function keepTheirs() {
  if (!conflict.value) return;
  applyRow(conflict.value);
  draft.value = toDraft(conflict.value);
  conflict.value = null;
  void load();
}

async function overwriteWithMine() {
  if (!conflict.value) return;
  const revision = conflict.value.annotation.revision;
  applyRow(conflict.value);
  conflict.value = null;
  await send(patchFrom(draft.value, revision), 'Saved over the other change');
}

function addTag() {
  const tag = tagInput.value.trim().replace(/^#/, '');
  if (tag && !draft.value.tags.includes(tag) && draft.value.tags.length < 20) draft.value.tags.push(tag);
  tagInput.value = '';
}

const close = () => router.push({ path: '/transactions', query: route.query });

onBeforeRouteLeave(() => {
  if (dirty.value && !saving.value && !window.confirm('Discard unsaved changes?')) return false;
});
onKeyStroke('Escape', (e) => {
  if (conflict.value || (e.target as HTMLElement | null)?.closest('[role="dialog"]')) return;
  void close();
});
onKeyStroke('Enter', (e) => {
  if ((e.metaKey || e.ctrlKey) && dirty.value) {
    e.preventDefault();
    void save();
  }
});

const kindOptions: { value: Kind; label: string }[] = [
  { value: '', label: 'Normal' },
  { value: 'refund', label: 'Refund' },
  { value: 'transfer', label: 'Transfer or payment' },
];
const refundUnavailable = computed(
  () => (detail.value?.amountMinor ?? 0) > 0 && detail.value?.annotation.kind !== 'refund',
);
const kindHelp: Record<Kind, string> = {
  '': 'Outflows count as spending. Inflows count as money in.',
  refund: 'Reduces spending in its category instead of counting as money in.',
  transfer: 'Moves money between your own accounts, such as a card payment. Left out of charts.',
};

const suggestions = computed(() => {
  const base = [
    'Groceries',
    'Dining',
    'Transportation',
    'Shopping',
    'Utilities',
    'Rent',
    'Health',
    'Home',
    'Income',
    'Transfer',
    'Credit card payment',
    'Refund',
  ];
  return [...new Set([...categories.value, ...base])];
});
const other = computed(() => {
  const d = detail.value;
  if (!d?.annotation.updatedBy || !d.annotation.updatedAt) return null;
  return `Last edited by ${d.annotation.updatedBy}, ${formatStamp(d.annotation.updatedAt)}`;
});
const eventLabel: Record<string, string> = {
  added: 'Received from bank',
  modified: 'Bank changed details',
  removed: 'Removed by bank',
  superseded: 'Pending replaced by posted record',
};
function changeSummary(detailObj: Record<string, unknown>) {
  const changes = detailObj.changes as Record<string, [unknown, unknown]> | undefined;
  if (!changes) return '';
  return Object.entries(changes)
    .map(([k, [a, b]]) =>
      k === 'amountMinor' && detail.value
        ? `amount ${displayAmount(Number(a), detail.value.currency).text} → ${displayAmount(Number(b), detail.value.currency).text}`
        : `${k}: ${String(a)} → ${String(b)}`,
    )
    .join('; ');
}
</script>

<template>
  <div class="flex h-dvh flex-col lg:h-full">
    <header class="flex h-12 shrink-0 items-center gap-1 border-b px-2">
      <Button variant="ghost" size="icon" class="lg:hidden" aria-label="Back to transactions" @click="close"
        ><ArrowLeft
      /></Button>
      <span class="label-caps ml-1 lg:ml-2">Transaction</span>
      <Button
        variant="ghost"
        size="icon-sm"
        class="ml-auto hidden lg:inline-flex"
        aria-label="Close details"
        @click="close"
        ><X
      /></Button>
    </header>

    <div v-if="loadError" class="p-5 text-[13px]" role="alert">
      <p>{{ loadError }}</p>
      <Button variant="outline" size="sm" class="mt-3" @click="close">Back to list</Button>
    </div>
    <div v-else-if="!detail" class="p-5 text-[13px] text-muted-foreground" aria-busy="true">Loading…</div>

    <template v-else>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <section class="border-b px-4 py-4">
          <h2
            ref="heading"
            tabindex="-1"
            class="text-[17px] leading-snug font-semibold break-words outline-none"
          >
            {{ detail.merchantName ?? detail.name }}
          </h2>
          <div class="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Amount
              :minor="detail.amountMinor"
              :currency="detail.currency"
              :removed="detail.status === 'removed'"
              class="text-[22px] font-semibold"
            />
            <StatusMarks :row="detail" />
          </div>
          <div class="@container mt-2">
            <dl
              class="grid grid-cols-1 gap-y-1 text-[13px] leading-5 @[19rem]:grid-cols-[max-content_minmax(0,1fr)] @[19rem]:gap-x-4"
            >
              <dt class="text-muted-foreground">Date</dt>
              <dd class="mb-1 @[19rem]:mb-0">{{ formatDay(detail.date) }}</dd>
              <dt class="text-muted-foreground">Account</dt>
              <dd class="mb-1 min-w-0 [overflow-wrap:anywhere] @[19rem]:mb-0">
                {{ detail.accountName
                }}<span v-if="detail.accountMask" class="num whitespace-nowrap text-muted-foreground">
                  ··{{ detail.accountMask }}</span
                >
              </dd>
              <dt class="text-muted-foreground">Bank text</dt>
              <dd class="mb-1 min-w-0 text-muted-foreground [overflow-wrap:anywhere] @[19rem]:mb-0">
                {{ detail.name }}
              </dd>
              <template v-if="detail.providerCategory">
                <dt class="text-muted-foreground">Bank category</dt>
                <dd class="min-w-0 [overflow-wrap:anywhere]">{{ detail.providerCategory }}</dd>
              </template>
            </dl>
          </div>
        </section>

        <section
          v-if="detail.annotation.needsReconciliationReview || detail.lifecycleReview"
          class="mx-4 mt-4 rounded-md bg-warning-surface px-3 py-2.5 text-[13px]"
          role="status"
        >
          <p class="flex gap-2 font-medium">
            <AlertTriangle class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <span v-if="detail.annotation.needsReconciliationReview"
              >The bank changed the amount, date, or account after this was reconciled.</span
            >
            <span v-else-if="detail.lifecycleReview === 'unmatched_successor'"
              >The bank says this replaces a pending transaction Mintless never received. Check that it is not
              a duplicate.</span
            >
            <span v-else
              >The bank removed this transaction. Your notes are kept, and it no longer counts toward
              totals.</span
            >
          </p>
          <p class="mt-1 pl-6 text-muted-foreground">Check the history below, then confirm.</p>
          <Button
            size="sm"
            variant="outline"
            class="mt-2 ml-6 bg-card"
            :disabled="saving || dirty"
            @click="acknowledge"
          >
            <Check aria-hidden="true" />{{
              detail.annotation.needsReconciliationReview ? 'Confirm current values' : 'Acknowledge'
            }}
          </Button>
          <p v-if="dirty" class="mt-1 pl-6 text-[12px] text-muted-foreground">
            Save or discard your edits first.
          </p>
        </section>

        <form id="annotation-form" class="grid gap-4 px-4 py-4" @submit.prevent="save">
          <label class="grid gap-1.5">
            <span class="text-[12px] font-medium text-muted-foreground">Category</span>
            <Input
              v-model="draft.category"
              list="category-suggestions"
              placeholder="Uncategorized"
              class="h-10 text-[15px] md:h-9 md:text-[14px]"
              maxlength="60"
            />
            <datalist id="category-suggestions">
              <option v-for="c in suggestions" :key="c" :value="c" />
            </datalist>
          </label>
          <div class="grid gap-1.5">
            <label for="tag-input" class="text-[12px] font-medium text-muted-foreground">Tags</label>
            <div
              class="flex min-h-10 flex-wrap items-center gap-1 rounded-md border border-input bg-card px-1.5 py-1 focus-within:ring-3 focus-within:ring-ring/40 md:min-h-9"
            >
              <span
                v-for="tag in draft.tags"
                :key="tag"
                class="inline-flex items-center gap-0.5 rounded bg-secondary py-0.5 pr-0.5 pl-1.5 text-[13px]"
              >
                #{{ tag }}
                <button
                  type="button"
                  class="grid size-6 place-items-center rounded text-muted-foreground hover:bg-background md:size-5"
                  :aria-label="`Remove tag ${tag}`"
                  @click="draft.tags = draft.tags.filter((t) => t !== tag)"
                >
                  <X class="size-3" />
                </button>
              </span>
              <input
                id="tag-input"
                v-model="tagInput"
                class="h-8 min-w-24 flex-1 bg-transparent px-1 text-[15px] outline-none md:h-7 md:text-[14px]"
                placeholder="Add tag"
                enterkeyhint="done"
                maxlength="40"
                @keydown.enter.prevent="addTag"
                @keydown.,.prevent="addTag"
                @blur="addTag"
              />
            </div>
          </div>
          <fieldset class="grid min-w-0 gap-1.5">
            <legend class="mb-1.5 text-[12px] font-medium text-muted-foreground">Counts as</legend>
            <div class="grid grid-cols-3 gap-1 rounded-md bg-secondary p-1">
              <label
                v-for="option in kindOptions"
                :key="option.value"
                class="flex min-h-9 cursor-pointer has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 items-center justify-center rounded px-1.5 text-center text-[13px] leading-tight has-[:checked]:bg-card has-[:checked]:font-medium has-[:checked]:shadow-xs has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
              >
                <input
                  v-model="draft.kind"
                  type="radio"
                  name="kind"
                  :value="option.value"
                  :disabled="option.value === 'refund' && refundUnavailable"
                  class="sr-only"
                />
                {{ option.label }}
              </label>
            </div>
            <p class="text-[12px] text-muted-foreground">
              {{ refundUnavailable ? 'Refund applies to money coming back. ' : '' }}{{ kindHelp[draft.kind] }}
            </p>
          </fieldset>
          <label class="grid gap-1.5">
            <span class="text-[12px] font-medium text-muted-foreground">Owner</span>
            <Input
              v-model="draft.owner"
              placeholder="Who is this for?"
              class="h-10 text-[15px] md:h-9 md:text-[14px]"
              maxlength="60"
            />
          </label>
          <label class="grid gap-1.5">
            <span class="text-[12px] font-medium text-muted-foreground">Note</span>
            <Textarea
              v-model="draft.note"
              rows="4"
              maxlength="4000"
              placeholder="Add context for the household"
              class="min-h-24 text-[15px] md:text-[14px]"
            />
          </label>
          <label class="flex min-h-10 items-center gap-2.5 rounded-md border px-3 py-2">
            <Checkbox v-model="draft.isReconciled" />
            <span class="text-[14px]">Reconciled</span>
            <span
              v-if="detail.annotation.isReconciled && detail.annotation.reconciledAt"
              class="ml-auto truncate text-[12px] text-muted-foreground"
            >
              by {{ detail.annotation.reconciledBy ?? 'unknown' }},
              {{ formatStamp(detail.annotation.reconciledAt) }}
            </span>
          </label>
          <p v-if="other" class="text-[12px] text-muted-foreground">{{ other }}</p>
        </form>

        <details class="group border-t px-4 py-3 text-[13px]">
          <summary class="flex cursor-pointer list-none items-center gap-2 py-1 font-medium">
            <History class="size-4 text-muted-foreground" aria-hidden="true" /> History
            <span class="text-muted-foreground">({{ detail.events.length + detail.history.length }})</span>
          </summary>
          <h3 class="mt-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Bank records
          </h3>
          <ul class="mt-1 divide-y rounded-md border">
            <li v-for="s in detail.sources" :key="s.id" class="flex items-center gap-2 px-2.5 py-1.5">
              <div class="min-w-0 flex-1">
                <div class="truncate">{{ s.name }}</div>
                <div class="text-[12px] text-muted-foreground">
                  {{ s.pending ? 'Pending' : 'Posted' }} · {{ formatDay(s.date) }} · {{ s.providerRef
                  }}<template v-if="s.removedAt"> · removed</template
                  ><template v-if="s.preferred"> · shown</template>
                </div>
              </div>
              <Amount :minor="s.amountMinor" :currency="s.currency" :removed="s.removedAt !== null" />
            </li>
          </ul>
          <h3 class="mt-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Changes</h3>
          <ol class="mt-1 space-y-1.5">
            <li v-for="h in detail.history" :key="`a${h.revision}`" class="leading-snug">
              <span class="text-muted-foreground">{{ formatStamp(h.at) }}</span> ·
              {{ h.cause === 'sync' ? 'Sync' : (h.actor ?? 'unknown') }}: {{ h.summary }}
            </li>
            <li v-for="(e, i) in [...detail.events].reverse()" :key="`e${i}`" class="leading-snug">
              <span class="text-muted-foreground">{{ formatStamp(e.at) }}</span> · {{ eventLabel[e.kind]
              }}<template v-if="changeSummary(e.detail)">: {{ changeSummary(e.detail) }}</template>
            </li>
          </ol>
        </details>
      </div>

      <footer
        class="flex shrink-0 items-center gap-2 border-t bg-background px-4 py-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] lg:pb-2.5"
      >
        <span v-if="dirty" class="text-[12px] text-muted-foreground">Unsaved changes</span>
        <Button
          type="button"
          variant="ghost"
          class="ml-auto h-10 md:h-9"
          :disabled="!dirty || saving"
          @click="draft = toDraft(detail)"
          >Discard</Button
        >
        <Button
          type="submit"
          form="annotation-form"
          class="h-10 min-w-20 md:h-9"
          :disabled="!dirty || saving"
          >{{ saving ? 'Saving…' : 'Save' }}</Button
        >
      </footer>
    </template>

    <Dialog :open="conflict !== null" @update:open="(open) => !open && keepTheirs()">
      <DialogContent class="sm:max-w-md">
        <DialogHeader class="text-left">
          <DialogTitle>{{
            valuesChanged ? 'The bank changed this transaction' : 'Someone else changed this transaction'
          }}</DialogTitle>
          <DialogDescription v-if="valuesChanged && conflict">
            It now shows {{ displayAmount(conflict.amountMinor, conflict.currency).text }} on
            {{ formatDay(conflict.date) }} in {{ conflict.accountName }}. Check the new values before you
            reconcile.
          </DialogDescription>
          <DialogDescription v-else>
            {{
              conflict?.annotation.updatedBy ? `${conflict.annotation.updatedBy} saved` : 'A sync changed it'
            }}
            {{ conflict?.annotation.updatedAt ? formatStamp(conflict.annotation.updatedAt) : '' }} while you
            were editing.
          </DialogDescription>
        </DialogHeader>
        <div v-if="conflict" class="grid grid-cols-2 gap-3 text-[13px]">
          <div class="rounded-md border p-2.5">
            <div class="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Their version
            </div>
            <div>
              {{ conflict.annotation.category ?? 'Uncategorized'
              }}{{ conflict.annotation.kind ? ` · ${conflict.annotation.kind}` : '' }}
            </div>
            <div class="text-muted-foreground">
              {{ conflict.annotation.tags.map((t) => `#${t}`).join(' ') }}
            </div>
            <div v-if="conflict.annotation.owner">Owner: {{ conflict.annotation.owner }}</div>
            <div class="break-words whitespace-pre-wrap">{{ conflict.annotation.note || 'No note' }}</div>
            <div class="text-muted-foreground">
              {{ conflict.annotation.isReconciled ? 'Reconciled' : 'Not reconciled' }}
            </div>
          </div>
          <div class="rounded-md border border-primary/40 p-2.5">
            <div class="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Your version
            </div>
            <div>{{ draft.category || 'Uncategorized' }}{{ draft.kind ? ` · ${draft.kind}` : '' }}</div>
            <div class="text-muted-foreground">{{ draft.tags.map((t) => `#${t}`).join(' ') }}</div>
            <div v-if="draft.owner">Owner: {{ draft.owner }}</div>
            <div class="break-words whitespace-pre-wrap">{{ draft.note || 'No note' }}</div>
            <div class="text-muted-foreground">
              {{ draft.isReconciled ? 'Reconciled' : 'Not reconciled' }}
            </div>
          </div>
        </div>
        <DialogFooter class="gap-2">
          <Button variant="outline" @click="keepTheirs">Keep theirs</Button>
          <Button @click="overwriteWithMine">Save mine instead</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
