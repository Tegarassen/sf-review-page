import { cors, json, matchesSecret, serviceConfig } from '../_shared/access.ts';
import { inspectBoardStatuses } from '../_shared/sync.mjs';

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!await matchesSecret(req.headers.get('x-admin-key'), 'ADMIN_ACCESS_KEY')) {
    return json({ error: 'A valid private admin link is required.' }, 401);
  }
  try {
    const raw = await req.text();
    if (raw.length > 65536) return json({ error: 'Request too large' }, 413);
    const body = JSON.parse(raw || '{}');
    if (body.action === 'verify') return json({ admin: true });
    if (body.action === 'inspect_jira_statuses') {
      try { return json(await inspectBoardStatuses(Deno.env.toObject())); }
      catch (error) { return json({ error: error instanceof Error ? error.message : 'Could not inspect board statuses.' }, 502); }
    }
    if (!Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0) return json({ error: 'Invalid revision' }, 400);
    let rpc: string, args: Record<string, unknown>;
    if (body.action === 'save_order') {
      if (!Array.isArray(body.ticket_keys) || body.ticket_keys.length > 5000 || body.ticket_keys.some((k: unknown) => typeof k !== 'string' || !/^SP-\d+$/.test(k))) {
        return json({ error: 'Invalid ticket order' }, 400);
      }
      rpc = 'save_order'; args = { ticket_keys: body.ticket_keys, expected_revision: body.expected_revision };
    } else if (body.action === 'set_pr_links') {
      if (typeof body.issue_key !== 'string' || !/^SP-\d+$/.test(body.issue_key) ||
          (body.urls !== null && (!Array.isArray(body.urls) || body.urls.length > 20 || body.urls.some((u: unknown) => typeof u !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(u))))) {
        return json({ error: 'Invalid PR links' }, 400);
      }
      rpc = 'set_pr_links'; args = { issue_key: body.issue_key, urls: body.urls, expected_revision: body.expected_revision };
    } else return json({ error: 'Unknown action' }, 400);
    const { base, headers } = serviceConfig();
    const result = await fetch(`${base}/rest/v1/rpc/${rpc}`, {
      method: 'POST', headers, body: JSON.stringify(args), signal: AbortSignal.timeout(15000),
    });
    const data = await result.json();
    if (!result.ok) return data?.code === '40001'
      ? json({ error: 'Queue changed. Reload before saving.', code: '40001' }, 409)
      : json({ error: 'Unable to save this change. Refresh the queue and retry.' }, 400);
    return json({ revision: data });
  } catch { return json({ error: 'Unable to process this request.' }, 400); }
});
