import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { and, eq, inArray } from 'drizzle-orm';
import * as v from 'valibot';
import { CreateUserBody, Password } from '../shared/contracts.ts';
import { loadConfig } from './config.ts';
import { hashPassword, randomToken } from './crypto.ts';
import { openDb } from './db/client.ts';
import {
  UNASSIGNED_GROUP_ID,
  accountGroups,
  canonicalAccounts,
  groupMembers,
  sourceAccounts,
  users,
} from './db/schema.ts';
import { createDemoItem } from './http/routes.ts';
import { defaultProviders } from './providers.ts';
import { syncItem } from './sync/engine.ts';
import { patchAnnotation } from './transactions.ts';
import { PasswordInputError, promptHidden, readFirstLine } from './password-input.ts';
import { setPasswordHash } from './users.ts';

const usage = `Usage:
  cli.ts user:create --username NAME --role admin|member   (password from MINTLESS_NEW_PASSWORD or generated)
  cli.ts user:password --username NAME [--password-stdin]
                                     set a new password (prompts twice, hidden); revokes that user's sessions
  cli.ts demo:seed [--member NAME]   create synthetic bank items, sync them, and share demo accounts with a member
  cli.ts demo:advance                sync every demo item once, advancing its scripted lifecycle by one step
  cli.ts backup --out FILE           write a consistent SQLite snapshot (VACUUM INTO)`;

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    username: { type: 'string' },
    role: { type: 'string' },
    member: { type: 'string' },
    out: { type: 'string' },
    'password-stdin': { type: 'boolean' },
  },
});
process.umask(0o077);
const config = loadConfig();
const db = openDb(config.dbPath);
const sync = { db, masterKey: config.masterKey, providerFor: defaultProviders };

async function createUser(username: string, role: string) {
  const generated = !process.env.MINTLESS_NEW_PASSWORD;
  const password = process.env.MINTLESS_NEW_PASSWORD ?? randomToken().slice(0, 20);
  const input = v.parse(CreateUserBody, { username, password, role });
  if (db.select().from(users).where(eq(users.username, input.username)).get())
    throw new Error(`User ${input.username} already exists`);
  const id = randomUUID();
  db.insert(users)
    .values({
      id,
      username: input.username,
      role: input.role,
      passwordHash: await hashPassword(input.password),
    })
    .run();
  console.log(`Created ${input.role} ${input.username}${generated ? ` with password: ${password}` : ''}`);
  return id;
}

switch (command) {
  case 'user:password': {
    if (!values.username) throw new Error(usage);
    const user = db
      .select()
      .from(users)
      .where(eq(users.username, values.username.trim().toLowerCase()))
      .get();
    if (!user) {
      console.error(`No user named ${values.username}; nothing changed.`);
      process.exitCode = 1;
      break;
    }
    try {
      let password: string;
      if (values['password-stdin']) {
        password = await readFirstLine();
      } else {
        password = await promptHidden(`New password for ${user.username}: `);
        const again = await promptHidden('Repeat new password: ');
        if (again !== password) throw new PasswordInputError('Passwords do not match; nothing changed.');
      }
      const checked = v.safeParse(Password, password);
      if (!checked.success) throw new PasswordInputError(`${checked.issues[0].message}; nothing changed.`);
      setPasswordHash(db, user.id, await hashPassword(checked.output), 'cli', Date.now());
      console.log(`Password updated for ${user.username} (${user.role}). Existing sessions were signed out.`);
    } catch (error) {
      if (!(error instanceof PasswordInputError)) throw error;
      console.error(error.message);
      process.exitCode = 1;
    }
    break;
  }
  case 'user:create': {
    if (!values.username || !values.role) throw new Error(usage);
    await createUser(values.username, values.role);
    break;
  }
  case 'demo:seed': {
    const admin = db.select().from(users).where(eq(users.role, 'admin')).get();
    if (!admin) throw new Error('Create an admin first with user:create');
    const anchor = new Date().toISOString().slice(0, 10);
    const createdItems: string[] = [];
    for (const [dataset, seed] of [
      ['household-bank', 4021],
      ['household-card', 7310],
    ] as const) {
      const id = createDemoItem(db, config.masterKey, dataset, anchor, seed);
      createdItems.push(id);
      console.log(dataset, await syncItem(sync, id, 'manual'));
    }
    const memberName = values.member;
    if (memberName) {
      const member = db.select().from(users).where(eq(users.username, memberName)).get();
      if (!member || member.role !== 'member') throw new Error(`Member ${memberName} not found`);
      const demoAccounts = db
        .select({
          id: canonicalAccounts.id,
          name: canonicalAccounts.displayName,
          groupId: canonicalAccounts.groupId,
        })
        .from(canonicalAccounts)
        .innerJoin(sourceAccounts, eq(sourceAccounts.id, canonicalAccounts.primarySourceAccountId))
        .where(inArray(sourceAccounts.itemId, createdItems))
        .all();
      db.transaction((tx) => {
        const groupId =
          tx.select().from(accountGroups).where(eq(accountGroups.name, 'Household')).get()?.id ??
          randomUUID();
        tx.insert(accountGroups).values({ id: groupId, name: 'Household' }).onConflictDoNothing().run();
        tx.insert(groupMembers).values({ groupId, userId: member.id }).onConflictDoNothing().run();
        for (const account of demoAccounts) {
          if (account.name === 'Rainy Day Savings' || account.groupId !== UNASSIGNED_GROUP_ID) continue;
          tx.update(canonicalAccounts)
            .set({ groupId })
            .where(
              and(eq(canonicalAccounts.id, account.id), eq(canonicalAccounts.groupId, UNASSIGNED_GROUP_ID)),
            )
            .run();
        }
      });
      console.log(
        `Put demo accounts except Rainy Day Savings in the Household group and added ${memberName}`,
      );
    }
    const sample = db.query.canonicalTransactions
      .findMany({ where: (t, { eq: is }) => is(t.status, 'pending'), limit: 1 })
      .sync();
    for (const t of sample) {
      patchAnnotation(
        db,
        { kind: 'all' },
        admin.id,
        t.id,
        { revision: 0, note: 'Dinner with Sam; split later', category: 'Dining', tags: ['shared'] },
        Date.now(),
      );
    }
    break;
  }
  case 'demo:advance': {
    for (const item of db.query.items.findMany().sync()) {
      if (item.providerItemId.startsWith('fixture-'))
        console.log(item.providerItemId, await syncItem(sync, item.id, 'manual'));
    }
    break;
  }
  case 'backup': {
    if (!values.out) throw new Error(usage);
    if (existsSync(values.out)) throw new Error(`${values.out} already exists`);
    db.sqlite.prepare('VACUUM INTO ?').run(values.out);
    console.log(`Wrote ${values.out}`);
    break;
  }
  default:
    console.log(usage);
    process.exitCode = command ? 1 : 0;
}
db.sqlite.close();
