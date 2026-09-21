import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBoardIssues, inspectBoardStatuses, inspectReviewScope, matchPrs, runSync, shortTitle } from '../supabase/functions/_shared/sync.mjs';

test('PR matching respects issue-key boundaries and rejects unsafe URLs', () => {
  const prs = [
    { title: 'SP-10 fix', html_url: 'https://github.com/example/repo/pull/1' },
    { title: '[SP-1] fix', html_url: 'https://github.com/example/repo/pull/2' },
    { head: { ref: 'feature/sp-1-upload' }, html_url: 'https://github.com/example/repo/pull/3' },
    { body: 'SP-1', html_url: 'javascript:alert(1)' },
  ];
  assert.deepEqual(matchPrs('SP-1', prs), ['https://github.com/example/repo/pull/2', 'https://github.com/example/repo/pull/3']);
  assert.equal(shortTitle('  One\n title '), 'One title');
  assert.equal([...shortTitle('😀'.repeat(120))].length, 100);
});

test('Jira pagination reads every page and rejects repeated or incomplete pages', async () => {
  const calls = [];
  const pages = [{ issues: [{ key: 'SP-1' }], nextPageToken: 'next' }, { issues: [{ key: 'SP-2' }], isLast: true }];
  const result = await getBoardIssues(async url => { calls.push(url); return pages.shift(); }, 'https://example.com', '45', ['3']);
  assert.equal(result.length, 2); assert.match(calls[1], /nextPageToken=next/);
  await assert.rejects(getBoardIssues(async () => ({ issues: [], nextPageToken: 'same' }), 'https://example.com', '45', ['3']), /pagination/);
  await assert.rejects(getBoardIssues(async () => ({ issues: [], isLast: false }), 'https://example.com', '45', ['3']), /pagination/);
  await assert.rejects(getBoardIssues(async () => ({ issues: [], total: 2 }), 'https://example.com', '45', ['3']), /Incomplete/);
});

const env = { JIRA_EMAIL: 'test@example.com', JIRA_API_TOKEN: 'test-token', JIRA_CLOUD_ID: 'test-cloud',
  JIRA_REVIEW_STATUS_IDS: '7', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'test-secret' };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
