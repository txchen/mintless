# Mintless design handoff

Status: Draft v0.2. Source review date: 2026-10-11. Updated: 2026-11-13.

Follow-up requirements are recorded in the [technical stack and implementation plan](implementation.md) and [UI requirements](ui.md). These supersede the original tooling and single-administrator assumptions.

This is an English implementation summary of the user-supplied Chinese handoff, not a verbatim copy. Product choices are proposed requirements, not implemented capabilities. Plaid API details, coverage, limits, pricing, and eligibility claims from the handoff have not been independently verified. Check current official documentation before implementation.

## Product and scope

A personal or trusted-household, self-hosted, read-only financial account and transaction aggregator. Plaid is an upstream provider; local SQLite owns the durable history and annotations. Recovery, idempotence, and data preservation take priority over continuous availability.

MVP includes multiple application users with group-based viewing and bookkeeping access; multiple Plaid developer profiles; Hosted Link creation and repair; accounts and cached balances; scheduled and manual transaction sync; filtering, search, summaries, and CSV export; notes, custom categories, tags, owners, and reconciliation; manual joint-account mapping and primary-source selection; duplicate candidates; protected administration; and backup/restore.

Only request the Transactions product. Do not implement transfers, payments, orders, real-time balance guarantees, investments, tax reporting, receipt OCR, public registration, multi-tenant SaaS, high availability, automatic forced deduplication, webhooks, or transaction refresh in MVP. Multiple profiles do not establish application-level privacy boundaries or justify bypassing provider terms.

## Architecture

Browser -> HTTPS -> one Node.js/Hono service serving Vue assets, APIs, a scheduler, and a multi-profile Plaid adapter -> SQLite in WAL mode. Enable foreign keys and a busy timeout. Use one writer, explicit transactions, constraints, and indexes.

Deploy with Docker Compose and one persistent volume. HTTPS may use a reverse proxy or Cloudflare Tunnel/Access. The backend must verify identity independently. No hosted database, Worker, queue, Kubernetes, or monorepo tooling is required.

Suggested directories: apps/web, apps/server, packages/core, db/migrations, deploy, docs, tests. A simpler src/web and src/server layout is also acceptable. Core identifiers and accounting types must remain provider-neutral for future CSV/OFX/QFX imports.

## Profiles and identity

Each profile identifies its environment, client_id, and secret reference. Every Item and Link session belongs to one profile; never mix credentials or access tokens across profiles. Each Item represents one institution login and can contain multiple accounts. Maintain one committed sync cursor per Item; do not pass account_id to transactions/sync. Introducing account-scoped sync later requires separate cursors.

Use local UUIDs for canonical accounts and transactions. Plaid account IDs can change after reconnects and transaction IDs can change between pending and posted.

The source handoff describes a Trial lifetime allowance of 10 Production Items, not refunded on deletion, and excludes Sandbox. Treat this as an unverified dated claim. Confirm current eligibility, billing, rate limits, institution/OAuth coverage, and especially Fidelity access for each profile. Never depend on registering multiple teams to evade limits.

## Hosted Link

Default to Sandbox. Production creation requires explicit administrator action and confirmation of any irreversible quota use. Allow one unfinished new-connection flow per profile/operator.

Create a link token with products=[transactions], transactions.days_requested=730, a unique client_user_id, and hosted_link.completion_redirect_uri. Configure institution OAuth redirect_uri separately. Account-selection behavior depends on the institution.

Persist profile, encrypted link token, session owner, nonce hash, mode, state, expiry, and exchange status. Redirect arrival is not proof of completion. Validate identity, ownership, and nonce, then query link/token/get and process each completed link_sessions[].results.item_add_results[].public_token with its original profile. Never infer the profile from client input at completion.

Exchange public tokens once, encrypt and persist access_token plus item_id, then verify with item/get and accounts/get. Enforce UNIQUE(profile_id, plaid_item_id). Do not retain plaintext public tokens after exchange. Exchange and SQLite commit cannot be atomic across systems: a crash after exchange but before token persistence requires explicit recovery/manual investigation, never automatic creation of a replacement Item.

