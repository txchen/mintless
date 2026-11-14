import { describe, expect, it } from 'vite-plus/test';
import { columnSpec, layoutColumns, parseStoredWidths, serializeWidths } from '../src/web/lib/columns.ts';

describe('transaction table column layout', () => {
  it('gives the account column room before letting the description grow without bound', () => {
    const { widths, total } = layoutColumns(1240, {});
    expect(total).toBe(1240);
    expect(widths.description).toBeLessThanOrEqual(560);
    expect(widths.account).toBeGreaterThanOrEqual(260);
    expect(widths.amount).toBeGreaterThanOrEqual(columnSpec.amount.min);
  });

  it('shrinks defaults toward their minimums to fit, and only scrolls when even minimums do not fit', () => {
    const fits = layoutColumns(640, {}, ['date', 'description', 'account', 'amount']);
    expect(fits.total).toBe(640);
    expect(fits.widths.amount).toBe(columnSpec.amount.base);
    expect(fits.widths.account).toBeGreaterThanOrEqual(columnSpec.account.min);
    const tight = layoutColumns(400, {});
    expect(tight.total).toBeGreaterThan(400);
    expect(tight.widths.description).toBe(columnSpec.description.min);
    expect(tight.widths.amount).toBe(columnSpec.amount.base);
  });

  it('honors user widths and lets the remaining flexible column absorb leftover space', () => {
    const { widths, total } = layoutColumns(1240, { account: 400, description: 300 });
    expect(widths).toMatchObject({ account: 400, description: 300 });
    expect(total).toBe(1240);
    const wide = layoutColumns(900, { account: 480, description: 600 });
    expect(wide.total).toBeGreaterThan(900);
  });

  it('never pushes leftover space into Amount or past any maximum', () => {
    const { widths, total } = layoutColumns(1600, { description: 200, account: 200, category: 120 });
    for (const [id, w] of Object.entries(widths))
      expect(w).toBeLessThanOrEqual(columnSpec[id as keyof typeof columnSpec].max);
    expect(widths.amount).toBe(columnSpec.amount.base);
    expect(total).toBeLessThan(1600);
  });

  it('only lays out visible columns', () => {
    const { widths, total } = layoutColumns(700, {}, ['date', 'description', 'status', 'amount']);
    expect(Object.keys(widths)).toEqual(['date', 'description', 'status', 'amount']);
    expect(total).toBe(700);
  });

  it('reads only valid versioned stored widths and clamps them to each column range', () => {
    expect(parseStoredWidths(serializeWidths({ account: 9999, date: 1, category: 180 }))).toEqual({
      account: columnSpec.account.max,
      date: columnSpec.date.min,
      category: 180,
    });
    for (const raw of [
      null,
      '',
      'not json',
      '{"v":2,"widths":{"account":200}}',
      '{"v":1,"widths":"x"}',
      '{"v":1,"widths":{"account":"wide"}}',
    ]) {
      expect(parseStoredWidths(raw)).toEqual({});
    }
  });
});
