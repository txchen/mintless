<script setup lang="ts">
import { Button } from '@/components/ui/button';
import { useAccounts } from '@/composables/useAccounts.ts';

defineProps<{ failed: boolean }>();
const { refresh } = useAccounts();
</script>

<template>
  <section class="px-3 py-8 md:px-7" aria-live="polite">
    <template v-if="failed">
      <p class="text-[13px] text-destructive" role="alert">
        Your accounts could not be loaded, so this scope is unknown.
      </p>
      <Button size="sm" variant="outline" class="mt-3" @click="refresh()">Try again</Button>
    </template>
    <p v-else class="text-[13px] text-muted-foreground" role="status">Loading scope…</p>
  </section>
</template>
