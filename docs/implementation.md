# Technical stack and implementation plan

Status: design requirements, not implemented. Updated: 2026-11-13.

This document and [UI requirements](ui.md) record the follow-up decisions to the [design handoff](design.md). They replace its original single-administrator scope and plain Vite tooling proposal.

## Selected stack

| Area | Selection |
| --- | --- |
| Language | TypeScript with strict checking |
| Runtime and API | Maintained Node.js LTS and Hono |
| Frontend | Vue 3 and Vue Router |
| Toolchain | Vite+ for development, builds, checks, formatting, and tests |
| Components and styling | shadcn-vue and Tailwind CSS; locally owned components and application design tokens |
| Persistence | Local SQLite with better-sqlite3, WAL, foreign keys, and a busy timeout |
| ORM and migrations | Drizzle ORM; Drizzle Kit generates SQL migrations for review and execution |
| Authentication | Username/password and server-side sessions |
| Deployment | Docker image and Docker Compose, with a host data directory mounted at /data |

Valibot is the proposed validation library replacing Zod. Its small bundle and low initialization cost fit shared frontend/backend schemas; it is not assumed to validate faster than current Zod versions. Confirm this recommendation during implementation. Use the official Plaid Node SDK behind an adapter. Browser acceptance tests can use Playwright alongside Vite+'s test tooling.

Pin compatible runtime and dependency versions when scaffolding. Use reviewed migrations, not schema push, for deployed databases. Fetch upstream pages before entering the short SQLite transaction that applies a complete batch and its final cursor.

## Deployment and data boundaries

One application process serves built Vue assets, Hono APIs, and scheduled/manual sync jobs. Development may run the frontend and backend with hot reload. Production startup must not require building the application on the user's machine; provide a prebuilt image and Compose example.

Users configure a host data directory, mount it at /data, supply secrets separately, and start Compose. Container replacement and restart must preserve SQLite and annotations. Run as a non-root user with documented directory permissions. Keep encryption keys outside the image, repository, and database backup. Provide consistent SQLite snapshots for backup; a persistent mount alone is not a backup.

Worker and D1 are not deployment targets. Self-hosting controls where financial data is stored and processed; Docker does not automatically encrypt the database or guarantee host security. Cloudflare Access can protect the external entry point. Application sessions and account authorization remain required. Do not infer an application user from unverified request headers.

## Users and account permissions

Support multiple users in MVP. Distinguish login users, Plaid credentials/Items, and canonical bank accounts.

| Capability | admin | member |
| --- | --- | --- |
| View balances, transactions, and summaries | All accounts | Accounts in their groups |
| Edit notes, categories, tags, and reconciliation | All accounts | Accounts in their groups |
| Connect/repair banks and configure account mappings | Yes | No |
| Manage users, account groups, and group membership | Yes | No |
| Manage sync, secrets, backups, and instance settings | Yes | No |

Access is organized by account group. Each canonical account belongs to exactly one group, and a user can belong to several groups. Membership includes viewing and bookkeeping every account in the group, with its full history. Do not make members read-only or require an administrator to enter their annotations. There are no nested groups, per-account exceptions, or separate read/write levels.

New bank accounts land in the protected Unassigned group, which only administrators see and which cannot have members. After a connection discovers accounts, the administrator moves each one into a group; accounts from one Item can go to different groups. Groups attach to canonical accounts, not a Plaid profile, Item, or source account, so mapping or primary-source changes keep the account's group. Moving an account moves visibility of its whole history and its annotations: members of the old group lose access and members of the new group gain it on their next request. The move is atomic, refused if the account changed group since the administrator looked, and the interface shows who gains and loses access before confirming. A group with accounts cannot be deleted; deleting an empty group never touches financial data.

Hosted Link is not built yet. When it is, the completion step should list the newly discovered accounts in Unassigned and offer the same move-with-impact step rather than sharing anything automatically.

All access paths enforce the same server-side scope: account lists, totals, search, transactions, source history, exports, and annotation writes. Check access on each request, including direct requests by ID; revocation applies to subsequent requests. Client caches must be cleared/refetched when access is lost. Previously downloaded data cannot be recalled.

Shared accounts have shared annotations and reconciliation state. Record who changed them and when. Use version checks to detect concurrent edits and ask the user to resolve conflicts instead of silently overwriting another edit.

Suggested additional schema:

- users: id, unique username, password_hash, role (admin/member), timestamps.
- sessions: user reference, protected session token representation, expiry and revocation state.
- account_groups: id, unique name, protected flag (the fixed Unassigned group).
- group_members: group_id and user_id, unique as a pair.
- canonical_accounts.group_id: the one group that controls who sees the account.
- account_access: the earlier per-account grants, kept unread as the input record of migration 0003.
- Annotation change metadata/history: actor, time, and revision for conflict detection.

Use mature password hashing, HttpOnly session cookies, session expiry/revocation, and CSRF protection. First-run administrator setup must be controlled; no public registration. Administrators create member accounts. OAuth, email registration, and external identity integration are outside the initial scope. Cloudflare Access is an optional deployment layer, not a substitute for these user identities.

## Proposed repository layout

Start with one package manifest. Keep this layout as a proposal until scaffolding:

```text
src/
  server/
    auth/
    access/
    accounts/
    transactions/
    plaid/
    sync/
    db/
    jobs/
  web/
    pages/
    components/ui/
    api/
  shared/
    contracts/
    money/
db/migrations/
tests/
deploy/
docs/
```

Keep Plaid types and credentials in the server adapter. Shared API contracts must not expose secrets or couple the browser to database rows. Centralize account access checks. Keep currency precision and sign conversions in tested accounting helpers.

## Proposed first implementation milestone

This is a proposed split, not completed work or a final estimate. It advances essential lifecycle correctness from the original later phases.

1. Scaffold Vite+, Vue, Hono, Drizzle migrations, configuration validation, and Docker persistence.
2. Add users, sessions, admin/member roles, account groups, and negative authorization tests with differently scoped users.
3. Build deterministic provider fixtures and transactional sync: pagination, restart after mutation, idempotence, and unchanged cursor after failure.
4. Implement annotation preservation through pending/posted, modified, and removed records; reconciliation review and concurrent-edit handling.
5. Build the responsive transaction list and editing flow first, including account filters and clear sync state. Members can independently bookkeep the accounts in their groups.
6. Verify the adapter against Plaid Sandbox, including profile isolation and multiple accounts sharing one Item cursor.

Acceptance: Compose starts the service; restart/container replacement preserves data; unauthorized records cannot be read or edited through any API path; notes survive sync transitions; mobile and desktop flows meet [UI acceptance criteria](ui.md). No real banks or Production credentials are required.

## Documentation references

- [Vite+](https://www.viteplus.dev/)
- [Hono on Node.js](https://hono.dev/docs/getting-started/nodejs)
- [Drizzle migrations](https://orm.drizzle.team/docs/migrations)
- [Valibot comparison and performance tradeoffs](https://valibot.dev/guides/comparison/)
- [shadcn-vue](https://www.shadcn-vue.com/docs/introduction)