Use a return-page check, a Check status/Resume control, and bounded polling instead of webhooks. The handoff describes a six-hour result retrieval window and a default 30-minute Hosted Link URL lifetime when Plaid does not deliver the URL; verify these values before relying on them.

Update Mode uses the existing profile and access token, keeps the Item, and never exchanges a public token. For additional accounts, verify update.account_selection_enabled and Link customization requirements. Support authorization renewal and ITEM_LOGIN_REQUIRED. Institution-specific revocation rules may apply.

## Accounts and joint accounts

Use item/get for status and accounts/get for metadata and cached balances. Do not call accounts/balance/get. Display fetch timestamps and a Cached/last synced label. Balances and transactions may reflect different snapshots. Credit current generally means debt when positive; available and limit can be null.

Preserve each Item's source account independently. Map sources explicitly to canonical accounts and select one primary source for display, balances, and canonical transaction creation. Preserve secondary-source records and provenance.

Prefer authorizing a joint account only once. A matching persistent_account_id can suggest a strong candidate where available; mask, name, institution, subtype, and history are hints, never sufficient for automatic merging. Manual primary-source changes require historical overlap review. Never silently deduplicate transactions by date, amount, and merchant.

## Sync correctness

Default interval: 12 hours, configurable through SYNC_INTERVAL_HOURS; support daily scheduling and Sync now. Do not call transactions/refresh. More frequent polling does not guarantee fresher institution data.

1. Acquire an Item lock and remember its committed cursor.
2. Fetch all transactions/sync pages with count=500, staging added, modified, and removed records until has_more=false.
3. On TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION, discard the entire staged batch and restart from the original committed cursor with bounded retries.
4. Resolve added/modified records and pending successors across the complete batch before soft-deleting removed sources.
5. Atomically commit source changes, canonical mappings, soft deletes, and the final cursor in one SQLite transaction. Failure leaves the cursor unchanged.
6. Refresh account metadata and cached balances through accounts/get after successful transaction sync; record operation timestamps and any separate balance-refresh failure.

Use uniqueness constraints and UPSERTs for replay safety. Only one sync job per Item may run. Apply timeout, bounded retry, and exponential backoff; authorization errors require Update Mode, not new Items.

Initial empty responses do not prove no transactions exist. Track transactions_update_status and retry for phased historical backfill. Request 730 days initially; institution coverage may be much shorter. The handoff states a 1–730-day range, default 90, and a Production minimum effective request of 30 days; verify before use. Do not assume the initial history window can later expand. Local history may exceed Plaid's retrievable window.

## Transaction lifecycle and accounting

Annotations attach only to stable canonical transaction IDs. A posted transaction with pending_transaction_id should reuse the pending canonical ID even if amount changes, preserving annotations. The old source becomes superseded/soft-deleted. Without a reliable successor link, request review rather than matching heuristically.

Refunds usually remain separate reverse-direction transactions. Support manual refund-of/reverses relationships. Canceled pending records can be removed without successors: retain provenance and annotations but exclude inactive transactions from default spending. Preserve source change history for corrections and removals.

Notes, categories, tags, owner, and reconciliation records must never be overwritten by sync. If a reconciled transaction's amount, date, or account changes materially, set needs_reconciliation_review and retain prior review information.

Distinguish purchases, refunds, internal transfers, and credit-card payments. MVP can use manual classification/exclusion so household transfers and repayments are not counted as new spending twice. Do not double-count pending and posted transactions.

Preserve source amounts/currencies and necessary raw fields. Use integer minor units with currency-aware precision or reliable decimal arithmetic. Plaid positive amounts generally mean outflow; keep source signs intact and apply UI conventions separately.

## Logical schema

These are relationships, not completed migrations. Add foreign keys, indexes, CHECK constraints, timestamps, and schema versions.

