export const columnIds = ['date', 'description', 'account', 'category', 'status', 'amount'] as const;
export type ColumnId = (typeof columnIds)[number];
export type ColumnWidths = Partial<Record<ColumnId, number>>;

export const columnSpec: Record<ColumnId, { label: string; min: number; base: number; max: number }> = {
  date: { label: 'Date', min: 72, base: 84, max: 160 },
  description: { label: 'Description', min: 180, base: 280, max: 900 },
  account: { label: 'Account', min: 140, base: 210, max: 480 },
  category: { label: 'Category', min: 100, base: 150, max: 360 },
  status: { label: 'Status', min: 88, base: 108, max: 240 },
  amount: { label: 'Amount', min: 120, base: 136, max: 240 },
};

export const COLUMN_STORAGE_KEY = 'mintless.columns.v1';
const DESCRIPTION_DEFAULT_MAX = 460;
const growOrder: { id: ColumnId; cap: number }[] = [
  { id: 'description', cap: DESCRIPTION_DEFAULT_MAX },
  { id: 'account', cap: 300 },
  { id: 'category', cap: 200 },
  { id: 'description', cap: columnSpec.description.max },
];

const shrinkOrder: ColumnId[] = ['description', 'category', 'account', 'status', 'date'];

export const clampWidth = (id: ColumnId, w: number) =>
  Math.round(Math.min(columnSpec[id].max, Math.max(columnSpec[id].min, w)));

export function layoutColumns(
  available: number,
  user: ColumnWidths,
  visible: readonly ColumnId[] = columnIds,
) {
  const widths = Object.fromEntries(visible.map((id) => [id, user[id] ?? columnSpec[id].base])) as Record<
    ColumnId,
    number
  >;
  let free = Math.floor(available) - visible.reduce((n, id) => n + widths[id], 0);
  for (const { id, cap } of growOrder) {
    if (free <= 0) break;
    if (!visible.includes(id) || user[id] !== undefined) continue;
    const add = Math.min(free, Math.max(0, cap - widths[id]));
    widths[id] += add;
    free -= add;
  }
  for (const id of shrinkOrder) {
    if (free >= 0) break;
    if (!visible.includes(id) || user[id] !== undefined) continue;
    const take = Math.min(-free, widths[id] - columnSpec[id].min);
    widths[id] -= take;
    free += take;
  }
  for (const id of ['description', 'account', 'category'] as const) {
    if (free <= 0) break;
    if (!visible.includes(id) || user[id] !== undefined) continue;
    const add = Math.min(free, columnSpec[id].max - widths[id]);
    widths[id] += add;
    free -= add;
  }
  return { widths, total: visible.reduce((n, id) => n + widths[id], 0) };
}

export function parseStoredWidths(raw: string | null): ColumnWidths {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || (value as { v?: unknown }).v !== 1) return {};
    const widths = (value as { widths?: unknown }).widths;
    if (!widths || typeof widths !== 'object') return {};
    const out: ColumnWidths = {};
    for (const id of columnIds) {
      const w = (widths as Record<string, unknown>)[id];
      if (typeof w === 'number' && Number.isFinite(w)) out[id] = clampWidth(id, w);
    }
    return out;
  } catch {
    return {};
  }
}

export const serializeWidths = (widths: ColumnWidths) => JSON.stringify({ v: 1, widths });
