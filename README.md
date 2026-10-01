# sf-review-page

SharinPix Salesforce review queue.

GitHub Pages frontend + Supabase database, private admin link, and Jira sync function.
The team sees the saved order, SP ticket keys, short titles (100 characters maximum), Jira
links, GitHub PR links, urgency, a client-waiting flag, and a short review note. These fields
are intentionally public. Jira descriptions and comments, code, and integration credentials
are never copied into the public database.

Drag tickets or use the arrows, click **Save order**, and share the same URL. The team page
refreshes every 30 seconds. New tickets append after the saved order; tickets leaving REVIEW
disappear on successful sync. New tickets initially follow Jira priority and creation time.
Conflicting edits cannot silently overwrite each other.

## 1. Create Supabase project

The `sf-review-page` project is already created. Save its **database password** in a
password manager; it never enters the browser. Admin access uses a private link, not a password.

For a new project, run all three migrations in **SQL Editor**, in filename order:

1. `supabase/migrations/202609180001_review_queue.sql`
2. `supabase/migrations/202609180002_private_admin_link.sql`
3. `supabase/migrations/202609290001_team_review_notes.sql`

They create the public queue, narrowly scoped team edits, and server-only ordering/sync.
The current project `qcklvxtvoymwlbhppefn` has all three migrations applied; the team-review
fields were verified on October 1, 2026. Do not rerun these migrations on that project.
The third enables public link/note editing and preserves existing tickets and saved order.
CLI migration history is not populated by SQL Editor / Management API application;
reconcile history before using `supabase db push` against this project.

## 2. Private admin link — no account or password

- Public: `https://tegarassen.github.io/sf-review-page/`
- Private admin: the same URL with `?admin=YOUR_RANDOM_KEY`.

The key is 32 random bytes, stored as `ADMIN_ACCESS_KEY` in Supabase Edge Function Secrets.
It never appears in source code or the public build. Anyone holding the private link can
reorder the queue and sync Jira; keep it to yourself. The backend verifies the key on every
order change and sync. `?admin=true` alone grants no admin access. Anyone with the public
team page can edit PR links, urgency, the client-waiting flag, and review notes through
validated database functions; direct table writes remain blocked.

On this computer the generated key is in `.env.admin` and the ready-to-use links are in
`.private/admin-links.txt`. Both are excluded from Git and have restricted file permissions.
The page removes the key from its address bar after opening and retains it only for that
browser tab. Use the original saved private link to open another tab; reloading the current
admin tab works. **Copy team link** always removes query parameters. **Exit admin view** clears
that tab's key. The page sends no referrer to Jira/GitHub links.

To rotate access, generate a new random key, replace `ADMIN_ACCESS_KEY` in Supabase Secrets,
and update your saved private link. Old links stop working on their next backend request.
Never use your Jira token as the admin key.

## 3. Deploy the Jira sync function

From this directory:

```sh
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy sync-jira admin-queue --use-api
```

The CLI is already installed on this computer. `--use-api` bundles remotely without Docker.
Gateway JWT verification is disabled in config because the function supports either an
private admin key or a scheduler credential. The function itself **always validates the
admin key or scheduler secret** before making Jira requests.

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

This project's verified **Review** status is `10136`, configured in Supabase as
`JIRA_REVIEW_STATUS_IDS=10136`. With that setting, the app skips the board configuration
request and these two ticket-read scopes are sufficient for ticket sync.
`JIRA_HIDE_RELEASED=true` also applies the Salesforce Kanban release filter:
`fixVersion in unreleasedVersions() OR fixVersion is EMPTY`. Without this filter, the API
includes older Review tickets belonging only to released versions. The five remaining
ticket keys were confirmed against the Salesforce board. Other browser quick filters
are not applied automatically.

The protected `admin-queue` action `inspect_review_scope` checks board identity, ticket
keys and release flags without publishing titles or changing the queue. With
`inspect_prs: true`, it also attempts to read Jira Development PR links for up to 50
matching tickets, including ordinary remote links and PR URLs in descriptions. Only
matching GitHub PR URLs are returned; descriptions are never stored in the public queue.
This diagnostic requires the private admin key.

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

