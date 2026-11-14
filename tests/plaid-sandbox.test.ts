import { randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vite-plus/test';
import { encryptSecret } from '../src/server/crypto.ts';
import { items, providerProfiles, sourceAccounts, sourceTransactions } from '../src/server/db/schema.ts';
import { syncItem } from '../src/server/sync/engine.ts';
import { PlaidProvider } from '../src/server/sync/plaid-provider.ts';
import { masterKey, setup } from './helpers.ts';

const clientId = process.env.PLAID_SANDBOX_CLIENT_ID;
const secret = process.env.PLAID_SANDBOX_SECRET;

describe.skipIf(!clientId || !secret)(
  'Plaid Sandbox (live, needs PLAID_SANDBOX_CLIENT_ID and PLAID_SANDBOX_SECRET)',
  () => {
    it(
      'syncs one Item with several accounts on one cursor, and replays without duplicates',
      { timeout: 180_000 },
      async () => {
        const provider = new PlaidProvider({ environment: 'sandbox', clientId: clientId!, secret: secret! });
        const { db, sync } = setup({ provider });
        const profileId = randomUUID();
        db.insert(providerProfiles)
          .values({
            id: profileId,
            name: 'sandbox',
            environment: 'sandbox',
            clientId,
            secretRef: 'env:PLAID_SANDBOX_SECRET',
          })
          .run();
        const created = await provider.createSandboxItem();
        const itemId = randomUUID();
        db.insert(items)
          .values({
            id: itemId,
            profileId,
            providerItemId: created.providerItemId,
            accessTokenEnc: encryptSecret(masterKey, created.accessToken),
          })
          .run();

        let total = 0;
        for (let attempt = 0; attempt < 12 && total === 0; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 5000));
          const outcome = await syncItem(sync, itemId, 'manual');
          expect(outcome.status).toBe('succeeded');
          total = db.select({ n: count() }).from(sourceTransactions).get()!.n;
        }
        expect(total).toBeGreaterThan(0);
        const accounts = db.select().from(sourceAccounts).where(eq(sourceAccounts.itemId, itemId)).all();
        expect(accounts.length).toBeGreaterThan(1);
        expect(db.select().from(items).all()).toHaveLength(1);

        await syncItem(sync, itemId, 'manual');
        expect(db.select({ n: count() }).from(sourceTransactions).get()!.n).toBe(total);
      },
    );
  },
);