| Table | Core fields and constraints |
| --- | --- |
| users | id, username, password_hash, role; unique username |
| sessions | user_id, protected token representation, expiry/revocation |
| account_groups | id, name, protected; unique name |
| group_members | group_id, user_id; unique pair |
| plaid_profiles | id, name, environment, client_id, secret_ref; no plaintext secret |
| link_sessions | id, profile_id, link_token_enc, nonce_hash, owner, mode, status, expires_at, exchange_status |
| plaid_items | id, profile_id, plaid_item_id, access_token_enc, institution_id, cursor, status, last_sync_at; unique profile/item |
| canonical_accounts | id, display_name, owner, primary_plaid_account_id, archived_at |
| plaid_accounts | id, item_id, plaid_account_id, canonical_account_id, metadata, persistent_account_id, balances, balance_fetched_at; unique item/account |
| canonical_transactions | id, canonical_account_id, preferred_source_id, status, review_required |
| plaid_transactions | id, item_id, plaid_transaction_id, plaid_account_id, canonical_transaction_id, pending_transaction_id, amount_minor, currency, date, raw_json, removed_at, superseded_by_id; unique item/transaction |
| transaction_annotations | canonical_transaction_id, custom_category, note, tags_json, owner, is_reconciled, reconciled_at, updated_at, updated_by, revision; retain edit history |
| sync_runs | id, item_id, started_at, finished_at, status, counts_json, error_code; no tokens |

Each source transaction belongs to at most one canonical transaction; multiple sources can represent one canonical transaction. Multiple source accounts may map to one canonical account. Never cascade-delete annotations. User-data deletion is a separate explicit administrative action. Minimize retained raw JSON and document configurable retention, cleanup, and export policies.

## Proposed protected API

- GET /api/health: minimal health without secrets.
- GET /api/profiles: metadata only.
- POST /api/link-sessions: protected creation by profile and mode.
- GET /api/link-sessions/:id: status/completion query.
- POST /api/link-sessions/:id/finalize: controlled, concurrency-safe exchange.
- GET /api/items; POST /api/items/:id/update-link; POST /api/items/:id/sync.
- POST /api/items/:id/resync: controlled cursor-null repair preserving history.
- GET /api/accounts; PATCH /api/accounts/:id: mappings and primary sources.
- GET /api/transactions; GET /api/transactions/:id.
- PATCH /api/transactions/:id/annotation.
- GET /api/transactions/export.csv: protected export with safe CSV handling.
- GET /api/sync-runs: redacted operational history.

Business routes require authentication, authorization, and validation. Authentication entry points must have explicit unauthenticated behavior. Profile/Item administration, mappings, sharing, and sync logs are admin-only; account/transaction reads, exports, and annotation writes use the accounts in the current user's groups. Add session, user-management, and account-group routes during API design. No public item/remove endpoint in MVP. Future disconnect flows must explain quota consequences, upstream revocation, and separate local-data deletion choices.

## Security and recovery

Plaid sees financial data; Cloudflare also participates in the trust boundary when used. Do not claim zero third-party visibility.

Load profile secrets from deployment secrets or restricted files. Encrypt access tokens with AES-256-GCM and keep the master key outside the database, repository, and shared backup boundary. No tokens in logs, localStorage, public configuration, or error responses.

Use HTTPS and username/password authentication with server-side sessions. Cloudflare Access may provide an additional external access gate. Do not trust arbitrary client-supplied identity headers. Protect writes, Link creation, and export. Cookie sessions require CSRF defense and Secure/HttpOnly/SameSite settings. Restrict volume and secret permissions, patch dependencies, redact account details and raw payloads, and bound upstream requests.

MVP supports admin and member roles in a trusted household. Admins see all accounts; members can view and bookkeep every canonical account in their account groups. New accounts start in the admin-only Unassigned group. Enforce access on the backend for reads, writes, summaries, and exports; shared annotations record actors and detect concurrent edits. Support explicit data export, deletion, and authorization-revocation requirements without conflating them with automatic Item recreation.

