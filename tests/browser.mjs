// Start Vite first with these PUBLIC, FAKE values:
// VITE_SUPABASE_URL=https://test.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_test npm run dev
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(chrome) ? { executablePath: chrome } : {}), headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 1050 } });
const page = await context.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5173';
const user = { id: '10000000-0000-4000-8000-000000000001', email: 'admin@example.com', aud: 'authenticated', role: 'authenticated' };
let queue = { revision: 1, last_synced_at: new Date().toISOString(), tickets: [
  { ticket_key: 'SP-1', short_title: 'First review ticket', jira_url: 'https://sharinpix.atlassian.net/browse/SP-1', pr_urls: ['https://github.com/example/repo/pull/5'], position: 1 },
  { ticket_key: 'SP-2', short_title: 'Second review ticket', jira_url: 'https://sharinpix.atlassian.net/browse/SP-2', pr_urls: [], position: 2 },
] };
let orderSaved = false;
await page.route('https://test.supabase.co/**', async route => {
  const url = route.request().url();
  let data;
  if (url.includes('/auth/v1/token')) data = { access_token: 'fake-access-token', refresh_token: 'fake-refresh-token', token_type: 'bearer', expires_in: 3600, user };
  else if (url.includes('/auth/v1/user')) data = user;
  else if (url.includes('/auth/v1/logout')) data = {};
  else if (url.includes('/queue_admins')) data = { user_id: user.id };
  else if (url.endsWith('/rpc/get_queue')) data = queue;
  else if (url.endsWith('/rpc/save_order')) {
    const body = route.request().postDataJSON();
    assert.equal(body.expected_revision, queue.revision);
    queue.tickets.sort((a, b) => body.ticket_keys.indexOf(a.ticket_key) - body.ticket_keys.indexOf(b.ticket_key));
    data = ++queue.revision; orderSaved = true;
  } else throw new Error(`Unexpected route ${url}`);
  await route.fulfill({ json: data });
});
try {
  await page.goto(base);
  await page.locator('.ticket').first().waitFor();
  assert.equal(await page.locator('#admin-toolbar').isVisible(), false);
  await page.getByRole('button', { name: 'Admin sign in' }).click();
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('fake-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('#admin-toolbar').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Move SP-2 up' }).click();
  assert.equal(await page.locator('.ticket').first().getAttribute('data-key'), 'SP-2');
  await page.getByRole('button', { name: 'Save order', exact: true }).click();
  await page.getByText('Order saved. Everyone with the team link can see it.').waitFor();
  assert.ok(orderSaved);
  await page.reload();
  await page.locator('.ticket').first().waitFor();
  assert.equal(await page.locator('.ticket').first().getAttribute('data-key'), 'SP-2');
  await page.goto(`${base}/?demo`);
  await page.locator('.ticket').first().waitFor();
  await page.locator('.ticket').nth(3).dragTo(page.locator('.ticket').first());
  assert.equal(await page.locator('.ticket').first().getAttribute('data-key'), 'SP-1004');
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: public viewing, admin sign-in, save/reload, drag-and-drop, mobile layout.');
} finally { await browser.close(); }
