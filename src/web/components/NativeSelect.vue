<script setup lang="ts">
import { ChevronDown } from '@lucide/vue';
import { computed } from 'vue';
import { cn } from '@/lib/utils';

const props = defineProps<{
  label: string;
  options: { value: string; label: string }[];
  class?: string;
  variant?: 'box' | 'chip';
  defaultValue?: string;
}>();
const model = defineModel<string>({ required: true });
const selected = computed(() => props.options.find((o) => o.value === model.value)?.label ?? '');
const filtering = computed(
  () => props.options.length > 0 && model.value !== (props.defaultValue ?? props.options[0]!.value),
);
</script>

<template>
  <div
    v-if="variant === 'chip'"
    :class="
      cn(
        'relative inline-flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] whitespace-nowrap focus-within:ring-2 focus-within:ring-ring',
        filtering ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-secondary',
        props.class,
      )
    "
  >
    <span :class="filtering ? 'opacity-80' : 'text-muted-foreground'">{{ label }}</span>
    <span class="min-w-0 truncate font-medium">{{ selected }}</span>
    <ChevronDown class="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
    <select
      v-model="model"
      :aria-label="label"
      class="absolute inset-0 w-full cursor-pointer appearance-none opacity-0"
    >
      <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
  </div>
  <div v-else :class="cn('relative', props.class)">
    <select
      v-model="model"
      :aria-label="label"
      class="h-8 w-full appearance-none rounded-md border border-input bg-card pr-7 pl-2.5 text-[13px] outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
    >
      <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
    <ChevronDown
      class="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground"
      aria-hidden="true"
    />
  </div>
</template>
