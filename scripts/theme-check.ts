import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';

const base = process.env.MINTLESS_URL ?? 'http://127.0.0.1:3000';
const username = process.env.MINTLESS_USER ?? 'admin';
const password = process.env.MINTLESS_PASSWORD;
const out = process.env.MINTLESS_SCREENSHOTS ?? 'dist/screenshots/themes';
const writes = process.env.MINTLESS_ALLOW_WRITES === '1';
if (!password)
  throw new Error(
    'Set MINTLESS_PASSWORD (and MINTLESS_URL, MINTLESS_USER, MINTLESS_SCREENSHOTS; MINTLESS_ALLOW_WRITES=1 on scratch data only)',
  );
mkdirSync(out, { recursive: true });

const themes = ['light', 'one-dark', 'nord', 'macchiato'] as const;
const text: [string, string][] = [
  ['foreground', 'background'],
  ['foreground', 'card'],
  ['foreground', 'popover'],
  ['foreground', 'secondary'],
  ['foreground', 'accent'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'secondary'],
  ['muted-foreground', 'warning-surface'],
  ['primary-foreground', 'primary'],
  ['accent-foreground', 'accent'],
  ['inflow', 'background'],
  ['inflow', 'card'],
  ['destructive', 'background'],
  ['destructive-foreground', 'destructive'],
  ['warning-foreground', 'warning-surface'],
  ['primary', 'background'],
  ['rail-foreground', 'rail'],
  ['rail-muted', 'rail'],
  ['rail-foreground', 'rail-active'],
];
const ui: [string, string][] = [
  ['ring', 'background'],
  ['ring', 'card'],
  ['chart-in', 'card'],
  ['chart-out', 'card'],
  ['chart-in', 'background'],
  ['chart-out', 'background'],
];

const browser: Browser = await chromium.launch(
  process.env.MINTLESS_CHROMIUM ? { executablePath: process.env.MINTLESS_CHROMIUM } : {},
);

function contrast(page: Page, pairs: [string, string][]) {
  return page.evaluate((list) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const rgb = (name: string, under?: number[]) => {
      ctx.clearRect(0, 0, 1, 1);
      if (under) {
        ctx.fillStyle = `rgb(${under.join(' ')})`;
        ctx.fillRect(0, 0, 1, 1);
      }
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
    };
    const lum = (c: number[]) =>
      c
        .map((v) => v / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    return list.map(([fg, bg]) => {
      const b = rgb(bg);
      const f = rgb(fg, b);
      const [hi, lo] = [lum(f), lum(b)].sort((x, y) => y - x) as [number, number];
      return { pair: `${fg}/${bg}`, ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100, bg: b };
    });
  }, pairs);
}

const report: string[] = [];
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  for (const theme of themes) {
    await page.goto(`${base}/login`);
    await page.evaluate((t) => localStorage.setItem('mintless.theme', t), theme);
    await page.reload();
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.theme),
      theme,
      `${theme}: applied after reload`,
    );
    const t = await contrast(page, text);
    const u = await contrast(page, ui);
    for (const r of t) assert.ok(r.ratio >= 4.5, `${theme}: text ${r.pair} is ${r.ratio}:1`);
    for (const r of u) assert.ok(r.ratio >= 3, `${theme}: UI ${r.pair} is ${r.ratio}:1`);
    if (theme !== 'light') {
      const bg = t[0]!.bg;
      assert.ok(Math.max(...bg) > 20, `${theme}: background is not near black`);
      const fg = await page.evaluate(() => getComputedStyle(document.body).color);
      assert.notEqual(fg, 'rgb(255, 255, 255)', `${theme}: body text is not pure white`);
    }
    const min = (rows: { ratio: number }[]) => Math.min(...rows.map((r) => r.ratio));
    report.push(`${theme}: text pairs min ${min(t)}:1 (${t.length}), UI pairs min ${min(u)}:1 (${u.length})`);
  }
  await ctx.close();
}

async function themeOn(options: BrowserContextOptions & { stored?: string; blockStorage?: boolean }) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: options.colorScheme,
  });
  if (options.blockStorage) {
    await ctx.addInitScript(() =>
      Object.defineProperty(window, 'localStorage', {
        get: () => {
          throw new DOMException('blocked', 'SecurityError');
        },
      }),
    );
  } else if (options.stored !== undefined) {
    await ctx.addInitScript((v) => localStorage.setItem('mintless.theme', v), options.stored);
  }
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  return { ctx, page, theme: () => page.evaluate(() => document.documentElement.dataset.theme) };
}