test('Review scope diagnostics request only filtering fields and never publish tickets or credentials', async () => {
  const result = await inspectReviewScope(env, async (url, options) => {
    assert.equal(options.method, undefined);
    if (url.endsWith('/board/45')) return response({ id: 45, name: 'Salesforce', type: 'kanban' });
    const params = new URL(url).searchParams;
    assert.equal(params.get('fields'), 'status,resolution,fixVersions,sprint');
    assert.match(params.get('jql'), /status in \(7\)/);
    return response({ isLast: true, issues: [{ key: 'SP-1', fields: {
      summary: 'PRIVATE TITLE', status: { id: '7' }, resolution: null,
      fixVersions: [{ name: 'PRIVATE RELEASE', released: true, archived: false }],
    } }] });
  });
  assert.deepEqual(result.tickets, [{ key: 'SP-1', status_id: '7', resolved: false,
    versions: [{ released: true, archived: false }], sprint_state: null }]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|test-token/);
});
test('Status inspection uses only board reads, returns status IDs, and never reads configuration or writes', async () => {
  const result = await inspectBoardStatuses(env, async (url, options) => {
    assert.equal(options.method, undefined);
    if (url.endsWith('/board/45')) return response({ id: 45 });
    assert.ok(url.includes('/rest/software/'));
    const params = new URL(url).searchParams;
    assert.equal(params.get('fields'), 'status');
    assert.equal(params.get('jql'), 'project = SP');
    return response({ isLast: true, issues: [
      { key: 'SP-1', fields: { status: { id: '7', name: 'Review' }, summary: 'Do not return title' } },
      { key: 'SP-2', fields: { status: { id: '7', name: 'Review' } } },
      { key: 'SP-3', fields: { status: { id: '8', name: 'Ready' } } },
    ] });
  });
  assert.deepEqual(result.statuses.find(s => s.id === '7'), { id: '7', name: 'Review', count: 2, ticket_keys: ['SP-1', 'SP-2'] });
  assert.doesNotMatch(JSON.stringify(result), /Do not return title/);
});
test('Sync sends only allowed minimal fields, via a server-side scoped-token URL', async () => {
  let payload;
  const result = await runSync(env, async (url, options) => {
    if (url.includes('/rest/agile')) { assert.match(url, /api.atlassian.com\/ex\/jira\/test-cloud/); return response({ id: 45 }); }
    if (url.includes('/rest/software')) return response({ isLast: true, issues: [{ key: 'SP-1', id: '123', fields: {
      summary: 'Short title', status: { id: '7' }, description: 'DO NOT PUBLISH', assignee: { emailAddress: 'private@example.com' },
    } }] });
    if (url.endsWith('/rpc/sync_review_queue')) { payload = JSON.parse(options.body); return response(null); }
    throw new Error('Unexpected request');
  });
  assert.equal(result.count, 1);
  assert.deepEqual(Object.keys(payload.items[0]).sort(), ['jira_url', 'pr_urls', 'short_title', 'ticket_key']);
  assert.equal(payload.items[0].pr_urls, null);
  assert.doesNotMatch(JSON.stringify(payload), /DO NOT PUBLISH|private@example/);
});
test('Failed Jira fetch never replaces the saved queue', async () => {
  let wrote = false;
  await assert.rejects(runSync(env, async url => {
    if (url.includes('supabase.co')) { wrote = true; return response(null); }
    if (url.includes('/rest/agile')) return response({ id: 45 });
    return response({ error: 'denied' }, 403);
  }), /HTTP 403/);
  assert.equal(wrote, false);
});
test('Kanban sync includes the release subfilter on every page and uses only open Jira PR links', async () => {
  let payload;
  const result = await runSync({ ...env, JIRA_HIDE_RELEASED: 'true', JIRA_DEV_STATUS: 'true' }, async (url, options) => {
    if (url.endsWith('/board/45')) return response({ id: 45 });
    if (url.includes('/rest/software/')) {
      const params = new URL(url).searchParams;
      assert.equal(params.get('jql'), 'project = SP AND status in (7) AND (fixVersion in unreleasedVersions() OR fixVersion is EMPTY) ORDER BY priority DESC, created ASC');
      if (!params.has('nextPageToken')) return response({ issues: [], nextPageToken: 'next' });
      return response({ isLast: true, issues: [{ id: '123', key: 'SP-1', fields: { summary: 'Review', status: { id: '7' } } }] });
    }
    if (url.includes('/issue/summary')) return response({ summary: { pullrequest: { byInstanceType: { GitHub: {} } } } });
    if (url.includes('/issue/detail')) return response({ detail: [{ pullRequests: [
      { status: 'OPEN', url: 'https://github.com/example/repo/pull/1' },
      { status: 'MERGED', url: 'https://github.com/example/repo/pull/2' },
      { status: 'OPEN', url: 'javascript:alert(1)' },
    ] }] });
    if (url.endsWith('/rpc/sync_review_queue')) { payload = JSON.parse(options.body); return response(null); }
    throw new Error('Unexpected request');
  });
  assert.deepEqual(payload.items[0].pr_urls, ['https://github.com/example/repo/pull/1']);
  assert.equal(result.prLookupFailures, 0);
});
test('Missing column mapping fails instead of guessing a similarly named Jira status', async () => {
  await assert.rejects(runSync({ ...env, JIRA_REVIEW_STATUS_IDS: '' }, async url => {
    if (url.includes('/configuration')) return response({ columnConfig: { columns: [{ name: 'In Progress', statuses: [{ id: '3' }] }] } });
    if (url.includes('/rest/agile')) return response({ id: 45 });
    throw new Error('Must not write');
  }), /No valid REVIEW status IDs/);
});
