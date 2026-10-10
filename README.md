# BackendOS

BackendOS keeps the original workspace shell and example shortcuts. Authentication,
workspaces, membership, personal appearance, and workspace-specific personal homepages
now use Supabase. Hotel Tax Calculator is the first functional Mini App; the other
Mini Apps and provider connections remain placeholders.

## Configure and run

Use Node 24 (Node >=22 supported), Python 3 for the local static server, and npm:

```sh
npm ci
# Set these environment variables in your terminal or deployment build settings:
export SUPABASE_URL=https://YOUR_PROJECT.supabase.co
export SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_KEY
npm run dev
```

`.env.example` documents the names. The build reads process environment variables;
it does **not** automatically load `.env` files. You may use Node's `--env-file=.env`
with `node --env-file=.env scripts/build.mjs` for local builds. Do not commit `.env`.
Both variables are public frontend configuration. Use the **publishable** key only;
the build rejects secret, service-role, and legacy JWT keys. The key is bundled into
`dist/client.js`; database policies, not the public key, authorize user data access.
Never put a secret/service-role key into either variable or frontend code.

`npm run build` outputs `dist/`. Serve that directory, not the repository root.
If configuration is missing, the UI explains how to configure it. Rebuild after changing
variables. Production must use HTTPS.

## Apply the database migration manually

1. Back up your project and review
   `supabase/migrations/202610070001_foundation.sql`. It creates new public tables
   (`workspaces`, `workspace_members`, `user_preferences`, `workspace_homes`), a private
   authorization helper, and the `create_workspace` RPC. It does not migrate browser data.
   If these names already exist, stop and reconcile their schemas; do not overwrite them.
2. In the Supabase SQL Editor, run this migration once as the database administrator.
   Alternatively use the Supabase CLI migration workflow after linking the correct project
   (`supabase link --project-ref YOUR_PROJECT_REF`, then review `supabase db push --dry-run`
   before `supabase db push`). Remote migrations are deliberately not applied by this PR.
3. In Data API settings, enable the Data API and include `public` among exposed schemas.
   Keep `backendos_private` out of exposed schemas. Automatic table exposure can remain
   disabled: the migration explicitly grants schema usage, table operations and RPC execution
   to `authenticated`; `anon` has no application table/RPC access. All four tables explicitly
   enable RLS, independently of your automatic RLS setting.
4. Confirm the migration completed before trying workspace creation. Missing tables, grants,
   or policies surface as load/write errors rather than being treated as an empty successful app.

The RPC atomically creates a workspace and its owner membership. Members cannot create or
change memberships, promote themselves, edit business details, or enable apps. Owners can add
and remove **Members**, but cannot remove/demote the owner or transfer ownership in this version.
The database enforces these rules even if a client bypasses the UI. Homepages and appearance
are writable/readable only by their own user. Removing membership cascades that user's homepage
and blocks further workspace access. Revocation takes effect on subsequent database requests;
an already-rendered page may retain previously loaded information until refresh.

## Supabase Auth settings

- Enable the Email authentication provider and allow new sign-ups if desired.
- Keep email confirmation enabled in production. Sign-up without an immediate session displays
  a confirmation message. Configure production SMTP for reliable confirmation/reset delivery.
- Set Auth **Site URL** to your production HTTPS origin (for example your Vercel domain).
- Add the exact origin plus `/` to **Redirect URLs**, including your local development origin
  if you test locally. For Vercel preview testing, allow only the preview URLs you trust;
  avoid broad wildcards. The app sends `location.origin + '/'` for both confirmation and reset.
- Confirmation/reset emails must use the standard Supabase confirmation link
  (`{{ .ConfirmationURL }}`); this client handles Supabase's returned session and
  `PASSWORD_RECOVERY` event. Password reset presents a form to save a new password.
- Configure password requirements/rate limits in Supabase as appropriate. The UI requires
  at least eight characters for new passwords; Supabase is the authority for validation.

## Vercel settings

Import this repository and select framework **Other**. Set install command `npm ci`,
build command `npm run build`, and output directory `dist`.
Add `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` to the desired Production/Preview/Development
build environments. Redeploy after changing them. Use your actual Vercel/custom domain in
Supabase Auth settings; no Vercel URL has been supplied yet.

## Existing prototype data and membership

