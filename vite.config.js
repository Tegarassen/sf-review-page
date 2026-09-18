import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (key && !key.includes('REPLACE_ME')) {
    let isAnon = false;
    try { isAnon = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'anon'; } catch {}
    if (!key.startsWith('sb_publishable_') && !isAnon) {
      throw new Error('Frontend key must be a Supabase publishable key (or legacy anon key). Secret/service-role keys must never be built into the page.');
    }
  }
  return { base: './' };
});
