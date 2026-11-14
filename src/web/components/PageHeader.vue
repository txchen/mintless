<script setup lang="ts">
defineProps<{ title: string; context?: string }>();
</script>

<template>
  <header class="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
    <div class="flex min-h-13 items-center gap-2 px-3 py-2 md:px-6">
      <h1 class="mr-auto flex min-w-0 items-baseline gap-2.5 text-[17px] font-semibold tracking-[-0.015em]">
        <span class="shrink-0">{{ title }}</span>
        <span v-if="context" class="truncate text-[13px] font-normal tracking-normal text-muted-foreground">{{
          context
        }}</span>
      </h1>
      <slot />
    </div>
  </header>
</template>