Create daily consistent snapshots using SQLite backup API, .backup, or VACUUM INTO; copying a live main database alone is unsafe with WAL. Encrypt offsite backups with restic, age, or equivalent to R2/S3. Suggested configurable retention: 14 daily, 8 weekly, 6 monthly. Keep keys and recovery instructions separately. Validate monthly and complete a full restore drill before release, including accounts, annotations, tokens, and cursors.

Normal failure retains the cursor. Pagination mutation restarts the whole batch. Reauthorization repairs the original Item. Cursor-null resync stages and aligns records by source ID; preserve annotations and history outside the current provider window. Never mark all historical records absent from a resync as deleted. Show repair differences for review.

After database loss, restore backups before syncing. Plaid cannot guarantee reconstruction of old history or annotations. Exchange-without-persistence requires Dashboard/support investigation. Duplicate recovery uses explicit mappings and primary-source rules while preserving provenance.

## UI

Use shadcn-vue and Tailwind CSS with Vue and Vite+. Mobile is a first-release requirement. Follow the [UI requirements](ui.md) for compact layouts, restrained styling, touch interactions, and acceptance checks.

- Overview: grouped cash/credit cached balances, account counts, reconciliation backlog, last sync, errors.
- Accounts: canonical accounts, timestamps, source institution/Item, duplicate candidates, mappings.
- Transactions: paginated search/filter, annotations, lifecycle history, pending/posted and refund/transfer labels.
- Review: uncategorized records, changed reconciliations, suspected duplicates, unmatched successors.
- Settings: profile metadata, Items, Hosted/Update Link, sync status, exports, backups, privacy/deletion.

Hide removed/superseded sources by default, expose history in details, and never label cached balances as real-time.

## Delivery phases and acceptance

### Phase 0: infrastructure and Sandbox

Compose startup, persistent SQLite, migrations, multiple profiles, environment isolation, secrets, and username/password sessions with admin/member account authorization tests. Test Sandbox plus simulated added/modified/removed, pagination mutation, empty initialization, and reauthorization. Unit tests cover currency signs/rounding, idempotent upserts, and annotation retention. No real banks or Production credentials. Restart preserves data.

### Phase 1: Hosted Link and ingestion

Create/query/finalize Link sessions, enforce profile ownership, ingest Items/accounts, and run initial/scheduled sync. Explicitly unlock Production. Verify three accounts share one Item cursor, credentials never cross profiles, and repeated sync creates no duplicate source rows.

### Phase 2: bookkeeping correctness

Implement canonical identity, soft deletes, annotation/reconciliation preservation, pending successors, separate refunds, manual joint-account mapping, and primary-source reporting. Removal/modification cannot lose notes; uncertainty must surface for review.

### Phase 3: usability and resilience

Build Vue UI, filters, CSV export, status/manual sync, controlled resync, migrations/recovery documentation, encrypted backups, and a restore drill. Publish deployment examples, README, chosen LICENSE, SECURITY.md, privacy documentation, and contribution guidance. Verify repeatable deployment/restore, no leaked credentials, and offline incremental recovery.

Future: CSV/OFX/QFX import, transfer/payment matching, category rules, optional webhooks and balance queries, client-side encryption, richer statistics, and storage adapters.

## Decision summary and references

Choose self-hosted Compose/SQLite, same-origin Vue/Hono, Hosted Link, polling completion, Item-scoped incremental cursors, 12-hour polling, cached balances, local UUIDs, source soft deletion, manual account mapping, encrypted consistent backups, and Transactions-only permissions for a small recoverable service.

Before implementation, consult current official Plaid documentation for Pricing/Trial, Hosted Link, Link token create/get, Items exchange/get/remove, Transactions sync and lifecycle, Accounts/balances/persistent IDs, Balance, Update Mode, and Sandbox testing.

Success means annotations and reconciliation survive upstream changes, pending-to-posted transitions, restarts, outages, and backup restoration while the user sees unified history and explicitly cached balances.
