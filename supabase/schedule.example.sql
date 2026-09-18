-- Optional: run once AFTER deploying and testing sync-jira.
-- Put the same random SYNC_SECRET in Edge Function Secrets and Vault.
-- Replace placeholders. Do not commit a filled-in copy.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
select vault.create_secret('https://YOUR_PROJECT.supabase.co', 'review_queue_project_url');
select vault.create_secret('YOUR_RANDOM_SYNC_SECRET', 'review_queue_sync_secret');
select cron.schedule('review-queue-sync', '*/15 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'review_queue_project_url') || '/functions/v1/sync-jira',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'review_queue_sync_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
-- Inspect results in the Supabase Cron dashboard and Edge Function logs.
-- Disable later: select cron.unschedule('review-queue-sync');
