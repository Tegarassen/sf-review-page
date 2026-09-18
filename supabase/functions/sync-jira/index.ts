import { runSync } from '../_shared/sync.mjs';

const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') || '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
async function constantTimeEqual(a: string, b: string) {
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  return x.reduce((diff, n, i) => diff | (n ^ y[i]), 0) === 0;
}

// Gateway JWT verification is disabled to allow a separate scheduler secret.
// Every POST is authenticated HERE before any secret-bearing Jira request is made.
Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const base = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const publicKey = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}').default || Deno.env.get('SUPABASE_ANON_KEY');
  if (!base || !serviceKey || !publicKey) return json({ error: 'Supabase function keys are not configured.' }, 503);
  const serviceHeaders: Record<string, string> = { apikey: serviceKey, 'Content-Type': 'application/json' };
  if (serviceKey.startsWith('eyJ')) serviceHeaders.authorization = `Bearer ${serviceKey}`;
  let lease: string | null = null;
  try {
    const schedulerToken = req.headers.get('x-sync-secret');
    const expected = Deno.env.get('SYNC_SECRET');
    const scheduled = schedulerToken && expected && await constantTimeEqual(schedulerToken, expected);
    if (!scheduled) {
      const authorization = req.headers.get('authorization') || '';
      if (!authorization.startsWith('Bearer ')) return json({ error: 'Admin sign-in required' }, 401);
      const userResponse = await fetch(`${base}/auth/v1/user`, {
        headers: { apikey: publicKey, authorization },
      });
      if (!userResponse.ok) return json({ error: 'Admin sign-in required' }, 401);
      const user = await userResponse.json();
      if (!user.id) return json({ error: 'Admin sign-in required' }, 401);
      const admins = await fetch(`${base}/rest/v1/queue_admins?select=user_id&user_id=eq.${encodeURIComponent(user.id)}`, { headers: serviceHeaders });
      if (!admins.ok || !(await admins.json()).length) return json({ error: 'Admin access required' }, 403);
    }
    const claim = await fetch(`${base}/rest/v1/rpc/claim_sync`, { method: 'POST', headers: serviceHeaders, body: '{}' });
    if (!claim.ok) throw new Error('Could not acquire sync lock. Apply the database migration first.');
    lease = await claim.json();
    if (!lease) return json({ error: 'A sync is already running. Try again shortly.' }, 409);
    const env = { ...Deno.env.toObject(), SUPABASE_SECRET_KEY: serviceKey };
    const result = await runSync(env);
    return json(result);
  } catch (error) {
    // Error messages from the shared connector never include provider response bodies or secrets.
    return json({ error: error instanceof Error ? error.message : 'Sync failed. Existing queue retained.' }, 502);
  } finally {
    if (lease) await fetch(`${base}/rest/v1/rpc/release_sync`, {
      method: 'POST', headers: serviceHeaders, body: JSON.stringify({ lease }),
    }).catch(() => {});
  }
});
