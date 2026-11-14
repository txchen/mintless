import { randomBytes, randomUUID } from 'node:crypto';
import { createApi } from '../src/server/app.ts';
import { encryptSecret, hashPassword } from '../src/server/crypto.ts';
import { openDb, type Db } from '../src/server/db/client.ts';
import { items, providerProfiles, users } from '../src/server/db/schema.ts';
import type { ProviderResolver, SyncDeps } from '../src/server/sync/engine.ts';
import { FixtureProvider } from '../src/server/sync/fixture-provider.ts';
import type { TransactionsProvider } from '../src/server/sync/provider.ts';

export const masterKey = randomBytes(32);

export function setup(opts: { path?: string; provider?: TransactionsProvider } = {}) {
  const db = openDb(opts.path ?? ':memory:');
  const provider = opts.provider ?? new FixtureProvider();
  const providerFor: ProviderResolver = () => provider;
  const sync: SyncDeps = { db, masterKey, providerFor, sleep: async () => {} };
  const api = createApi({ db, masterKey, sessionTtlMs: 3600_000, sync, now: Date.now });
  return { db, sync, api };
}

export function addFixtureItem(
  db: Db,
  dataset: 'household-bank' | 'household-card' = 'household-bank',
  seed = 42,
) {
  let profile = db.select().from(providerProfiles).get();
  if (!profile) {
    profile = {
      id: randomUUID(),
      name: 'Fixtures',
      environment: 'fixture',
      clientId: null,
      secretRef: null,
      createdAt: 0,
    };
    db.insert(providerProfiles).values(profile).run();
  }
  const id = randomUUID();
  const token = JSON.stringify({ dataset, anchor: '2026-11-01', seed });
  db.insert(items)
    .values({
      id,
      profileId: profile.id,
      providerItemId: `fx-${dataset}-${seed}`,
      accessTokenEnc: encryptSecret(masterKey, token),
    })
    .run();
  return id;
}

export async function addUser(
  db: Db,
  username: string,
  role: 'admin' | 'member',
  password = 'correct-horse-battery',
) {
  const id = randomUUID();
  db.insert(users)
    .values({ id, username, role, passwordHash: await hashPassword(password) })
    .run();
  return id;
}

type Api = ReturnType<typeof createApi>;
type Call = (path: string, init?: RequestInit) => Response | Promise<Response>;

export async function shareInGroup(call: Call, name: string, accountIds: string[], memberIds: string[]) {
  const created = await call('/admin/groups', { method: 'POST', body: JSON.stringify({ name }) });
  if (created.status !== 201) throw new Error(`group create failed ${created.status}`);
  const { id } = (await created.json()) as { id: string };
  for (const accountId of accountIds) {
    const moved = await call(`/admin/accounts/${accountId}/move`, {
      method: 'POST',
      body: JSON.stringify({ groupId: id, fromGroupId: 'unassigned' }),
    });
    if (moved.status !== 204) throw new Error(`move failed ${moved.status}`);
  }
  const set = await call(`/admin/groups/${id}/members`, {
    method: 'PUT',
    body: JSON.stringify({ userIds: memberIds }),
  });
  if (set.status !== 204) throw new Error(`members failed ${set.status}`);
  return id;
}

export async function login(api: Api, username: string, password = 'correct-horse-battery') {
  const res = await api.request('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) throw new Error(`login failed ${res.status}`);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  const call = (path: string, init: RequestInit = {}) =>
    api.request(`/api${path}`, {
      ...init,
      headers: {
        cookie,
        'x-csrf-token': csrfToken,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string>),
      },
    });
  return { cookie, csrfToken, call };
}
