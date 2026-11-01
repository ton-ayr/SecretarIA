import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';

// D1 local via getPlatformProxy (API pública do Wrangler), com as migrations
// e, opcionalmente, o seed.
// - persist: false → banco em memória (testes e evals);
// - persist: true  → mesmo banco do `wrangler d1 ... --local` (simulador).

export const ROOT = join(import.meta.dirname, '..', '..');

/** Divide um arquivo SQL em instruções (ponto e vírgula no fim da linha). */
export function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function applyFile(db: D1Database, path: string): Promise<void> {
  const stmts = splitSql(readFileSync(path, 'utf8'));
  await db.batch(stmts.map((s) => db.prepare(s)));
}

/** Variáveis do wrangler.jsonc mais segredos do .dev.vars (se existir). */
export type LocalEnv = Record<string, unknown> & { DB: D1Database };

export interface LocalPlatform {
  env: LocalEnv;
  db: D1Database;
  dispose(): Promise<void>;
}

export async function openLocalPlatform(opts: { persist: boolean }): Promise<LocalPlatform> {
  const proxy = await getPlatformProxy<LocalEnv>({
    configPath: join(ROOT, 'wrangler.jsonc'),
    persist: opts.persist,
    remoteBindings: false,
  });
  return { env: proxy.env, db: proxy.env.DB, dispose: () => proxy.dispose() };
}

export async function createMemoryDb(opts: { seed?: boolean } = {}): Promise<LocalPlatform> {
  const platform = await openLocalPlatform({ persist: false });
  const migrationsDir = join(ROOT, 'migrations');
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await applyFile(platform.db, join(migrationsDir, file));
  }
  if (opts.seed) await applyFile(platform.db, join(ROOT, 'seed', 'seed.sql'));
  return platform;
}

/** IDs fixos do seed. */
export const SEED = {
  barber: {
    tenantId: '01K6SEED00000000000000TA01',
    phoneNumberId: '01K6SEED00000000000000PA01',
    metaPhoneNumberId: '100000000000001',
  },
  dental: {
    tenantId: '01K6SEED00000000000000TB01',
    phoneNumberId: '01K6SEED00000000000000PB01',
    metaPhoneNumberId: '100000000000002',
  },
} as const;
