import { runSync } from '../_shared/sync.mjs';
import { cors, json, matchesSecret, serviceConfig } from '../_shared/access.ts';

// Gateway JWT verification is disabled to allow a separate scheduler secret.
// Every POST requires the private admin link key or a separate scheduler secret.
Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const authorized = await matchesSecret(req.headers.get('x-admin-key'), 'ADMIN_ACCESS_KEY') ||
    await matchesSecret(req.headers.get('x-sync-secret'), 'SYNC_SECRET');
  if (!authorized) return json({ error: 'A valid private admin link is required.' }, 401);
  const { base, key: serviceKey, headers: serviceHeaders } = serviceConfig();
  let lease: string | null = null;
  try {
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