Keep the existing scoped Jira token for ticket reads. There is no documented selectable
scope for the internal `/rest/dev-status/` endpoint. `read:dev-info:jira` is documented
for a separate repository development-information API, not this per-issue panel lookup.
Atlassian tracks scoped service-account access in
[JRACLOUD-97504](https://jira.atlassian.com/browse/JRACLOUD-97504).
The supported scoped alternative in this app is a GitHub fine-grained token restricted
to the relevant repositories with **Pull requests: Read-only** permission.


The Development panel is separate from Jira's normal issue response. Options:

1. **Supported GitHub API:** set `GH_REPOSITORIES` to comma-separated `owner/repo` names and
   `GH_READ_TOKEN` to a fine-grained token with read-only Pull requests access to those repos.
   Organization approval/SSO may apply. Open PRs match ticket keys in title, body, or branch.
   This may not reproduce every association Jira has.
2. **Optional internal Jira API:** set `JIRA_DEV_STATUS=true` to try the Development-panel
   endpoint. It is not a supported public API, may reject scoped tokens, and needs testing
   with your account. Failures do not stop ticket sync.

Anyone can **Add PR link** or **Edit links** on the team page without an admin link. Manual links survive syncs; **Use synced links**
removes the override. Missing links display “PR link pending.” This version accepts github.com
PR URLs only.

### Highlight important reviews

Use **Add priority / note** on any ticket to choose **Normal**, **Important** (amber), or
**Urgent** (red), mark **Client waiting**, and add a note of up to 500 characters explaining
what is needed. Labels accompany the colors, and the note appears in a highlighted panel.
The summary counts urgent, important, and client-waiting tickets without changing the saved
queue order. Anyone with the team link can edit or clear this context. Notes are public;
Jira comments are not imported. These edits and manual PR links survive Jira syncs while
the ticket remains in review. Stale saves are rejected and keep the draft visible to copy;
close the dialog, refresh, and reopen it to edit the latest version.

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

The checked-in public configuration connects the app. `?demo` shows fictional tickets and
local-only ordering controls. For local admin sync, temporarily omit `ALLOWED_ORIGIN` or use
the local origin.

The public Supabase URL and publishable key are already in `public-config.json`. These
are intended for browser use. Database permissions allow only scoped public link and review-context edits. Optional GitHub repository
variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` can override them.

Push this directory to `main`. Under **Settings → Pages**, choose **GitHub Actions** as the
build source. The included workflow tests, builds, and deploys only the frontend. GitHub does
not need the Jira token or admin key. Private repos need a plan supporting GitHub Pages for
private repositories. This minimal page and its data are intentionally public.

Open your private admin link, **Sync Jira**, reorder, **Save order**, then **Copy team link**.
Teammates use their existing Jira/GitHub permissions when opening tickets and PRs. Truncation
is not redaction: the first 100 characters of each Jira title are public.

## 5. Optional automatic sync

After manual sync works, generate a random scheduler secret using your password manager.
Add it as `SYNC_SECRET` in Edge Function Secrets. Follow `supabase/schedule.example.sql` in
the SQL Editor, storing the same secret in Supabase Vault. This schedules sync every
15 minutes. The secret is not sent to the browser or stored in public tables.

Manual and scheduled sync share a 10-minute lease. Failed fetches leave the last saved queue
intact; a legitimately empty REVIEW column clears it. The page shows the last successful
sync and warns when it is over 45 minutes old. Inspect Cron and function logs for failures.

## Validation and limits

`npm test` checks private-link authentication, permissions, unauthorized writes, stale edits, atomic saves, sync behavior,
public link/note edits, validation, sync persistence, PR overrides, pagination, and data minimization using PGlite and mocked providers.
`npm run build` produces `dist/`. `node tests/browser.mjs` tests the browser against a mocked
Supabase API with Vite running (test environment values are at the top of that file).
It uses installed Chrome or Playwright Chromium.

Live ticket sync has been verified against the five user-confirmed Salesforce Review
tickets. The current scoped Jira token returns HTTP 401 for Development and remote-link
lookups; none of the five descriptions contains a GitHub PR URL. PR retrieval is still
blocked on API access and has not been verified. This version handles one small board. Other boards, GitHub Enterprise hosts, or private
team viewing would require extending the configuration and policies.

References: [Supabase keys](https://supabase.com/docs/guides/getting-started/api-keys),
[function secrets](https://supabase.com/docs/guides/functions/secrets),
[scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions),
[Jira board API](https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/).

## Visual identity

The interface uses SharinPix's blue `#2045af`, orange `#ff932e`, and Inter/Poppins
font families from the [company website](https://sharinpix.com/). The company logo is
served locally from `public/sharinpix-logo.png`; source:
[SharinPix website logo](https://sharinpix.com/wp-content/uploads/elementor/thumbs/Logo-SharinPix-blue-600x265-1-ramsr9x9xevcgcfu6uurdriswn9dywqsmo70mby1og.png).
