# sf-review-page

SharinPix Salesforce review queue.

GitHub Pages frontend + Supabase database, admin login, and Jira sync function.
The team sees the saved order, SP ticket keys, short titles (100 characters maximum), Jira
links, and GitHub PR links. These fields are intentionally public. Descriptions, comments,
personal details, code, and integration credentials never enter the public database.

Drag tickets or use the arrows, click **Save order**, and share the same URL. The team page
refreshes every 30 seconds. New tickets append after the saved order; tickets leaving REVIEW
disappear on successful sync. New tickets initially follow Jira priority and creation time.
Conflicting edits cannot silently overwrite each other.

## 1. Create Supabase project

Create `review-queue` at https://supabase.com/dashboard. Save the **database password** in a
password manager. It is separate from your review-page admin password and never enters the browser.

In **SQL Editor**, run `supabase/migrations/202609180001_review_queue.sql` once. It creates
the tables, row-level security, and functions. Alternatively use `supabase db push` after
CLI login/link. Do not apply the SQL manually and then push that same migration without
reconciling migration history.

## 2. Create the admin account

In **Authentication → Users → Add user → Create new user**, create your email/password
account and mark it confirmed. This avoids needing outgoing email/SMTP for initial setup.
Disable new public sign-ups in Auth settings. Run this in SQL Editor with your actual email:

```sql
insert into public.queue_admins (user_id)
select id from auth.users where lower(email) = lower('YOUR_ADMIN_EMAIL')
on conflict do nothing;
```

Verify the row appears in `queue_admins`. Do not put your password into SQL or source code.
Other authenticated users cannot grant themselves access. Delete that row to revoke admin access.

## 3. Deploy the Jira sync function

From this directory:

```sh
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy sync-jira --use-api
```

The CLI is already installed on this computer. `--use-api` bundles remotely without Docker.
Gateway JWT verification is disabled in config because the function supports either an
admin session or a scheduler credential. The function itself **always validates admin
membership or the scheduler secret** before making Jira requests.

In Supabase **Edge Functions → Secrets**, add:

| Secret | Value |
| --- | --- |
| `JIRA_EMAIL` | Your Atlassian login email |
| `JIRA_API_TOKEN` | Your API token |
| `JIRA_CLOUD_ID` | Cloud ID for scoped tokens |
| `ALLOWED_ORIGIN` | e.g. `https://YOUR_ORG.github.io`, without a repository path |

Defaults: `https://sharinpix.atlassian.net`, board `45`, column `REVIEW`.
Find the cloud ID at `https://sharinpix.atlassian.net/_edge/tenant_info` in your browser.
Scoped tokens call the Atlassian API gateway. For an unscoped token, omit `JIRA_CLOUD_ID`.

Ticket-read scopes:

- `read:board-scope:jira-software`
- `read:issue-details:jira`

Automatic column-to-status mapping additionally needs:

- `read:board-scope.admin:jira-software`
- `read:project:jira`

These are token scopes, not a change to your Jira role. Your account still needs permission
for the reads. If board configuration is unavailable, set `JIRA_REVIEW_STATUS_IDS` to the
verified underlying status IDs, comma-separated. The connector refuses to guess that the
REVIEW column is a status with the same name.

Alternatively copy `.env.edge.example` to `.env.edge`, fill it in locally, and run
`supabase secrets set --env-file .env.edge`. The file is ignored by Git. Supabase provides
the built-in `SUPABASE_` keys; do not set those manually or put them in frontend variables.

### GitHub PR links

The Development panel is separate from Jira's normal issue response. Options:

1. **Supported GitHub API:** set `GH_REPOSITORIES` to comma-separated `owner/repo` names and
   `GH_READ_TOKEN` to a fine-grained token with read-only Pull requests access to those repos.
   Organization approval/SSO may apply. Open PRs match ticket keys in title, body, or branch.
   This may not reproduce every association Jira has.
2. **Optional internal Jira API:** set `JIRA_DEV_STATUS=true` to try the Development-panel
   endpoint. It is not a supported public API, may reject scoped tokens, and needs testing
   with your account. Failures do not stop ticket sync.

Admins can always **Edit links** on the page. Manual links survive syncs; **Use synced links**
removes the override. Missing links display “PR link pending.” This version accepts github.com
PR URLs only.

## 4. Connect the frontend and publish

Get your **Project URL** and **publishable key** from the Supabase Connect dialog / API Keys.
The publishable key is designed to be public; database permissions control writes. Never use
the secret/service-role key in the browser.

Local preview:

```sh
npm ci
cp .env.example .env
# Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.
npm run dev
```

Without configuration the app shows a setup screen. `?demo` shows fictional tickets and
local-only ordering controls. For local admin sync, temporarily omit `ALLOWED_ORIGIN` or use
the local origin.

Push this directory to your repository's `main` branch. Under **Settings → Secrets and
variables → Actions → Variables**, set these two **public** variables:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`

Under **Settings → Pages**, choose **GitHub Actions** as the build source. The included
workflow tests, builds, and deploys the frontend only. Jira sync runs entirely in Supabase;
GitHub does not need your Jira token. Private repositories need a GitHub plan supporting
Pages for private repositories. This minimal page and its data are intentionally public.

Sign in as admin, **Sync Jira**, reorder, **Save order**, then **Copy team link**. Teammates
use their existing Jira/GitHub access when opening links. Truncation is not redaction:
the first 100 characters of each Jira title are public.

## 5. Optional automatic sync

After manual sync works, generate a random scheduler secret using your password manager.
Add it as `SYNC_SECRET` in Edge Function Secrets. Follow `supabase/schedule.example.sql` in
the SQL Editor, storing the same secret in Supabase Vault. This schedules sync every
15 minutes. The secret is not sent to the browser or stored in public tables.

Manual and scheduled sync share a 10-minute lease. Failed fetches leave the last saved queue
intact; a legitimately empty REVIEW column clears it. The page shows the last successful
sync and warns when it is over 45 minutes old. Inspect Cron and function logs for failures.

## Validation and limits

`npm test` checks permissions, unauthorized writes, stale edits, atomic saves, sync behavior,
PR overrides, pagination, and data minimization using PGlite and mocked providers.
`npm run build` produces `dist/`. `node tests/browser.mjs` tests the browser against a mocked
Supabase API with Vite running (test environment values are at the top of that file).
It uses installed Chrome or Playwright Chromium.

Live Jira/Supabase sync still needs credentials and cannot be verified by offline tests.
This version handles one small board. Other boards, GitHub Enterprise hosts, or private
team viewing would require extending the configuration and policies.

References: [Supabase keys](https://supabase.com/docs/guides/getting-started/api-keys),
[function secrets](https://supabase.com/docs/guides/functions/secrets),
[scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions),
[Jira board API](https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/).
