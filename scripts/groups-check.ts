import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const base = process.env.MINTLESS_URL ?? 'http://127.0.0.1:3000';
const adminPassword = process.env.MINTLESS_ADMIN_PASSWORD;
const memberPassword = process.env.MINTLESS_MEMBER_PASSWORD;
const out = process.env.MINTLESS_SCREENSHOTS ?? 'dist/screenshots/groups';
const account = process.env.MINTLESS_MOVE_ACCOUNT ?? 'Summit Rewards Visa';
if (!adminPassword || !memberPassword)
  throw new Error('Set MINTLESS_ADMIN_PASSWORD and MINTLESS_MEMBER_PASSWORD; run only against scratch data');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch(
  process.env.MINTLESS_CHROMIUM ? { executablePath: process.env.MINTLESS_CHROMIUM } : {},
);
async function signIn(
  user: string,
  password: string,
  viewport: { width: number; height: number },
  theme = 'one-dark',
) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 768 ? 2 : 1 });
  await ctx.addInitScript((t) => localStorage.setItem('mintless.theme', t), theme);
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/transactions');
  return { ctx, page };
}
const noOverflow = async (page: Page, label: string) =>
  assert.ok(
    (await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )) <= 0,
    `${label}: overflow`,
  );
const focusAgain = async (page: Page) => {
  await page.waitForTimeout(3100);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
};
const rowsMentioning = (page: Page, text: string) => page.locator('a[data-row-link]', { hasText: text });

const admin = await signIn('admin', adminPassword, { width: 1440, height: 900 });
const member = await signIn('member', memberPassword, { width: 390, height: 844 });
await member.page.locator('a[data-row-link]').first().waitFor();
assert.ok(
  (await rowsMentioning(member.page, account.split(' ')[0]!).count()) > 0,
  'member sees the account before the move',
);

await admin.page.goto(`${base}/accounts`);
await admin.page.getByRole('heading', { name: 'Groups' }).waitFor();
await admin.page.getByLabel('New group name').fill('Travel');
await admin.page.getByRole('button', { name: 'Add group' }).click();
await admin.page.getByText('Created Travel').waitFor();
await admin.page.getByRole('button', { name: `Move ${account} to another group` }).click();
const dialog = admin.page.getByRole('dialog');
await dialog.getByLabel('Destination group').selectOption({ label: 'Travel' });
await dialog.getByText('Loses access:').waitFor();
assert.match(await dialog.getByRole('status').innerText(), /Loses access: member/);
await admin.page.waitForTimeout(300);
await admin.page.screenshot({ path: join(out, 'move-impact-desktop.png') });
await dialog.getByRole('button', { name: 'Move account' }).click();
await admin.page.getByText(`Moved ${account} to Travel`).waitFor();

await focusAgain(member.page);
await member.page.waitForFunction(
  (t) => ![...document.querySelectorAll('a[data-row-link]')].some((a) => a.textContent?.includes(t)),
  account.split(' ')[0]!,
  { timeout: 5000 },
);
const markReload = await member.page.evaluate(() => performance.getEntriesByType('navigation').length);
assert.equal(markReload, 1, 'no full reload');

await admin.page.getByRole('button', { name: 'Manage Travel' }).click();
await admin.page.getByRole('dialog').getByText('member', { exact: true }).click();
await admin.page.waitForTimeout(300);
await admin.page.screenshot({ path: join(out, 'manage-group-desktop.png') });
await admin.page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
await admin.page.getByText('Group saved').waitFor();
await focusAgain(member.page);
await rowsMentioning(member.page, account.split(' ')[0]!).first().waitFor({ timeout: 5000 });

await member.page.getByRole('button', { name: /^Filters/ }).click();
const drawer = member.page.getByRole('dialog');
await drawer.getByLabel('Group').selectOption({ label: 'Travel' });
await drawer.getByRole('button', { name: 'Apply' }).click();
await member.page.waitForURL(/group=/);
await member.page.locator('a[data-row-link]').first().waitFor();
const accountsShown = await member.page
  .locator('a[data-row-link] [title*="ending"]')
  .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('title')!.replace(/ ending.*/, '')))]);
assert.deepEqual(accountsShown, [account], `group filter shows only ${account}`);
await noOverflow(member.page, 'member list with group filter');
await member.page.screenshot({ path: join(out, 'member-phone-filtered.png') });

await admin.page.goto(`${base}/overview`);
const tree = admin.page.getByRole('navigation', { name: 'Account scope' });
await tree.getByRole('link', { name: /^Travel/ }).click();
await admin.page.waitForURL(/overview\?.*group=/);
assert.equal(await tree.locator('[aria-current="page"]').count(), 1, 'exactly one active scope');
await admin.page.getByRole('link', { name: 'Transactions', exact: true }).first().click();
await admin.page.waitForURL(/transactions\?.*group=/);
assert.equal(await tree.locator('[aria-current="page"]').count(), 1, 'tabs keep the scope');
await admin.page.goBack();
await admin.page.waitForURL(/overview\?.*group=/);
await admin.page.getByText('Spending by category').waitFor();
await noOverflow(admin.page, 'overview with group');
await admin.page.screenshot({ path: join(out, 'overview-group-desktop.png') });
await admin.ctx.close();
await member.ctx.close();

for (const theme of ['light', 'one-dark', 'nord', 'macchiato']) {
  for (const [name, viewport] of [
    ['phone', { width: 390, height: 844 }],
    ['desktop', { width: 1440, height: 900 }],
  ] as const) {
    const a = await signIn('admin', adminPassword, viewport, theme);
    await a.page.goto(`${base}/accounts`);
    await a.page.getByRole('heading', { name: 'Groups' }).waitFor();
    await a.page.waitForTimeout(300);
    await noOverflow(a.page, `${theme} ${name} accounts`);
    await a.page.screenshot({ path: join(out, `${theme}-${name}-accounts-admin.png`), fullPage: true });
    await a.page.getByRole('button', { name: `Move ${account} to another group` }).click();
    await a.page.getByRole('dialog').getByLabel('Destination group').selectOption({ index: 1 });
    await a.page.getByRole('dialog').getByRole('status').waitFor();
    await a.page.waitForTimeout(300);
    const d = a.page.getByRole('dialog');
    assert.ok(
      (await d.evaluate((e) => e.scrollWidth - e.clientWidth)) <= 0,
      `${theme} ${name} move dialog fits`,
    );
    await a.page.screenshot({ path: join(out, `${theme}-${name}-move-dialog.png`) });
    await a.ctx.close();
    const m = await signIn('member', memberPassword, viewport, theme);
    await m.page.goto(`${base}/accounts`);
    await m.page.getByRole('main').getByText(account).first().waitFor();
    assert.equal(
      await m.page.getByRole('heading', { name: 'Groups' }).count(),
      0,
      'members do not see group management',
    );
    await noOverflow(m.page, `${theme} ${name} member accounts`);
    await m.page.screenshot({ path: join(out, `${theme}-${name}-accounts-member.png`), fullPage: true });
    await m.ctx.close();
  }
}
await browser.close();
console.log(
  'groups: create, move with impact, member loses then regains access on focus, group filters, 4 themes x phone/desktop',
);
