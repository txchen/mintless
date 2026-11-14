import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const base = process.env.MINTLESS_URL ?? 'http://127.0.0.1:3000';
const username = process.env.MINTLESS_USER ?? 'admin';
const password = process.env.MINTLESS_PASSWORD;
const out = process.env.MINTLESS_SCREENSHOTS ?? 'dist/screenshots/table';
const theme = process.env.MINTLESS_THEME ?? 'one-dark';
if (!password)
  throw new Error(
    'Set MINTLESS_PASSWORD (and optionally MINTLESS_URL, MINTLESS_USER, MINTLESS_SCREENSHOTS, MINTLESS_THEME)',
  );
mkdirSync(out, { recursive: true });

const browser = await chromium.launch(
  process.env.MINTLESS_CHROMIUM ? { executablePath: process.env.MINTLESS_CHROMIUM } : {},
);
const report: string[] = [];

async function open(width: number, height = 900, storage: Record<string, string> = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: width < 768 ? 2 : 1,
  });
  await ctx.addInitScript(
    (s) => {
      if (!sessionStorage.getItem('seeded')) {
        for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
        sessionStorage.setItem('seeded', '1');
      }
    },
    { 'mintless.theme': theme, ...storage },
  );
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/transactions');
  await page.locator('[data-row-link]').first().waitFor();
  return { ctx, page };
}

const pageOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const colWidth = (page: Page, label: string) =>
  page.evaluate((l) => {
    const th = [...document.querySelectorAll('thead th')].find((e) => e.textContent?.trim().startsWith(l)) as
      | HTMLElement
      | undefined;
    return th ? Math.round(th.getBoundingClientRect().width) : -1;
  }, label);
const handle = (page: Page, label: string) => page.getByRole('separator', { name: `Resize ${label} column` });

async function alignment(page: Page) {
  return page.evaluate(() => {
    const ths = [...document.querySelectorAll('thead th')].map((e) => e.getBoundingClientRect());
    const tds = [...document.querySelectorAll('tbody tr:first-child td')].map((e) =>
      e.getBoundingClientRect(),
    );
    return Math.max(
      ...ths.map((t, i) => Math.abs(t.left - tds[i]!.left) + Math.abs(t.right - tds[i]!.right)),
    );
  });
}

