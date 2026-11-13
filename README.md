# Mintless

A self-hosted, read-only personal finance tracker. Your accounts, your transactions, your data.

Mintless will aggregate bank and credit-card transactions and cached balances through Plaid, with durable local notes, categories, tags, and reconciliation records in SQLite.

## Status

Design only. No application, migrations, dependencies, or deployment is implemented yet.

Read the [design handoff summary](docs/design.md) for scope, correctness requirements, and planned acceptance criteria. The first implementation milestone is Phase 0: infrastructure and Sandbox tests without real bank connections.

## Planned stack

TypeScript, a maintained Node.js LTS release, Hono, Vue 3 with Vite, better-sqlite3, and Docker Compose. One application process and a persistent SQLite volume.

## License

Not selected yet.
