<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppShell from './components/AppShell.vue';
import { Toaster } from './components/ui/sonner';
import { useTheme } from './lib/theme.ts';
import 'vue-sonner/style.css';

const route = useRoute();
const bare = computed(() => route.meta.public === true);
const { mode } = useTheme();
</script>

<template>
  <RouterView v-if="bare" />
  <AppShell v-else>
    <RouterView />
  </AppShell>
  <Toaster :theme="mode" position="top-center" :duration="2500" />
</template>