{
  const dark = await themeOn({ colorScheme: 'dark' });
  assert.equal(await dark.theme(), 'one-dark', 'unset preference follows a dark OS with One Dark');
  await dark.page.emulateMedia({ colorScheme: 'light' });
  await dark.page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await dark.page.emulateMedia({ colorScheme: 'dark' });
  await dark.page.waitForFunction(() => document.documentElement.dataset.theme === 'one-dark');
  await dark.ctx.close();

  const explicit = await themeOn({ colorScheme: 'dark', stored: 'light' });
  assert.equal(await explicit.theme(), 'light', 'explicit Light overrides a dark OS');
  await explicit.page.emulateMedia({ colorScheme: 'light' });
  await explicit.page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await explicit.theme(), 'light', 'explicit choice ignores OS changes');
  await explicit.ctx.close();

  const invalid = await themeOn({ colorScheme: 'dark', stored: 'solarized-neon' });
  assert.equal(await invalid.theme(), 'one-dark', 'an invalid stored value falls back to System');
  await invalid.ctx.close();

  const blocked = await themeOn({ colorScheme: 'light', blockStorage: true });
  assert.equal(await blocked.theme(), 'light', 'blocked storage still renders the System theme');
  await blocked.page.getByLabel('Username').fill(username);
  await blocked.page.getByLabel('Password').fill(password);
  await blocked.page.getByRole('button', { name: 'Sign in' }).click();
  await blocked.page.waitForURL('**/transactions');
  await blocked.page.goto(`${base}/settings`);
  await blocked.page.getByText('Nord', { exact: true }).click();
  assert.equal(await blocked.theme(), 'nord', 'choice applies even when it cannot be saved');
  await blocked.page.getByText('This browser blocks local storage').waitFor();
  await blocked.ctx.close();
  report.push('system: follows OS live, explicit overrides, invalid value and blocked storage handled');
}

async function signIn(page: Page) {
  await page.goto(`${base}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/transactions');
  await page.locator('[data-row-link]').first().waitFor();
}

const noOverflow = async (page: Page, label: string) =>
  assert.ok(
    (await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )) <= 0,
    `${label}: horizontal overflow`,
  );

for (const theme of themes) {
  for (const [name, viewport] of [
    ['phone', { width: 390, height: 844 }],
    ['desktop', { width: 1440, height: 900 }],
  ] as const) {
    const ctx = await browser.newContext({
      viewport,
      deviceScaleFactor: name === 'phone' ? 2 : 1,
      hasTouch: name === 'phone',
    });
    await ctx.addInitScript((t) => localStorage.setItem('mintless.theme', t), theme);
    const page = await ctx.newPage();
    const shot = (what: string) => page.screenshot({ path: join(out, `${theme}-${name}-${what}.png`) });
    await page.goto(`${base}/login`);
    await page.getByLabel('Username').fill('example');
    await shot('login');
    await signIn(page);
    await noOverflow(page, `${theme} ${name} list`);
    await shot('list');
    if (name === 'phone') {
      await page.getByRole('button', { name: /^Filters/ }).click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(500);
      await shot('filters');
      await page.keyboard.press('Escape');
    }
    const row = page.locator('[data-row-link]').nth(2);
    const id = await row.getAttribute('data-row-link');
    await row.click();
    await page.getByLabel('Note').waitFor();
    await page.getByLabel('Category').focus();
    await shot('editor');
    if (writes && name === 'desktop') {
      const csrf = ((await (await page.request.get(`${base}/api/session`)).json()) as { csrfToken: string })
        .csrfToken;
      const current = (await (await page.request.get(`${base}/api/transactions/${id}`)).json()) as {
        annotation: { revision: number };
      };
      await page.getByLabel('Note').fill(`theme check ${theme}`);
      await page.request.patch(`${base}/api/transactions/${id}/annotation`, {
        headers: { 'x-csrf-token': csrf },
        data: { revision: current.annotation.revision, note: `changed elsewhere ${theme}` },
      });
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByText('Someone else changed this transaction').waitFor();
      await page.waitForTimeout(500);
      await shot('conflict-dialog');
      await page.getByRole('button', { name: 'Keep theirs' }).click();
    }
    await page.goto(`${base}/overview`);
    await page.getByText('Spending by category').waitFor();
    await page.waitForTimeout(300);
    await noOverflow(page, `${theme} ${name} overview`);
    await page.screenshot({ path: join(out, `${theme}-${name}-overview.png`), fullPage: true });
    await page.goto(`${base}/settings`);
    await page.getByText('Appearance').waitFor();
    await shot('settings');
    await ctx.close();
  }
}
report.push(
  `screens: login, list, editor, overview, settings at 390 and 1440${writes ? ', conflict dialog at 1440' : ''}, phone filter drawer, for ${themes.length} themes`,
);
await browser.close();
console.log(report.join('\n'));