The app never reads, uploads, deletes, or overwrites `backendos.workspaces.v1` or
`backendos.preferences.v1`. Existing browser data remains local and is not imported.
Cloud storage starts separately. Supabase manages its own session storage.
There is no automatic import button in this release.

After confirmation/sign-in, create a new workspace. Users with no workspaces see their user ID;
users with workspaces can copy it from Settings → Account. An owner adds that registered user's
ID under Settings → Workspace. This immediately grants Member access. Refresh/sign in again to
load newly granted access. No invitation email is sent. Owner-only controls are disabled for
members. Appearance is account-wide; home shortcut order/visibility is personal to each workspace.
Workspace switching keeps appearance and swaps the personal homepage, clears the previous
view/cache, and aborts the shared request context.

## Tests and current validation limits

```sh
npm test          # Chromium browser integration against a simulated Supabase API
npm run test:rls  # disposable PostgreSQL 17 Docker container; actual migration and RLS
npm run build
```

Browser tests require Chromium at `/usr/bin/chromium` (override `CHROMIUM_PATH`). RLS tests
require Docker and access to the `postgres:17` image. They do not connect to your live project.
The local auth bootstrap models Supabase's `auth.users`, `auth.uid()`, `anon`, and `authenticated`;
it does not exercise hosted Auth, PostgREST schema exposure, SMTP, or Vercel routing.

Before merging/deploying, manually validate on your configured project with two confirmed users:

1. User A creates workspace A; user B creates workspace B. Each sees only their workspace.
2. A adds B as Member to A. B refreshes, can switch between A and B, but cannot edit A's business,
   enabled apps, or membership. B remains Owner in B. A cannot see B.
3. Set different appearance and homepage orders with both accounts. Reload and verify persistence;
   changing B's homepage in A must not change A's homepage or B's homepage in B.
4. A removes B from A. B refreshes and loses A, including the ability to write its homepage.
5. Verify confirmation email, sign-out, password-reset email and link, new password sign-in,
   and reload/session restoration on the real production/preview domain.

Local PostgreSQL tests exercise cross-workspace reads/writes, self-joining, role escalation,
owner/member controls, private appearance/homepages, membership revocation, and anonymous denial.
Hosted integration and email delivery require your migration/Auth settings and working network access.

## Hotel Tax Calculator

Review and apply `supabase/migrations/20261007235134_hotel_tax_calculator.sql` after
the foundation migration using the manual/CLI workflow above. This PR does not
apply remote migrations, merge, or deploy. Both new tables enable RLS and have
explicit authenticated grants; anonymous access is revoked. Keep `backendos_private`
out of exposed schemas. No additional environment variables or secret keys are needed.

Open Hotel Tax Calculator from the home shortcut (or add the shortcut from App
library). It uses the existing `tax-tracker` app ID, so enabled apps and personal
shortcut order/visibility are preserved. Settings holds workspace rates, while
Entries and rates save to Supabase; there is no Data menu, export, backup, restore,
or bulk-clear UI. Entry forms open only when needed.
The app follows personal theme/accent settings and never reads the old hotel tracker
or BackendOS browser storage.

- Owners and Members can view, add, and edit guest entries.
- Only Owners can change rates or delete entries.
- Workspace and entry IDs cannot be reassigned through UPDATE, even between workspaces
  that a user owns. Every read/write is scoped to the active workspace. Disabled apps
  retain their records but RLS blocks access until the Owner enables the app again.
- Refresh reloads records and checks current workspace access. Switches, navigation,
  and authentication changes clear drafts/data and reject stale responses. Removing
  membership blocks subsequent requests; already-rendered records clear on refresh.

Calculations match the attached v5 app: Thursday guests × Thursday cost + weekend
guests × weekend cost; tax is that charge × tax rate; discount is a percentage of
**tax**, not revenue. Charged/free guest counts are separate attendance statistics,
with actual guests = charged + free. Half guests are supported. Rates recalculate
all historical periods. Defaults are $319.60 / $282.00 / 6% tax / 1% discount.
Like v5, **Year to Date** includes the entire selected calendar year, including any
future-dated entries. Values are rounded only for currency display/export.

The original versioned migration retains its restore RPC for migration-history
compatibility; the frontend no longer calls it. Previously applied migrations are
not rewritten. No database change is needed to remove the Data menu.

