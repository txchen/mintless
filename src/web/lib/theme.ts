import { computed, ref } from 'vue';

export type ThemeId = 'light' | 'one-dark' | 'nord' | 'macchiato';
export type ThemePreference = 'system' | ThemeId;

export const THEME_STORAGE_KEY = 'mintless.theme';
export const SYSTEM_DARK_THEME: ThemeId = 'one-dark';

export const themes: {
  id: ThemeId;
  label: string;
  mode: 'light' | 'dark';
  swatch: [string, string, string, string];
}[] = [
  { id: 'light', label: 'Light', mode: 'light', swatch: ['#fbfaf8', '#2f3440', '#2f6f63', '#2f7a4f'] },
  { id: 'one-dark', label: 'One Dark', mode: 'dark', swatch: ['#282c34', '#b9c0cb', '#61afef', '#98c379'] },
  { id: 'nord', label: 'Nord', mode: 'dark', swatch: ['#2e3440', '#d8dee9', '#88c0d0', '#a3be8c'] },
  {
    id: 'macchiato',
    label: 'Catppuccin Macchiato',
    mode: 'dark',
    swatch: ['#24273a', '#cad3f5', '#c6a0f6', '#a6da95'],
  },
];

const isPreference = (v: unknown): v is ThemePreference => v === 'system' || themes.some((t) => t.id === v);

function readStored(): { preference: ThemePreference; storage: boolean } {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return { preference: isPreference(raw) ? raw : 'system', storage: true };
  } catch {
    return { preference: 'system', storage: false };
  }
}

const media =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
const initial = readStored();
const preference = ref<ThemePreference>(initial.preference);
const storageAvailable = ref(initial.storage);
const systemDark = ref(media?.matches ?? false);
media?.addEventListener('change', (e) => (systemDark.value = e.matches));
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_STORAGE_KEY || e.key === null) preference.value = readStored().preference;
  });
}

export const resolvedTheme = computed<ThemeId>(() =>
  preference.value === 'system' ? (systemDark.value ? SYSTEM_DARK_THEME : 'light') : preference.value,
);

export function applyTheme(theme: ThemeId) {
  const root = document.documentElement;
  const mode = themes.find((t) => t.id === theme)!.mode;
  root.dataset.theme = theme;
  root.dataset.mode = mode;
  root.style.colorScheme = mode;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--background').trim() || meta.content;
}

export function useTheme() {
  return {
    preference,
    resolvedTheme,
    storageAvailable,
    mode: computed(() => themes.find((t) => t.id === resolvedTheme.value)!.mode),
    setPreference(next: ThemePreference) {
      preference.value = next;
      try {
        if (next === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
        else window.localStorage.setItem(THEME_STORAGE_KEY, next);
        storageAvailable.value = true;
      } catch {
        storageAvailable.value = false;
      }
    },
  };
}
