<script setup lang="ts">
import { computed } from 'vue';
import NativeSelect from '@/components/NativeSelect.vue';
import type { GroupSummary } from '../../shared/contracts.ts';

const props = defineProps<{ groups: GroupSummary[]; class?: string; variant?: 'box' | 'chip' }>();
const model = defineModel<string>({ required: true });
const options = computed(() => [
  { value: '', label: 'All' },
  ...(props.groups.length > 1 ? props.groups.map((g) => ({ value: g.id, label: g.name })) : []),
]);
</script>

<template>
  <NativeSelect
    v-if="groups.length > 1"
    v-model="model"
    label="Group"
    :options="options"
    :class="props.class"
    :variant="props.variant"
  />
</template>
