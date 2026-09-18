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
    JIRA_REVIEW_STATUS_IDS: '7', SYNC_SECRET: 'scheduler-test-secret',
  };
  globalThis.Deno = { env: { get: k => env[k], toObject: () => ({ ...env }) }, serve: h => { handler = h; } };
  await import('../supabase/functions/sync-jira/index.ts');
  let calls = [], permitted = false, released = false, locked = false;
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/auth/v1/user')) return json({ id: 'user-123' });
    if (url.includes('/queue_admins?')) return json(permitted ? [{ user_id: 'user-123' }] : []);
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
    assert.equal((await handler(request({ authorization: 'Bearer member' }))).status, 403);
    assert.equal(calls.some(u => u.includes('atlassian')), false);
    calls = []; permitted = true;
    assert.equal((await handler(request({ authorization: 'Bearer admin' }))).status, 200);
    assert.equal(released, true); assert.equal(calls.some(u => u.includes('atlassian')), true);
    calls = []; locked = true;
    assert.equal((await handler(request({ 'x-sync-secret': env.SYNC_SECRET }))).status, 409);
    assert.equal(calls.some(u => u.includes('atlassian')), false);
  } finally { globalThis.fetch = originalFetch; delete globalThis.Deno; }
});
