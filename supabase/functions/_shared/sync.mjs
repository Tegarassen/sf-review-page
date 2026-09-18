import { Buffer } from 'node:buffer';

export const validPrUrl = value => typeof value === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(value);
export const shortTitle = value => [...String(value || '').replace(/\s+/g, ' ').trim()].slice(0, 100).join('');
export function matchPrs(issueKey, prs) {
  const pattern = new RegExp(`(^|[^A-Z0-9])${issueKey}(?=$|[^A-Z0-9])`, 'i');
  return [...new Set(prs.filter(pr => pattern.test([pr.title, pr.body, pr.head?.ref].join(' ')))
    .map(pr => pr.html_url).filter(validPrUrl))].slice(0, 20);
}

export async function requestJson(url, options = {}, fetcher = fetch) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (response.ok) return response.status === 204 ? null : response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const delay = Math.min(30, Math.max(1, Number(response.headers.get('retry-after')) || 2 ** attempt));
      await new Promise(resolve => setTimeout(resolve, delay * 1000)); continue;
    }
    // Do not include provider response bodies, headers, tokens, or private issue data in logs.
    throw new Error(`${new URL(url).hostname}: HTTP ${response.status}. Check access, scopes and configuration.`);
  }
}

export async function getBoardIssues(jira, base, boardId, statusIds) {
  const issues = []; const seen = new Set(); let pageToken;
  for (let page = 0; page < 1000; page++) {
    const params = new URLSearchParams({ maxResults: '100', fields: 'summary,status,priority,created',
      jql: `project = SP AND status in (${statusIds.join(',')}) ORDER BY priority DESC, created ASC` });
    if (pageToken) params.set('nextPageToken', pageToken);
    const result = await jira(`${base}/rest/software/1.0/board/${boardId}/issue?${params}`);
    if (!Array.isArray(result.issues)) throw new Error('Invalid Jira issue response. Existing queue was not changed.');
    issues.push(...result.issues);
    if (result.isLast === true || (!result.nextPageToken && result.isLast !== false)) {
      if (result.total != null && issues.length !== result.total) throw new Error('Incomplete Jira response. Existing queue was not changed.');
      return issues;
    }
    if (!result.nextPageToken || seen.has(result.nextPageToken)) throw new Error('Jira pagination stopped unexpectedly. Existing queue was not changed.');
    pageToken = result.nextPageToken; seen.add(pageToken);
  }
  throw new Error('Jira page limit exceeded. Existing queue was not changed.');
}

