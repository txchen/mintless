import { computed, ref } from 'vue';
import {
  clampWidth,
  COLUMN_STORAGE_KEY,
  parseStoredWidths,
  serializeWidths,
  type ColumnId,
  type ColumnWidths,
} from '../lib/columns.ts';

function load(): ColumnWidths {
  try {
    return parseStoredWidths(window.localStorage.getItem(COLUMN_STORAGE_KEY));
  } catch {
    return {};
  }
}

const widths = ref<ColumnWidths>(load());

function persist() {
  try {
    if (Object.keys(widths.value).length)
      window.localStorage.setItem(COLUMN_STORAGE_KEY, serializeWidths(widths.value));
    else window.localStorage.removeItem(COLUMN_STORAGE_KEY);
  } catch {
    return;
  }
}

export function useColumnWidths() {
  return {
    widths,
    customized: computed(() => Object.keys(widths.value).length > 0),
    preview(id: ColumnId, width: number) {
      widths.value = { ...widths.value, [id]: clampWidth(id, width) };
    },
    restore(snapshot: ColumnWidths) {
      widths.value = snapshot;
    },
    commit: persist,
    resetColumn(id: ColumnId) {
      const { [id]: _removed, ...rest } = widths.value;
      widths.value = rest;
      persist();
    },
    reset() {
      widths.value = {};
      persist();
    },
  };
}
