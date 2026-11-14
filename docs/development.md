# Develop Mintless

Mintless is one package. The Hono API, the scheduler, and the Vue app run in one Node.js process on one port. In development, that process serves the app through Vite middleware, so hot reload uses the same origin as the API.

## Run locally

1. Install dependencies with Node.js 24 or later:

   ```sh
   npm install
   ```

2. Create a key and an environment file:

   ```sh
   mkdir -p .local && openssl rand -base64 32 > .local/master.key
   cp .env.example .env
   ```

3. Create users and synthetic data:

   ```sh
   set -a; . ./.env; set +a
   node src/server/cli.ts user:create --username admin --role admin
   node src/server/cli.ts user:create --username member --role member
   node src/server/cli.ts demo:seed --member member
   ```

4. Start the server:

   ```sh
   set -a; . ./.env; set +a
   npm run dev
   ```

To reset a password without the browser, run `node src/server/cli.ts user:password --username admin` with the same environment. It prompts twice without echoing.

Each **Sync now** on a demo connection advances a scripted story by one step: a pending charge posts with a tip, another pending charge is canceled, a merchant name changes, a refund arrives, and one amount is corrected. Use it to watch notes and reconciliation survive provider changes. `node src/server/cli.ts demo:advance` does the same from the shell.

To serve behind a proxy host name in development, list it in `MINTLESS_DEV_ALLOWED_HOSTS`. Vite rejects other host names.

## Check your change

| Command | What it runs |
| --- | --- |
| `npx vp check` | Formatting, lint, and type-aware checks for TypeScript files |
| `npx vue-tsc --noEmit -p tsconfig.json` | Type checks for Vue components |
| `npx vp test` | Unit, sync, lifecycle, and API authorization tests on in-memory SQLite |
| `npx vp build` | Production build of the web app into `dist/web` |
| `node scripts/browser-check.ts` | Playwright flow at phone, tablet, and desktop widths against a running server |

`scripts/browser-check.ts` reads `MINTLESS_URL`, `MINTLESS_USER`, `MINTLESS_PASSWORD`, and `MINTLESS_SCREENSHOTS`. Set `MINTLESS_CHROMIUM` to use an existing Chromium binary.

The live Plaid Sandbox test in `tests/plaid-sandbox.test.ts` runs only when `PLAID_SANDBOX_CLIENT_ID` and `PLAID_SANDBOX_SECRET` are set. Never point it at Production credentials.

## Change the logo

`public/favicon.svg` is the only source for the logo. The app shows it in the sidebar and on the sign-in page. After you edit it, regenerate the PNG and ICO variants:

```sh
node scripts/build-icons.ts
```

The script uses Playwright to render `favicon.ico` (16, 32, and 48 px), `apple-touch-icon.png`, and the manifest icons. Set `MINTLESS_CHROMIUM` to use an existing Chromium binary.

## Change the schema

Edit `src/server/db/schema.ts`, then generate a migration and review the SQL:

```sh
npx drizzle-kit generate --name <change>
```

Commit the SQL and the snapshot in `db/migrations`. Mintless applies migrations at startup; it never pushes the schema directly.

## Where things live

| Path | Contents |
| --- | --- |
| `src/server/sync/engine.ts` | Staged sync, retries, the atomic batch apply, and lifecycle rules |
| `src/server/sync/provider.ts` | The provider-neutral interface that Plaid and the fixtures implement |
| `src/server/sync/fixture-provider.ts` | Deterministic synthetic bank data |
| `src/server/http/context.ts` | Sessions, CSRF checks, and account scope |
| `src/server/transactions.ts` | Scoped queries, annotation writes, and CSV export |
| `src/shared/contracts.ts` | Valibot request schemas and API response types |
| `src/web` | The Vue app and the local shadcn-vue components |
