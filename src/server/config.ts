import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as v from 'valibot';

const Env = v.object({
  MINTLESS_DATA_DIR: v.optional(v.string(), './data'),
  MINTLESS_HOST: v.optional(v.string(), '127.0.0.1'),
  MINTLESS_PORT: v.optional(
    v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1), v.maxValue(65535)),
    '3000',
  ),
  MINTLESS_MASTER_KEY: v.optional(v.string()),
  MINTLESS_MASTER_KEY_FILE: v.optional(v.string()),
  MINTLESS_DEV: v.optional(v.picklist(['0', '1']), '0'),
  MINTLESS_DEV_ALLOWED_HOSTS: v.optional(v.string(), ''),
  MINTLESS_SESSION_TTL_HOURS: v.optional(v.pipe(v.string(), v.toNumber(), v.minValue(1)), '720'),
  SYNC_INTERVAL_HOURS: v.optional(v.pipe(v.string(), v.toNumber(), v.minValue(0)), '12'),
});

export type Config = {
  dataDir: string;
  dbPath: string;
  host: string;
  port: number;
  masterKey: Buffer;
  dev: boolean;
  devAllowedHosts: string[];
  sessionTtlMs: number;
  syncIntervalMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = v.safeParse(Env, env);
  if (!parsed.success) {
    const issues = parsed.issues.map((i) => `${v.getDotPath(i) ?? '?'}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.output;
  const dataDir = resolve(e.MINTLESS_DATA_DIR);
  return {
    dataDir,
    dbPath: resolve(dataDir, 'mintless.sqlite'),
    host: e.MINTLESS_HOST,
    port: e.MINTLESS_PORT,
    masterKey: readMasterKey(e.MINTLESS_MASTER_KEY, e.MINTLESS_MASTER_KEY_FILE),
    dev: e.MINTLESS_DEV === '1',
    devAllowedHosts: e.MINTLESS_DEV_ALLOWED_HOSTS.split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    sessionTtlMs: e.MINTLESS_SESSION_TTL_HOURS * 3600_000,
    syncIntervalMs: e.SYNC_INTERVAL_HOURS * 3600_000,
  };
}

function readMasterKey(inline: string | undefined, file: string | undefined): Buffer {
  if (inline && file) throw new Error('Set only one of MINTLESS_MASTER_KEY and MINTLESS_MASTER_KEY_FILE');
  const encoded = inline ?? (file ? readFileSync(file, 'utf8').trim() : undefined);
  if (!encoded)
    throw new Error('MINTLESS_MASTER_KEY or MINTLESS_MASTER_KEY_FILE is required (base64, 32 bytes)');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('Master key must decode to exactly 32 bytes');
  return key;
}
