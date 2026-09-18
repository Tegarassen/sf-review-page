import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Edge endpoint authenticates callers before Jira access and releases its lease', async () => {
  const originalFetch = globalThis.fetch;
  let handler;
  const env = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_test' }),
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'sb_publishable_test' }),
    JIRA_EMAIL: 'test@example.com', JIRA_API_TOKEN: 'not-real',
    JIRA_REVIEW_STATUS_IDS: '7', SYNC_SECRET: 'scheduler-test-secret-1234567890123456',
    ADMIN_ACCESS_KEY: 'admin-test-key-123456789012345678901234',
  };
  globalThis.Deno = { env: { get: k => env[k], toObject: () => ({ ...env }) }, serve: h => { handler = h; } };
  await import('../supabase/functions/sync-jira/index.ts');
  let calls = [], released = false, locked = false;
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/claim_sync')) return json(locked ? null : 'lease-123');
    if (url.endsWith('/release_sync')) { released = true; assert.equal(JSON.parse(options.body).lease, 'lease-123'); return json(null); }
    if (url.endsWith('/board/45')) return json({ id: 45 });
    if (url.includes('/rest/software')) return json({ issues: [], isLast: true });
    if (url.endsWith('/sync_review_queue')) return json(null);
    throw new Error('Unexpected call');
  };
  const request = headers => new Request('https://example.supabase.co/functions/v1/sync-jira', { method: 'POST', headers });
  try {
    assert.equal((await handler(request({}))).status, 401); assert.equal(calls.length, 0);
    assert.equal((await handler(request({ 'x-sync-secret': 'wrong' }))).status, 401); assert.equal(calls.length, 0);
    assert.equal((await handler(request({ 'x-admin-key': 'true' }))).status, 401);
    assert.equal(calls.some(u => u.includes('atlassian')), false);
    calls = [];
    assert.equal((await handler(request({ 'x-admin-key': env.ADMIN_ACCESS_KEY }))).status, 200);
    assert.equal(released, true); assert.equal(calls.some(u => u.includes('atlassian')), true);
    calls = []; locked = true;
    assert.equal((await handler(request({ 'x-sync-secret': env.SYNC_SECRET }))).status, 409);
    assert.equal(calls.some(u => u.includes('atlassian')), false);
  } finally { globalThis.fetch = originalFetch; delete globalThis.Deno; }
});

test('Admin writes require the private key, validate inputs and preserve conflict errors', async () => {
  const originalFetch = globalThis.fetch;
  let handler, calls = 0, conflict = false;
  const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_test' }), ADMIN_ACCESS_KEY: 'test-admin-key-1234567890123456789012345' };
  globalThis.Deno = { env: { get: k => env[k] }, serve: h => { handler = h; } };
  await import('../supabase/functions/admin-queue/index.ts');
  globalThis.fetch = async (url, options) => {
    calls++; assert.ok(url.endsWith('/rpc/save_order'));
    assert.equal(options.headers.apikey, 'sb_secret_test');
    assert.equal(JSON.parse(options.body).expected_revision, 1);
    return new Response(JSON.stringify(conflict ? { code: '40001' } : 2), { status: conflict ? 409 : 200 });
  };
  const request = (key, body) => new Request('https://example.supabase.co/functions/v1/admin-queue', { method: 'POST', headers: { 'x-admin-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await handler(request('true', { action: 'verify' }))).status, 401);
    assert.equal((await handler(request('wrong-key', { action: 'save_order', ticket_keys: [], expected_revision: 1 }))).status, 401);
    assert.equal(calls, 0);
    assert.equal((await handler(request(env.ADMIN_ACCESS_KEY, { action: 'verify' }))).status, 200);
    assert.equal(calls, 0);
    assert.equal((await handler(request(env.ADMIN_ACCESS_KEY, { action: 'set_pr_links', issue_key: 'SP-1', urls: ['javascript:alert(1)'], expected_revision: 1 }))).status, 400);
    assert.equal(calls, 0);
    const body = { action: 'save_order', ticket_keys: ['SP-1'], expected_revision: 1 };
    assert.equal((await handler(request(env.ADMIN_ACCESS_KEY, body))).status, 200);
    conflict = true;
    const response = await handler(request(env.ADMIN_ACCESS_KEY, body));
    assert.equal(response.status, 409); assert.equal((await response.json()).code, '40001');
    env.ADMIN_ACCESS_KEY = 'rotated-key-123456789012345678901234567';
    assert.equal((await handler(request('test-admin-key-1234567890123456789012345', { action: 'verify' }))).status, 401);
  } finally { globalThis.fetch = originalFetch; delete globalThis.Deno; }
});
