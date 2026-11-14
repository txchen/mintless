<script setup lang="ts">
import { AlertTriangle, CheckCircle2 } from '@lucide/vue';
import type { TransactionRow } from '../../shared/contracts.ts';

defineProps<{ row: TransactionRow }>();
</script>

<template>
  <span class="inline-flex items-center gap-1">
    <span
      v-if="row.annotation.kind"
      class="rounded bg-secondary px-1 text-[11px] leading-4 text-muted-foreground"
      >{{ row.annotation.kind === 'refund' ? 'Refund' : 'Transfer' }}</span
    >
    <span
      v-if="row.status === 'pending'"
      class="rounded border border-dashed border-muted-foreground/50 px-1 text-[11px] leading-4 text-muted-foreground"
      >Pending</span
    >
    <span
      v-else-if="row.status === 'removed'"
      class="rounded bg-muted px-1 text-[11px] leading-4 text-muted-foreground"
      >Removed</span
    >
    <span
      v-if="row.annotation.needsReconciliationReview || row.lifecycleReview"
      class="inline-flex items-center gap-0.5 rounded bg-warning-surface px-1 text-[11px] leading-4 text-warning-foreground"
    >
      <AlertTriangle class="size-3" aria-hidden="true" />Review
    </span>
    <span v-if="row.annotation.isReconciled" class="inline-flex items-center text-primary" title="Reconciled">
      <CheckCircle2 class="size-3.5" aria-hidden="true" /><span class="sr-only">Reconciled</span>
    </span>
  </span>
</template>
