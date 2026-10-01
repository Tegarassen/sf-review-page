// Start Vite first with these PUBLIC, FAKE values:
// VITE_SUPABASE_URL=https://test.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_test npm run dev
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ ...(existsSync(chrome) ? { executablePath: chrome } : {}), headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 1050 } });
const page = await context.newPage();
// Keep UI checks independent of the external web-font service.
await page.route('https://fonts.googleapis.com/**', route => route.abort());
await page.route('https://fonts.gstatic.com/**', route => route.abort());
const errors = []; page.on('pageerror', e => errors.push(e.message));
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:5173';
const adminKey = 'browser-test-key-123456789012345678901234';
let queue = { revision: 1, last_synced_at: new Date().toISOString(), tickets: [
  { ticket_key: 'SP-1', short_title: 'First review ticket', jira_url: 'https://sharinpix.atlassian.net/browse/SP-1', pr_urls: ['https://github.com/example/repo/pull/5'], position: 1 },
  { ticket_key: 'SP-2', short_title: 'Second review ticket', jira_url: 'https://sharinpix.atlassian.net/browse/SP-2', pr_urls: [], urgency: 'normal', client_waiting: false, review_note: '', position: 2 },
] };
let orderSaved = false;
await page.route('https://test.supabase.co/**', async route => {
  const url = route.request().url();
  let data;
  if (url.endsWith('/rpc/get_queue')) data = queue;
  else if (url.endsWith('/rpc/set_pr_links') || url.endsWith('/rpc/set_review_context')) {
    const body = route.request().postDataJSON();
    if (body.expected_revision !== queue.revision) return route.fulfill({ status: 409, json: { code: '40001', message: 'Queue changed' } });
    const ticket = queue.tickets.find(t => t.ticket_key === body.issue_key);
    if (url.endsWith('/rpc/set_pr_links')) ticket.pr_urls = body.urls || [];
    else Object.assign(ticket, { urgency: body.urgency, client_waiting: body.client_waiting, review_note: body.review_note });
    data = ++queue.revision;
  }
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
  // Team members can collaborate without an admin key.
  await page.locator('[data-links="SP-2"]').click();
  await page.locator('#pr-input').fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'Save links', exact: true }).click();
  assert.match(await page.locator('#links-error').textContent(), /valid https/);
  await page.locator('#pr-input').fill('https://github.com/example/repo/pull/42');
  await page.getByRole('button', { name: 'Save links', exact: true }).click();
  await page.getByRole('link', { name: 'PR #42' }).waitFor();
  await page.locator('[data-context="SP-2"]').click();
  await page.getByLabel('Urgent', { exact: true }).check();
  await page.getByLabel('Client waiting', { exact: true }).check();
  const note = 'Client waiting. Please review today. <script>alert(1)</script>';
  await page.locator('#review-note').fill(note);
  await page.getByRole('button', { name: 'Save priority & note', exact: true }).click();
  await page.locator('.ticket.urgency-urgent.client-waiting').waitFor();
  assert.equal(await page.locator('.review-note p').textContent(), note);
  assert.equal(await page.locator('.review-note script').count(), 0);
  assert.match(await page.locator('#attention-summary').textContent(), /1 urgent.*1 client waiting/);
  assert.equal(await page.locator('.ticket').first().getAttribute('data-key'), 'SP-2');
  assert.equal(await page.locator('.focus-list .ticket').count(), 1);
  assert.equal(await page.locator('.remaining-list .ticket').getAttribute('data-key'), 'SP-1');
  assert.equal(await page.locator('.remaining-list .next-badge').count(), 0);
  assert.deepEqual(queue.tickets.map(t => t.ticket_key), ['SP-1', 'SP-2']);
  await page.reload();
  await page.locator('.ticket.urgency-urgent').waitFor();
  // Another user's edit must not be silently overwritten.
  await page.locator('[data-context="SP-2"]').click();
  await page.locator('#review-note').fill('Keep this draft');
  queue.revision++;
  await page.getByRole('button', { name: 'Save priority & note', exact: true }).click();
  await page.getByText('The queue changed while you were editing.', { exact: false }).waitFor();
  assert.equal(await page.locator('#review-note').inputValue(), 'Keep this draft');
  assert.equal(queue.tickets[1].review_note, note);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.locator('[data-context="SP-2"]').click();
  await page.getByLabel('Normal', { exact: true }).check();
  await page.getByLabel('Client waiting', { exact: true }).uncheck();
  await page.locator('#review-note').fill('');
  await page.getByRole('button', { name: 'Save priority & note', exact: true }).click();
  await page.locator('#context-dialog').waitFor({ state: 'hidden' });
  await page.locator('.ticket.urgency-urgent').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#attention-summary').isVisible(), false);
  assert.equal(await page.locator('.focus-list .ticket').count(), 0);
  assert.equal(await page.locator('.remaining-list .ticket').count(), 2);
  await page.locator('.focus-empty').waitFor();
  // A waiting client alone is enough to promote a normal-priority ticket.
  await page.locator('[data-context="SP-2"]').click();
  await page.getByLabel('Client waiting', { exact: true }).check();
  await page.getByRole('button', { name: 'Save priority & note', exact: true }).click();
  await page.locator('.focus-list .ticket.urgency-normal.client-waiting').waitFor();
  await page.locator('[data-context="SP-2"]').click();
  await page.getByLabel('Client waiting', { exact: true }).uncheck();
  await page.locator('#review-note').fill('Context only; no urgency.');
  await page.getByRole('button', { name: 'Save priority & note', exact: true }).click();
  await page.locator('.focus-list .ticket').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.remaining-list .ticket').count(), 2);
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
  const keys = selector => page.locator(selector).evaluateAll(rows => rows.map(row => row.dataset.key));
  assert.deepEqual(await keys('.focus-list .ticket'), ['SP-1002', 'SP-1003']);
  assert.deepEqual(await keys('.remaining-list .ticket'), ['SP-1001', 'SP-1004']);
  assert.equal(await page.getByRole('button', { name: 'Move SP-1002 up' }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Move SP-1003 down' }).isDisabled(), true);
  await page.locator('.ticket[data-key="SP-1004"]').dragTo(page.locator('.ticket[data-key="SP-1002"]'));
  assert.deepEqual(await keys('.focus-list .ticket'), ['SP-1002', 'SP-1003']);
  assert.equal(await page.getByRole('button', { name: 'Save order', exact: true }).isDisabled(), true);
  await page.locator('.ticket[data-key="SP-1004"]').dragTo(page.locator('.ticket[data-key="SP-1001"]'));
  assert.deepEqual(await keys('.remaining-list .ticket'), ['SP-1004', 'SP-1001']);
  await page.getByRole('button', { name: 'Move SP-1003 up' }).click();
  assert.deepEqual(await keys('.focus-list .ticket'), ['SP-1003', 'SP-1002']);
  await page.getByRole('button', { name: 'Move SP-1002 up' }).click();
  assert.deepEqual(await keys('.focus-list .ticket'), ['SP-1002', 'SP-1003']);
  assert.deepEqual(await keys('.remaining-list .ticket'), ['SP-1004', 'SP-1001']);
  assert.equal(await page.locator('.ticket').count(), 4);
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.ticket.urgency-urgent').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/mobile.png' });
  await page.getByRole('button', { name: 'Save order', exact: true }).click();
  await page.locator('[data-context="SP-1002"]').click();
  await page.locator('#context-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.getByLabel('Urgent', { exact: true }).isChecked(), true);
  assert.equal(await page.getByLabel('Client waiting', { exact: true }).isChecked(), true);
  const dialogBounds = await page.locator('#context-dialog').boundingBox();
  assert.ok(dialogBounds.x >= 0 && dialogBounds.x + dialogBounds.width <= 390);
  await page.screenshot({ path: 'test-results/mobile-editor.png' });
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: focus grouping, promotion/demotion, group reordering, public link/context editing, unsafe link rejection, safe note rendering, conflict draft preservation, clearing highlights, private admin link, invalid key rejection, clean team link, save/reload, drag-and-drop, mobile layout.');
} finally { await browser.close(); }
