import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const base = process.env.MINTLESS_URL ?? 'http://127.0.0.1:3000';
const username = process.env.MINTLESS_USER ?? 'admin';
const password = process.env.MINTLESS_PASSWORD;
const out = process.env.MINTLESS_SCREENSHOTS ?? 'dist/screenshots';
if (!password)
  throw new Error('Set MINTLESS_PASSWORD (and optionally MINTLESS_URL, MINTLESS_USER, MINTLESS_SCREENSHOTS)');
mkdirSync(out, { recursive: true });

const widths = [360, 390, 820, 1440];
const browser = await chromium.launch(
  process.env.MINTLESS_CHROMIUM ? { executablePath: process.env.MINTLESS_CHROMIUM } : {},
);

async function noHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 0, `${label}: page scrolls horizontally by ${overflow}px`);
}

const results: string[] = [];
for (const width of widths) {
  const context = await browser.newContext({
    viewport: { width, height: width < 768 ? 800 : 900 },
    hasTouch: width < 1024,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/transactions');

  const firstRow = page.locator('[data-row-link]').first();
  await firstRow.waitFor();
  const label = page.locator('tbody tr, a[data-row-link]').first().locator('[title*="ending"]').first();
  if (width < 768 || width >= 1280) {
    const title = await label.getAttribute('title');
    assert.match(title ?? '', /ending \d{4}$/, `${width}: list row names the account with its last digits`);
  }
  await noHorizontalScroll(page, `${width} list`);

  await firstRow.click();
  await page.getByLabel('Note').waitFor();
  const gaps = await page.evaluate(() =>
    [...document.querySelectorAll('dl dt')].map((dt) => {
      const dd = dt.nextElementSibling as HTMLElement;
      const a = dt.getBoundingClientRect();
      const b = dd.getBoundingClientRect();
      return {
        label: dt.textContent?.trim(),
        gap: b.top >= a.bottom - 1 ? 99 : b.left - a.right,
        right: b.right,
      };
    }),
  );
  for (const g of gaps) {
    assert.ok(g.gap >= 8, `${width}: "${g.label}" is ${g.gap}px from its value`);
    assert.ok(g.right <= width + 1, `${width}: "${g.label}" value overflows`);
  }
  await noHorizontalScroll(page, `${width} detail`);
  await page.screenshot({ path: join(out, `detail-${width}.png`) });

  // An invisible account is reported, not widened; All accounts is an explicit choice.
  await page.goto(`${base}/overview?account=not-a-visible-account`);
  await page.getByRole('heading', { name: 'Nothing to show for this scope' }).waitFor({ timeout: 5000 });
  assert.equal(
    await page.getByText('Money in and spending by month').count(),
    0,
    `${width}: no totals shown`,
  );
  await page.getByRole('main').getByRole('link', { name: 'All accounts' }).click();
  await page.waitForURL((url) => !url.searchParams.has('account'), { timeout: 5000 });
  await page.getByText('Money in and spending by month').waitFor();
  await page.getByText('Spending by category').waitFor();
  const months = page.getByRole('radiogroup', { name: 'Month' }).getByRole('radio');
  const count = await months.count();
  assert.ok(count >= 3, `${width}: monthly chart shows ${count} months`);
  await months.nth(count - 1).focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(
    await months.nth(count - 2).getAttribute('aria-checked'),
    'true',
    `${width}: arrow keys move between months`,
  );
  const currencies = page.getByRole('group', { name: 'Currency' }).getByRole('button');
  if ((await currencies.count()) > 1) {
    await currencies.nth(0).click();
    await page.waitForURL(/currency=/);
    await page.getByText('Money in and spending by month').waitFor();
  }
  await noHorizontalScroll(page, `${width} overview`);
  await page.screenshot({ path: join(out, `overview-${width}.png`), fullPage: true });
  assert.deepEqual(errors, [], `${width}: page errors`);
  results.push(
    `${width}: list account labels, detail label gaps ${Math.min(...gaps.map((g) => g.gap))}px+, overview charts, keyboard months ok`,
  );
  await context.close();
}
await browser.close();
console.log(results.join('\n'));
