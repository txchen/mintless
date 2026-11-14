# Mintless

A self-hosted, read-only personal finance tracker. Your accounts, your transactions, your data.

Mintless will aggregate bank and credit-card transactions and cached balances through Plaid, with durable local notes, categories, tags, and reconciliation records in SQLite.

## Status

First milestone, not yet released. It includes:

- Username/password sessions with admin and member roles. Each account belongs to one account group; members view and bookkeep every account in their groups.
- A responsive transaction list and editor for notes, categories, tags, owner, and reconciliation, with conflict detection for concurrent edits.
- Transactional Item sync: all pages are staged, a mutation during pagination restarts the batch, and the cursor moves only when the whole batch commits.
- Lifecycle handling: a pending transaction keeps its notes when it posts, removals keep annotations and ask for review, and reconciled transactions that change are flagged.
- Synthetic demo connections, so you can try everything without Plaid credentials. A Plaid Sandbox adapter is included but has not been run against live Sandbox yet.

Hosted Link, Update Mode, joint-account mapping, cursor-reset resync, and encrypted offsite backups are not built yet. Production Plaid profiles are rejected.

Read the [technical stack and implementation plan](docs/implementation.md), [UI requirements](docs/ui.md), and [design handoff](docs/design.md). To run Mintless, follow [Deploy with Docker Compose](docs/deployment.md). To work on the code, follow [Develop Mintless](docs/development.md).

## Stack

TypeScript, Node.js LTS, Hono, Vue 3, Vite+, shadcn-vue, Tailwind CSS, Drizzle ORM/Kit, SQLite with better-sqlite3, and Docker Compose. Validation uses Valibot. One application process with a host data directory mounted at /data.

Username/password sessions support administrators and members. Administrators see all accounts and manage account groups; members can view and bookkeep the accounts in their groups. Mobile and desktop are both first-release targets.

## License

Not selected yet.
