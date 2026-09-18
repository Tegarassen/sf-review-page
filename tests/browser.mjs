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
const adminKey = 'browser-test-key-123456789012345678901234';
let queue = { revision: 1, last_synced_at: new Date().toISOString(), tickets: [
  { ticket_key: 'SP-1', short_title: 'First review ticket', jira_url: 'https://sharinpix.atlassian.net/browse/SP-1', pr_urls: ['https://github.com/example/repo/pull/5'], position: 1 },
  { ticket_key: 'SP-2', short_title: 'Second review ticket', jira_url: 'https://sharinpix.atlassian.net/browse/SP-2', pr_urls: [], position: 2 },
] };
let orderSaved = false;
await page.route('https://test.supabase.co/**', async route => {
  const url = route.request().url();
  let data;
  if (url.endsWith('/rpc/get_queue')) data = queue;
  else if (url.endsWith('/functions/v1/admin-queue')) {
    if (route.request().headers()['x-admin-key'] !== adminKey) return route.fulfill({ status: 401, json: { error: 'Invalid link' } });
    const body = route.request().postDataJSON();
    if (body.action === 'verify') return route.fulfill({ json: { admin: true } });
    assert.equal(body.action, 'save_order');
    assert.equal(body.expected_revision, queue.revision);
    queue.tickets.sort((a, b) => body.ticket_keys.indexOf(a.ticket_key) - body.ticket_keys.indexOf(b.ticket_key));
    data = { revision: ++queue.revision }; orderSaved = true;
  } else throw new Error(`Unexpected route ${url}`);
  await route.fulfill({ json: data });
});
try {
  await page.goto(base);
  await page.locator('.ticket').first().waitFor();
  assert.equal(await page.locator('#admin-toolbar').isVisible(), false);
  await page.goto(`${base}/?admin=true`);
  await page.getByText('This admin link is invalid or has expired.', { exact: false }).waitFor();
  assert.equal(await page.locator('#admin-toolbar').isVisible(), false);
  await page.goto(`${base}/?admin=${adminKey}`);
  await page.locator('#admin-toolbar').waitFor({ state: 'visible' });
  assert.equal(page.url().includes(adminKey), false);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy team link' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${base}/`);
  await page.getByRole('button', { name: 'Move SP-2 up' }).click();
  assert.equal(await page.locator('.ticket').first().getAttribute('data-key'), 'SP-2');
  await page.getByRole('button', { name: 'Save order', exact: true }).click();
  await page.getByText('Order saved. Everyone with the team link can see it.').waitFor();
  assert.ok(orderSaved);
  await page.reload();
  await page.locator('.ticket').first().waitFor();
  assert.equal(await page.locator('.ticket').first().getAttribute('data-key'), 'SP-2');
  await page.locator('#admin-toolbar').waitFor({ state: 'visible' });
  await page.goto(base);
  await page.locator('.ticket').first().waitFor();
  assert.equal(await page.locator('#admin-toolbar').isVisible(), false);
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
  console.log('Browser checks passed: public viewing, private admin link, invalid key rejection, clean team link, save/reload, drag-and-drop, mobile layout.');
} finally { await browser.close(); }