for (const width of [1280, 1440, 1920, 2560]) {
  const { ctx, page } = await open(width, width >= 1920 ? 1080 : 900);
  assert.ok((await pageOverflow(page)) <= 0, `${width}: page overflow`);
  assert.ok((await alignment(page)) <= 1, `${width}: header and cells align`);
  const box = await page.locator('[role="region"][aria-label="Transactions"]').boundingBox();
  assert.ok(box!.width <= 1280 + 1, `${width}: list is bounded (${box!.width}px)`);
  const account = await colWidth(page, 'Account');
  const description = await colWidth(page, 'Description');
  await page.screenshot({ path: join(out, `list-${width}.png`) });

  await page.locator('[data-row-link]').nth(1).click();
  await page.getByLabel('Note').waitFor();
  const list = await page.locator('[role="region"][aria-label="Transactions"]').boundingBox();
  const panel = await page.getByRole('complementary', { name: 'Transaction details' }).boundingBox();
  assert.ok(Math.abs(list!.x + list!.width - panel!.x) <= 1, `${width}: panel sits next to the list`);
  assert.ok((await pageOverflow(page)) <= 0, `${width}: page overflow with panel`);
  assert.ok((await alignment(page)) <= 1, `${width}: alignment with panel`);
  const clipped = await page
    .locator('[role="region"][aria-label="Transactions"]')
    .evaluate((e) => e.scrollWidth - e.clientWidth);
  assert.ok(clipped <= 0, `${width}: default columns fit beside the panel without scrolling (${clipped}px)`);
  await page.screenshot({ path: join(out, `panel-${width}.png`) });
  if (width === 1440) {
    const h = await handle(page, 'Account').boundingBox();
    await page.mouse.move(h!.x + h!.width / 2, h!.y + 5);
    await page.mouse.down();
    await page.mouse.move(h!.x + 60, h!.y + 5, { steps: 3 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.ok(page.url().includes('/transactions/'), 'Escape during a drag keeps the detail panel open');
    await page.getByLabel('Note').waitFor();
  }
  report.push(
    `${width}: bounded list ${Math.round(box!.width)}px, account ${account}px, description ${description}px, panel adjacent`,
  );
  await ctx.close();
}

{
  const { ctx, page } = await open(1440);
  const url = page.url();
  const before = await colWidth(page, 'Account');
  const h = await handle(page, 'Account').boundingBox();
  await page.mouse.move(h!.x + h!.width / 2, h!.y + h!.height / 2);
  await page.mouse.down();
  await page.mouse.move(h!.x + 120, h!.y + 10, { steps: 6 });
  await page.mouse.up();
  const dragged = await colWidth(page, 'Account');
  assert.ok(Math.abs(dragged - before - 116) <= 8, `drag widened Account ${before} -> ${dragged}`);
  assert.equal(page.url(), url, 'dragging a handle does not navigate');
  assert.equal(
    await page.evaluate(() => window.getSelection()?.toString() ?? ''),
    '',
    'dragging does not select text',
  );

  const h2 = await handle(page, 'Account').boundingBox();
  await page.mouse.move(h2!.x + h2!.width / 2, h2!.y + 5);
  await page.mouse.down();
  await page.mouse.move(h2!.x - 600, h2!.y + 5, { steps: 4 });
  assert.equal(await colWidth(page, 'Account'), 140, 'drag stops at the minimum width');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await colWidth(page, 'Account'), dragged, 'Escape cancels a drag');

  await handle(page, 'Account').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await colWidth(page, 'Account'), dragged + 16, 'arrow key widens by 16px');
  await page.keyboard.press('Shift+ArrowLeft');
  assert.equal(await colWidth(page, 'Account'), dragged - 32, 'shift+arrow narrows by 48px');

  await page.reload();
  await page.locator('[data-row-link]').first().waitFor();
  assert.equal(await colWidth(page, 'Account'), dragged - 32, 'widths persist across reload');
  await page.screenshot({ path: join(out, 'resized-1440.png') });

  for (let i = 0; i < 12; i++) {
    await handle(page, 'Description').focus();
    await page.keyboard.press('Shift+ArrowRight');
  }
  const region = page.locator('[role="region"][aria-label="Transactions"]');
  const scroll = await region.evaluate((e) => e.scrollWidth - e.clientWidth);
  assert.ok(scroll > 0, 'wide columns scroll inside the table');
  assert.ok((await pageOverflow(page)) <= 0, 'and not the page');
  await page.screenshot({ path: join(out, 'contained-scroll-1440.png') });

  await page.getByRole('button', { name: 'Reset columns' }).click();
  assert.equal(await colWidth(page, 'Account'), before, 'Reset restores the default');
  assert.equal(
    await page.evaluate(() => localStorage.getItem('mintless.columns.v1')),
    null,
    'Reset clears storage',
  );
  assert.equal(
    await page.getByRole('button', { name: 'Reset columns' }).count(),
    0,
    'Reset hides once defaults apply',
  );
  await ctx.close();
  report.push(
    `resize: drag +${dragged - before}px, min clamp, Escape cancel, keyboard, persistence, contained scroll, reset`,
  );
}

{
  const { ctx, page } = await open(1440, 900, {
    'mintless.columns.v1': '{"v":1,"widths":{"account":"wide"}}',
  });
  assert.equal(
    await page.getByRole('button', { name: 'Reset columns' }).count(),
    0,
    'invalid stored widths fall back to defaults',
  );
  await ctx.close();
}

for (const width of [360, 390]) {
  const { ctx, page } = await open(width, 844);
  assert.equal(await page.locator('table').count(), 0, `${width}: phones keep the list, not a table`);
  assert.ok((await pageOverflow(page)) <= 0, `${width}: page overflow`);
  await page.screenshot({ path: join(out, `list-${width}.png`) });
  await ctx.close();
}
report.push('mobile: 360 and 390 use the date-grouped list, no overflow');
await browser.close();
console.log(report.join('\n'));