export async function runSync(env, fetcher = fetch) {
  const required = ['JIRA_EMAIL', 'JIRA_API_TOKEN', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY'];
  for (const name of required) if (!env[name]) throw new Error(`Missing ${name}.`);
  const site = (env.JIRA_SITE || 'https://sharinpix.atlassian.net').replace(/\/$/, '');
  if (site !== 'https://sharinpix.atlassian.net') throw new Error('This app is configured for sharinpix.atlassian.net only.');
  const cloudId = env.JIRA_CLOUD_ID;
  if (cloudId && !/^[a-zA-Z0-9-]+$/.test(cloudId)) throw new Error('Invalid JIRA_CLOUD_ID.');
  const base = cloudId ? `https://api.atlassian.com/ex/jira/${cloudId}` : site;
  const boardId = env.JIRA_BOARD_ID || '45';
  if (!/^\d+$/.test(boardId)) throw new Error('Invalid JIRA_BOARD_ID.');
  const authorization = `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64')}`;
  const jira = address => requestJson(address, { headers: { authorization, accept: 'application/json' } }, fetcher);
  // Verify board access explicitly. Some issue endpoints return an empty list without board access.
  const board = await jira(`${base}/rest/agile/1.0/board/${boardId}`);
  if (String(board.id) !== boardId) throw new Error('Could not verify Jira board access.');
  let statusIds = (env.JIRA_REVIEW_STATUS_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!statusIds.length) {
    let configuration;
    try { configuration = await jira(`${base}/rest/agile/1.0/board/${boardId}/configuration`); }
    catch { throw new Error('Cannot read board column mapping. Add read:board-scope.admin:jira-software and read:project:jira scopes, or set verified JIRA_REVIEW_STATUS_IDS. Existing queue was not changed.'); }
    const column = configuration.columnConfig?.columns?.find(c => c.name.toLowerCase() === (env.JIRA_REVIEW_COLUMN || 'REVIEW').toLowerCase());
    statusIds = (column?.statuses || []).map(s => String(s.id));
  }
  if (!statusIds.length || statusIds.some(s => !/^\d+$/.test(s))) throw new Error('No valid REVIEW status IDs. Existing queue was not changed.');
  const issues = await getBoardIssues(jira, base, boardId, statusIds);
  if (issues.some(i => !/^SP-\d+$/.test(i.key) || !statusIds.includes(String(i.fields?.status?.id)))) throw new Error('Jira returned issues outside the configured queue.');
  if (new Set(issues.map(i => i.key)).size !== issues.length) throw new Error('Jira returned duplicate tickets. Existing queue was not changed.');

  let githubPrs = null;
  const repositories = (env.GH_REPOSITORIES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (repositories.length) {
    if (!env.GH_READ_TOKEN) throw new Error('Set GH_READ_TOKEN to read the configured private repositories.');
    githubPrs = [];
    for (const repo of repositories) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('GH_REPOSITORIES must contain owner/repository names.');
      for (let page = 1; page <= 100; page++) {
        const prs = await requestJson(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=100&page=${page}`, {
          headers: { authorization: `Bearer ${env.GH_READ_TOKEN}`, accept: 'application/vnd.github+json' },
        }, fetcher);
        if (!Array.isArray(prs)) throw new Error('Invalid GitHub pull request response.');
        githubPrs.push(...prs);
        if (prs.length < 100) break;
        if (page === 100) throw new Error('GitHub pagination limit exceeded. Existing queue was not changed.');
      }
    }
  }
  const items = [];
  let prLookupFailures = 0;
  for (const issue of issues) {
    let urls = githubPrs === null ? null : matchPrs(issue.key, githubPrs);
    if (env.JIRA_DEV_STATUS === 'true') {
      // Explicit opt-in: this is Jira's internal API and may be blocked or change without notice.
      try {
        if (!/^\d+$/.test(String(issue.id))) throw new Error('Invalid issue ID.');
        const summary = await jira(`${base}/rest/dev-status/latest/issue/summary?issueId=${issue.id}`);
        if (summary.errors?.length || !summary.summary?.pullrequest) throw new Error('Development summary unavailable.');
        const types = Object.keys(summary.summary.pullrequest.byInstanceType || {});
        const developmentUrls = [];
        for (const type of types) {
          const params = new URLSearchParams({ issueId: issue.id, applicationType: type, dataType: 'pullrequest' });
          const details = await jira(`${base}/rest/dev-status/latest/issue/detail?${params}`);
          if (details.errors?.length || !Array.isArray(details.detail)) throw new Error('Development detail unavailable.');
          for (const detail of details.detail) for (const pr of detail.pullRequests || []) {
            if (pr.status === 'OPEN' && validPrUrl(pr.url)) developmentUrls.push(pr.url);
          }
        }
        urls = [...new Set([...(urls || []), ...developmentUrls])].slice(0, 20);
      } catch { prLookupFailures++; }
    }
    items.push({ ticket_key: issue.key, short_title: shortTitle(issue.fields.summary),
      jira_url: `${site}/browse/${issue.key}`, pr_urls: urls });
  }
  const sbUrl = env.SUPABASE_URL.replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(sbUrl)) throw new Error('Use your hosted Supabase project URL.');
  const headers = { apikey: env.SUPABASE_SECRET_KEY, 'content-type': 'application/json' };
  if (env.SUPABASE_SECRET_KEY.startsWith('eyJ')) headers.authorization = `Bearer ${env.SUPABASE_SECRET_KEY}`;
  await requestJson(`${sbUrl}/rest/v1/rpc/sync_review_queue`, { method: 'POST', headers, body: JSON.stringify({ items }) }, fetcher);
  return { count: items.length, prLookupFailures, automaticPrSource: githubPrs !== null || env.JIRA_DEV_STATUS === 'true' };
}
