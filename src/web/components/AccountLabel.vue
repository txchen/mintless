<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ name: string; mask: string | null }>();
const full = computed(() => (props.mask ? `${props.name} ending ${props.mask}` : props.name));
</script>

<template>
  <span class="inline-flex min-w-0 items-baseline" :title="full">
    <span class="min-w-0 truncate">{{ name }}</span>
    <span v-if="mask" class="num shrink-0 whitespace-pre" aria-hidden="true"> ··{{ mask }}</span>
    <span v-if="mask" class="sr-only">, ending {{ mask }}</span>
  </span>
</template>
