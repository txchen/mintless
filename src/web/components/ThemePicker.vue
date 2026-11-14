<script setup lang="ts">
import { computed } from 'vue';
import { SYSTEM_DARK_THEME, themes, useTheme, type ThemePreference } from '@/lib/theme.ts';

const { preference, resolvedTheme, storageAvailable, setPreference } = useTheme();
const light = themes.find((t) => t.id === 'light')!;
const systemDark = themes.find((t) => t.id === SYSTEM_DARK_THEME)!;
const options = computed(() => [
  {
    id: 'system' as ThemePreference,
    label: 'System',
    hint: `Light or ${systemDark.label}`,
    swatches: [light.swatch, systemDark.swatch],
  },
  ...themes.map((t) => ({
    id: t.id as ThemePreference,
    label: t.label,
    hint: t.mode === 'dark' ? 'Dark' : 'Light',
    swatches: [t.swatch],
  })),
]);
</script>

<template>
  <section aria-labelledby="appearance">
    <h2 id="appearance" class="mb-1 border-b pb-1.5 text-[14px] font-semibold tracking-[-0.01em]">
      Appearance
    </h2>
    <p class="text-[13px] text-muted-foreground">
      Saved in this browser only.
      <template v-if="preference === 'system'"
        >Following your device: {{ themes.find((t) => t.id === resolvedTheme)!.label }}.</template
      >
    </p>
    <p v-if="!storageAvailable" role="status" class="mt-1 text-[12px] text-warning-foreground">
      This browser blocks local storage, so the choice lasts until you reload.
    </p>
    <fieldset class="mt-2 min-w-0">
      <legend class="sr-only">Theme</legend>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label
          v-for="option in options"
          :key="option.id"
          class="flex min-h-14 cursor-pointer items-center gap-2.5 rounded-md border bg-card px-2.5 py-2 has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
        >
          <input
            type="radio"
            name="theme"
            class="sr-only"
            :value="option.id"
            :checked="preference === option.id"
            @change="setPreference(option.id)"
          />
          <span class="flex shrink-0 overflow-hidden rounded border border-border" aria-hidden="true">
            <span
              v-for="(swatch, i) in option.swatches"
              :key="i"
              class="flex h-9 flex-col justify-center gap-1 px-1.5"
              :class="option.swatches.length > 1 ? 'w-5 px-1' : 'w-9'"
              :style="{ background: swatch[0] }"
            >
              <span class="h-1 rounded-full" :style="{ background: swatch[1] }" />
              <span class="h-1 w-2/3 rounded-full" :style="{ background: swatch[2] }" />
              <span class="h-1 w-1/2 rounded-full" :style="{ background: swatch[3] }" />
            </span>
          </span>
          <span class="min-w-0 leading-tight">
            <span class="block text-[13px] font-medium [word-break:keep-all]">{{ option.label }}</span>
            <span class="block text-[11px] text-muted-foreground">{{ option.hint }}</span>
          </span>
        </label>
      </div>
    </fieldset>
  </section>
</template>
