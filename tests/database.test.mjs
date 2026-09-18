import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const adminId = '10000000-0000-4000-8000-000000000001';
const memberId = '10000000-0000-4000-8000-000000000002';
const item = (n, urls = []) => ({ ticket_key: `SP-${n}`, short_title: `Ticket ${n}`, jira_url: `https://sharinpix.atlassian.net/browse/SP-${n}`, pr_urls: urls });

test('Database permissions, atomic saves, conflicts, sync and persistent overrides', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      -- Older hosted projects grant execute to API roles through default privileges.
      alter default privileges in schema public grant execute on functions to anon, authenticated;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;
      grant execute on function auth.uid() to anon, authenticated, service_role;
      insert into auth.users values ('${adminId}'), ('${memberId}');
    `);
    await db.exec(await readFile(new URL('../supabase/migrations/202609180001_review_queue.sql', import.meta.url), 'utf8'));
    await db.query('insert into public.queue_admins values ($1)', [adminId]);
    const sync = items => db.query('select public.sync_review_queue($1::jsonb)', [JSON.stringify(items)]);
    const snapshot = async () => (await db.query('select public.get_queue() as queue')).rows[0].queue;
    const role = async (name, id = '') => { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]); await db.exec(`set role ${name}`); };
    await role('service_role'); await sync([item(1), item(2)]);
    const lease = (await db.query('select public.claim_sync() as lease')).rows[0].lease;
    assert.ok(lease);
    assert.equal((await db.query('select public.claim_sync() as lease')).rows[0].lease, null);
    await db.query('select public.release_sync($1)', [memberId]);
    assert.equal((await db.query('select public.claim_sync() as lease')).rows[0].lease, null);
    await db.query('select public.release_sync($1)', [lease]);
    assert.ok((await db.query('select public.claim_sync() as lease')).rows[0].lease);
    await role('anon');
    assert.deepEqual((await snapshot()).tickets.map(t => t.ticket_key), ['SP-1', 'SP-2']);
    await assert.rejects(db.exec("update public.review_tickets set position = 99"), /permission denied/);
    await assert.rejects(db.exec('select * from public.queue_admins'), /permission denied/);
    await assert.rejects(db.query('select public.save_order($1, $2)', [['SP-2', 'SP-1'], 1]), /permission denied/);
    await assert.rejects(sync([]), /permission denied/);
    await assert.rejects(db.query('select public.claim_sync()'), /permission denied/);
    await role('authenticated', memberId);
    assert.equal((await db.exec('select * from public.queue_admins'))[0].rows.length, 0);
    await assert.rejects(db.query('select public.save_order($1, $2)', [['SP-2', 'SP-1'], 1]), /Admin access required/);
    await assert.rejects(db.query('insert into public.queue_admins values ($1)', [memberId]), /permission denied/);
    await assert.rejects(sync([]), /permission denied/);
    await role('authenticated', adminId);
    assert.equal((await db.exec('select * from public.queue_admins'))[0].rows.length, 1);
    await assert.rejects(db.query('select public.save_order($1, $2)', [['SP-1', 'SP-1'], 1]), /exactly once/);
    await assert.rejects(db.query('select public.save_order($1, $2)', [['SP-1'], 1]), /exactly once/);
    await assert.rejects(db.query('select public.save_order($1, $2)', [['SP-1', null], 1]), /exactly once/);
    await assert.rejects(db.query('select public.save_order($1, $2)', [['SP-1', 'SP-9'], 1]), /exactly once/);
    await db.query('select public.save_order($1, $2)', [['SP-2', 'SP-1'], 1]);
    assert.deepEqual((await snapshot()).tickets.map(t => t.ticket_key), ['SP-2', 'SP-1']);
    await assert.rejects(db.query('select public.save_order($1, $2)', [['SP-1', 'SP-2'], 1]), /Queue changed/);
    await assert.rejects(db.query('select public.set_pr_links($1, $2, $3)', ['SP-2', ['javascript:alert(1)'], 2]), /GitHub/);
    await db.query('select public.set_pr_links($1, $2, $3)', ['SP-2', ['https://github.com/example/repo/pull/5'], 2]);
    await role('service_role'); await sync([item(1), item(2, ['https://github.com/example/repo/pull/6']), item(3)]);
    await role('anon');
    let queue = await snapshot();
    assert.deepEqual(queue.tickets.map(t => t.ticket_key), ['SP-2', 'SP-1', 'SP-3']);
    assert.deepEqual(queue.tickets[0].pr_urls, ['https://github.com/example/repo/pull/5']);
    assert.equal(Object.hasOwn(queue.tickets[0], 'manual_pr_urls'), false);
    await role('authenticated', adminId);
    await db.query('select public.set_pr_links($1, $2, $3)', ['SP-2', null, queue.revision]);
    assert.deepEqual((await snapshot()).tickets[0].pr_urls, ['https://github.com/example/repo/pull/6']);
    await role('service_role');
    await assert.rejects(sync([item(1), { ...item(2), short_title: 'x'.repeat(101) }]), /check constraint/);
    await role('anon'); assert.equal((await snapshot()).tickets.length, 3);
    await role('service_role'); await sync([item(2, null), item(3)]);
    await role('anon'); queue = await snapshot();
    assert.deepEqual(queue.tickets.map(t => t.ticket_key), ['SP-2', 'SP-3']);
    assert.deepEqual(queue.tickets[0].pr_urls, ['https://github.com/example/repo/pull/6']);
    await role('service_role'); await sync([]);
    await role('anon'); assert.equal((await snapshot()).tickets.length, 0);
  } finally { await db.close(); }
});
