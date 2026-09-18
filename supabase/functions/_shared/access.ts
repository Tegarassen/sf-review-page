export const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') || '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-admin-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
export async function matchesSecret(value: string | null, name: string) {
  const expected = Deno.env.get(name);
  if (!value || !expected || expected.length < 32 || value.length > 512) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([digest(value), digest(expected)]);
  return x.reduce((diff, n, i) => diff | (n ^ y[i]), 0) === 0;
}
export function serviceConfig() {
  const base = Deno.env.get('SUPABASE_URL');
  const key = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !key) throw new Error('Supabase backend keys are not configured.');
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  return { base, key, headers };
}