Appearance tokens, including the browser's native light/dark color scheme, resolve
on the HTML root. Light and Dark override the system preference; System follows
changes to it. Accent selection remains personal and applies across workspaces.
In Edge, Windows contrast themes/forced colors can override site colors by design;
the app keeps that accessibility behavior rather than forcing a custom palette and
explains it in Appearance when detected. Dark Reader and similar extensions can
also override the app palette; disable the extension for this site to use the
selected accent and Light/Dark/System theme.

`npm test` covers formula parity, validation, calculator browser CRUD/rates,
failed writes/loads, period views, persistence, two-account/two-workspace
UI separation, Member controls, stale requests, and pagination, plus foundation
regressions, rendered accent colors, and Light/Dark/System switching. `npm run test:rls` applies all migrations to disposable PostgreSQL 17
and tests actual grants/RLS, including cross-workspace reads/writes, immutable IDs,
Owner/Member permissions, disabled apps, revocation, anonymous denial, and atomic
restore rollback. Browser tests serve the built `dist/` files with a simulated API; hosted Auth/PostgREST/SMTP
validation remains a pre-release check and no live project data is changed.

## Usernames and membership

Apply `supabase/migrations/20261008005026_usernames.sql` once, after the foundation
migration, to the same Supabase project used by the preview. Do not rerun earlier
migrations. This migration is not applied remotely by this PR. It adds `user_profiles`
with explicit grants and RLS, plus exact-username lookup and membership RPCs.

Users choose a unique username in Settings → Account (also available before joining
a workspace). Names are normalized to lowercase, 3–30 characters, starting with a
letter and containing only letters, numbers, and underscores. Changing a name leaves
the account UUID and all memberships unchanged; the old name becomes available.
Existing accounts can continue sharing their user UUID until they choose a name.

Owners enter an exact username in Settings → Workspace → Members, check the matched
username/account ID and target workspace, then confirm. The database rechecks both
the Owner's authority and the confirmed UUID. A changed or reclaimed username requires
a fresh lookup. Existing UUID-based addition remains available. Lookup returns no
email and has no prefix search or directory endpoint. A user can read their own
profile and those of people sharing a workspace; unrelated profiles remain hidden.
Only a workspace Owner can look up an otherwise hidden exact username. This is a
membership convenience, not a change to UUID-based authorization.

Built-browser and PostgreSQL tests cover duplicates, case normalization, exact lookup,
confirmation before membership, stale matches, Member/outsider/anonymous denial,
private profile reads and writes, username changes, and membership preservation.

## Import an old Hotel Tax Tracker CSV

Apply `supabase/migrations/20261010031652_hotel_tax_csv_import.sql` once to the
configured project before testing this feature. It adds an explicitly granted,
SECURITY INVOKER import RPC; no existing table or migration is rewritten. This PR
does not apply it remotely.

An Owner opens Hotel Tax Calculator → **Import old CSV**, selects an export from
v5 of the original tracker, reviews the destination workspace and guest rows, then
confirms. Parsing supports UTF-8 BOM, quoted commas, escaped quotes, multiline
names, CRLF/LF, and half guests. It requires the old export's eight-column header.
Blank separators and recognized summary rows are excluded; invalid guest rows or
incomplete rates reject the file rather than silently dropping information.
Limits are 10 MB per file and 10,000 guest rows; the preview shows the first 100 rows.
Old exports contain only their selected month/year: upload each period you need.

Imports append entries and never delete or replace existing records. Exact matches
(date, trimmed case-sensitive name, and all four guest counts) are skipped both
within the file and in the destination workspace. The result reports imported and
skipped counts. Identical entries are treated as duplicates even if intentionally
recorded twice in the old tracker; edited existing entries no longer match their
original exported version. A duplicate in another workspace does not suppress an
import into this one. New IDs and the target workspace are assigned by the RPC.

CSV rates are displayed when present. Current workspace rates are retained unless
the Owner selects **Use these CSV rates**. That option recalculates all workspace
entries, including historical periods. Actual guest totals, charges, and tax totals
are recomputed from guest counts/rates rather than copied from summary cells.

The database rechecks Owner membership and enabled-app access, validates every row,
and imports entries and optional rates in one transaction. Any invalid data or
permission failure rolls back the entire import. Workspace switching/sign-out
clears file previews and stale file reads cannot populate another workspace.
Only the user-selected CSV is read; no prototype browser storage is imported.
Browser, parser, and actual PostgreSQL tests cover confirmation, quoting, bad rows,
rate opt-in, retry, duplicate uploads, and two-workspace Owner/Member/outsider denial.
