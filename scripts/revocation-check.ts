import assert from 'node:assert/strict';
import { chromium, type APIRequestContext } from 'playwright';
import type { AccountSummary, TransactionPage } from '../src/shared/contracts.ts';

const base = process.env.MINTLESS_URL ?? 'http://127.0.0.1:3000';
const adminUser = process.env.MINTLESS_ADMIN_USER ?? 'admin';
const memberUser = process.env.MINTLESS_MEMBER_USER ?? 'member';
const adminPassword = process.env.MINTLESS_ADMIN_PASSWORD;
const memberPassword = process.env.MINTLESS_MEMBER_PASSWORD;
if (!adminPassword || !memberPassword)
  throw new Error('Set MINTLESS_ADMIN_PASSWORD and MINTLESS_MEMBER_PASSWORD');

const browser = await chromium.launch(
  process.env.MINTLESS_CHROMIUM ? { executablePath: process.env.MINTLESS_CHROMIUM } : {},
);

async function signIn(username: string, password: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/transactions');
  await page.locator('[data-row-link]').first().waitFor();
  const csrf = (await (await page.request.get(`${base}/api/session`)).json()) as { csrfToken: string };
  return { page, request: page.request, csrf: csrf.csrfToken };
}

const putMembers = (request: APIRequestContext, csrf: string, groupId: string, userIds: string[]) =>
  request.put(`${base}/api/admin/groups/${groupId}/members`, {
    headers: { 'x-csrf-token': csrf },
    data: { userIds },
  });

const admin = await signIn(adminUser, adminPassword);
const member = await signIn(memberUser, memberPassword);
const memberAccounts = (await (await member.request.get(`${base}/api/accounts`)).json()) as AccountSummary[];
assert.ok(memberAccounts.length >= 2, 'member needs at least two shared accounts for this check');
const target = memberAccounts[0]!;
const adminView = ((await (await admin.request.get(`${base}/api/accounts`)).json()) as AccountSummary[]).find(
  (a) => a.id === target.id,
)!;
const groupId = adminView.groupId;
const groups = (await (await admin.request.get(`${base}/api/groups`)).json()) as {
  id: string;
  memberIds?: string[];
}[];
const originalGrants = groups.find((g) => g.id === groupId)?.memberIds ?? [];
const memberId = (
  (await (await member.request.get(`${base}/api/session`)).json()) as { user: { id: string } }
).user.id;

const rows = (await (
  await member.request.get(`${base}/api/transactions?account=${target.id}&limit=2`)
).json()) as TransactionPage;
assert.ok(rows.rows.length >= 2, 'the first shared account needs at least two transactions for this check');
const revokedTx = rows.rows[0]!;
const siblingTx = rows.rows[1]!;
const listRow = (id: string) => member.page.locator(`tr:has([data-row-link="${id}"])`);

const focusAfterThrottle = async () => {
  await member.page.waitForTimeout(3100);
  await member.page.evaluate(() => window.dispatchEvent(new Event('focus')));
};
const revoke = async () =>
  assert.equal(
    (
      await putMembers(
        admin.request,
        admin.csrf,
        groupId,
        originalGrants.filter((id: string) => id !== memberId),
      )
    ).status(),
    204,
  );
const markPage = () => member.page.evaluate(() => Object.assign(window, { mintlessNoReload: true }));
const assertNoReload = async (label: string) =>
  assert.equal(
    await member.page.evaluate(() => 'mintlessNoReload' in window),
    true,
    `${label}: page did not reload`,
  );
const restore = async () =>
  assert.equal((await putMembers(admin.request, admin.csrf, groupId, originalGrants)).status(), 204);

try {
  await member.page.goto(`${base}/transactions/${revokedTx.id}`);
  await member.page.getByLabel('Note').waitFor();
  await listRow(revokedTx.id).waitFor();
  await markPage();
  await revoke();
  await focusAfterThrottle();
  await member.page.getByText('This item is not available').waitFor({ timeout: 5000 });
  assert.equal(
    await member.page.getByLabel('Note').count(),
    0,
    'open detail of a revoked transaction is replaced by a notice',
  );
  await member.page.waitForFunction(
    (id) => !document.querySelector(`[data-row-link="${id}"]`),
    revokedTx.id,
    { timeout: 5000 },
  );
  assert.equal(
    await member.page.getByRole('cell', { name: target.displayName, exact: true }).count(),
    0,
    'rows from the revoked account are gone',
  );
  await assertNoReload('open detail');
  console.log('open detail: replaced by a notice; list rows of the revoked account removed after focus');
  await restore();

  await member.page.goto(`${base}/transactions?account=${target.id}`);
  await listRow(revokedTx.id).waitFor();
  await markPage();
  assert.ok(
    await member.page.getByRole('option', { name: new RegExp(target.displayName) }).count(),
    'filter offers the account before revocation',
  );
  await revoke();
  await focusAfterThrottle();
  // The revoked scope stays in the URL and is reported, never widened to other accounts.
  await member.page
    .getByRole('heading', { name: 'Nothing to show for this scope' })
    .waitFor({ timeout: 5000 });
  assert.equal(new URL(member.page.url()).searchParams.get('account'), target.id, 'scope kept, not widened');
  assert.equal(await member.page.locator('[data-row-link]').count(), 0, 'no rows from any other scope');
  assert.ok(await member.page.getByRole('link', { name: 'All accounts' }).first().isVisible());
  await member.page.waitForFunction(
    (id) => !document.querySelector(`[data-row-link="${id}"]`),
    revokedTx.id,
    { timeout: 5000 },
  );
  assert.equal(
    await member.page.getByRole('option', { name: new RegExp(target.displayName) }).count(),
    0,
    'filter no longer offers the revoked account',
  );
  assert.equal(
    await member.page.getByRole('cell', { name: target.displayName, exact: true }).count(),
    0,
    'no visible rows from the revoked account',
  );
  await assertNoReload('account filter');
  console.log('account scope: revoked scope reported with explicit choices, no rows, without reload');
  await restore();

  await member.page.goto(`${base}/transactions/${revokedTx.id}`);
  await member.page.getByLabel('Note').waitFor();
  await listRow(siblingTx.id).waitFor();
  await markPage();
  await revoke();
  await member.page.getByLabel('Note').fill(`saved after revocation ${Date.now()}`);
  await member.page.getByRole('button', { name: 'Save', exact: true }).click();
  await member.page.getByText('This item is not available').first().waitFor({ timeout: 5000 });
  await member.page.waitForFunction(
    (id) => !document.querySelector(`[data-row-link="${id}"]`),
    siblingTx.id,
    {
      timeout: 5000,
    },
  );
  await assertNoReload('save after revocation');
  console.log('save after revocation: 404 notice, other rows of the account cleared without a focus event');
} finally {
  await restore();
  await browser.close();
}
