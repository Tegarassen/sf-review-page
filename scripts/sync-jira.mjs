import { runSync } from '../supabase/functions/_shared/sync.mjs';
runSync(process.env).then(result => {
  console.log(`Synced ${result.count} review tickets.`);
  if (!result.automaticPrSource) console.warn('No automatic PR source configured. Admin can add PR links on the page.');
  if (result.prLookupFailures) console.warn(`Development-panel lookup unavailable for ${result.prLookupFailures} tickets.`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
