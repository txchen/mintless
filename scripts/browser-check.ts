import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices, type Page } from 'playwright';

const base = process.env.MINTLESS_URL ?? 'http://127.0.0.1:3000';
const username = process.env.MINTLESS_USER ?? 'admin';
const password = process.env.MINTLESS_PASSWORD;
const out = process.env.MINTLESS_SCREENSHOTS ?? 'dist/screenshots';
if (!password)
  throw new Error('Set MINTLESS_PASSWORD (and optionally MINTLESS_URL, MINTLESS_USER, MINTLESS_SCREENSHOTS)');
mkdirSync(out, { recursive: true });

const viewports = [
  { name: 'phone-narrow', ...devices['Galaxy S9+'], viewport: { width: 360, height: 740 } },
  { name: 'phone', ...devices['iPhone 13'] },
  { name: 'tablet', viewport: { width: 820, height: 1180 }, hasTouch: true },
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
];

async function noHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 0, `${label}: page scrolls horizontally by ${overflow}px`);
}

const browser = await chromium.launch(
  process.env.MINTLESS_CHROMIUM ? { executablePath: process.env.MINTLESS_CHROMIUM } : {},
);
const results: string[] = [];
for (const { name, ...options } of viewports) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${base}/transactions`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/transactions');
  const rows = page.locator('[data-row-link]');
  await rows.first().waitFor();
  await noHorizontalScroll(page, `${name} list`);
  await page.screenshot({ path: join(out, `${name}-list.png`) });

  const wide = (options.viewport?.width ?? 0) >= 768;
  if (!wide) {
    await page.getByRole('button', { name: /^Filters/ }).click();
    await page.getByRole('dialog').getByLabel('Status').selectOption('pending');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.waitForURL(/status=pending/);
    await page.screenshot({ path: join(out, `${name}-filtered.png`) });
    await page.goto(`${base}/transactions`);
    await rows.first().waitFor();
  }

  await page.evaluate(() => window.scrollTo(0, 600));
  const scrolled = await page.evaluate(() => window.scrollY);
  const target = rows.nth(12);
  const id = await target.getAttribute('data-row-link');
  await target.click();
  await page.waitForURL(`**/transactions/${id}`);
  const note = page.getByLabel('Note');
  await note.waitFor();
  const text = `Checked on ${name} ${new Date().toISOString()}`;
  await note.fill(text);
  if (!wide) await note.focus();
  await noHorizontalScroll(page, `${name} editor`);
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const box = await save.boundingBox();
  const vh = page.viewportSize()!.height;
  assert.ok(box && box.y + box.height <= vh, `${name}: save button is off screen`);
  await page.screenshot({ path: join(out, `${name}-editor.png`) });
  const reconciled = page.getByRole('checkbox');
  const wasReconciled = (await reconciled.getAttribute('data-state')) === 'checked';
  await reconciled.click();
  await save.click();
  await page.getByText('Saved', { exact: true }).waitFor();
  assert.equal(
    await page.getByText('Someone else changed this transaction').count(),
    0,
    `${name}: unexpected conflict`,
  );
  assert.equal(
    await reconciled.getAttribute('data-state'),
    wasReconciled ? 'unchecked' : 'checked',
    `${name}: reconcile toggle saved`,
  );
  await page
    .getByLabel(/Back to transactions|Close details/)
    .filter({ visible: true })
    .click();
  await page.waitForURL('**/transactions');
  const restored = await page.evaluate(() => window.scrollY);
  if (!wide)
    assert.ok(
      Math.abs(restored - scrolled) < 80,
      `${name}: list position not kept (${scrolled} -> ${restored})`,
    );
  await page
    .locator(wide ? `tr:has([data-row-link="${id}"])` : `[data-row-link="${id}"]`)
    .getByText(text)
    .waitFor();
  assert.deepEqual(errors, [], `${name}: page errors`);
  results.push(
    `${name}: list, ${wide ? '' : 'filter drawer, '}edit note, toggle reconciled, save, return ok`,
  );
  await context.close();
}
await browser.close();
console.log(results.join('\n'));
