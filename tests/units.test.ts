import { randomBytes, randomUUID } from 'node:crypto';
import { PlaidError } from 'plaid';
import { describe, expect, it } from 'vite-plus/test';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../src/server/crypto.ts';
import { items, providerProfiles } from '../src/server/db/schema.ts';
import { syncItem, type ProviderResolver } from '../src/server/sync/engine.ts';
import { FixtureProvider } from '../src/server/sync/fixture-provider.ts';
import { mapPlaidError } from '../src/server/sync/plaid-provider.ts';
import { directionOf, formatMinor, toMinorUnits } from '../src/shared/money.ts';
import { masterKey, setup } from './helpers.ts';

describe('money', () => {
  it('converts provider decimals to integer minor units with currency precision', () => {
    expect(toMinorUnits(12.34, 'USD')).toBe(1234);
    expect(toMinorUnits(0.1 + 0.2, 'USD')).toBe(30);
    expect(toMinorUnits(-1585.27, 'USD')).toBe(-158527);
    expect(toMinorUnits(12.345, 'USD')).toBe(1235);
    expect(toMinorUnits(-0.004, 'USD')).toBe(0);
    expect(Object.is(toMinorUnits(-0.004, 'USD'), -0)).toBe(false);
    expect(toMinorUnits(1500, 'JPY')).toBe(1500);
    expect(toMinorUnits(1.2345, 'KWD')).toBe(1235);
  });

  it('keeps provider signs: positive is an outflow', () => {
    expect(directionOf(500)).toBe('outflow');
    expect(directionOf(-500)).toBe('inflow');
    expect(formatMinor(-158527, 'USD')).toBe('-$1,585.27');
    expect(formatMinor(1500, 'JPY')).toBe('¥1,500');
  });
});

describe('secrets', () => {
  it('encrypts tokens with authenticated encryption and rejects tampering', () => {
    const key = randomBytes(32);
    const sealed = encryptSecret(key, 'access-sandbox-123');
    expect(sealed).not.toContain('access-sandbox');
    expect(decryptSecret(key, sealed)).toBe('access-sandbox-123');
    expect(() => decryptSecret(randomBytes(32), sealed)).toThrow();
    const [v, iv, tag, body] = sealed.split(':');
    const flipped = Buffer.from(body!, 'base64');
    flipped[0]! ^= 1;
    expect(() => decryptSecret(key, [v, iv, tag, flipped.toString('base64')].join(':'))).toThrow();
  });

  it('hashes passwords with a per-user salt', async () => {
    const a = await hashPassword('correct-horse-battery');
    const b = await hashPassword('correct-horse-battery');
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct-horse-battery', a)).toBe(true);
    expect(await verifyPassword('wrong', a)).toBe(false);
  });
});

describe('provider adapter', () => {
  const plaidError = (statusCode: number, body: object) => new PlaidError({ statusCode, body });
  it('maps Plaid errors to provider-neutral codes', () => {
    expect(
      mapPlaidError(plaidError(400, { error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' })).code,
    ).toBe('MUTATION_DURING_PAGINATION');
    expect(mapPlaidError(plaidError(400, { error_code: 'ITEM_LOGIN_REQUIRED' })).code).toBe('LOGIN_REQUIRED');
    expect(mapPlaidError(plaidError(429, { error_type: 'RATE_LIMIT_EXCEEDED' })).code).toBe('RATE_LIMITED');
    expect(mapPlaidError(plaidError(503, {})).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(
      mapPlaidError(plaidError(400, { error_type: 'INSTITUTION_ERROR', error_code: 'INSTITUTION_DOWN' }))
        .transient,
    ).toBe(true);
    expect(mapPlaidError(plaidError(400, { error_code: 'INVALID_ACCESS_TOKEN' })).code).toBe(
      'LOGIN_REQUIRED',
    );
    expect(mapPlaidError(new PlaidError({ message: 'network' })).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(
      () => mapPlaidError(new TypeError('mapping bug')),
      'local bugs must not look like outages',
    ).toThrow(TypeError);
    expect(mapPlaidError(plaidError(400, { error_code: 'INVALID_FIELD' })).transient).toBe(false);
  });

  it('syncs each item with its own profile and token, never another profile', async () => {
    const { db, sync } = setup();
    const seen: { profile: string; dataset: string }[] = [];
    const fixture = new FixtureProvider();
    const providerFor: ProviderResolver = (profile) => ({
      syncPage: (token, cursor, count) => {
        seen.push({ profile: profile.name, dataset: (JSON.parse(token) as { dataset: string }).dataset });
        return fixture.syncPage(token, cursor, count);
      },
      getAccounts: (token) => fixture.getAccounts(token),
    });
    const itemFor = (profileName: string, dataset: string) => {
      const profileId = randomUUID();
      db.insert(providerProfiles).values({ id: profileId, name: profileName, environment: 'fixture' }).run();
      const id = randomUUID();
      const token = JSON.stringify({ dataset, anchor: '2026-11-01', seed: 9 });
      db.insert(items)
        .values({
          id,
          profileId,
          providerItemId: 'shared-provider-item-id',
          accessTokenEnc: encryptSecret(masterKey, token),
        })
        .run();
      return id;
    };
    const a = itemFor('profile-a', 'household-bank');
    const b = itemFor('profile-b', 'household-card');
    await syncItem({ ...sync, providerFor }, a, 'manual');
    await syncItem({ ...sync, providerFor }, b, 'manual');
    expect(new Set(seen.map((s) => `${s.profile}:${s.dataset}`))).toEqual(
      new Set(['profile-a:household-bank', 'profile-b:household-card']),
    );
  });
});
