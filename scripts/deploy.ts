// Publica um Worker levando junto a configuração que fica fora do git (IDs da
// conta e endereços), lida do .dev.vars. Vai tudo na mesma versão, então o
// Worker nunca fica no ar sem esses valores. Os outros segredos seguem em
// npm run secrets -- enviar (o deploy não apaga segredos).
//
//   npm run deploy:bot
//   npm run deploy:admin -- --dry-run

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPLOY_VARS, readDevVars, wrangler } from './lib/dev-vars.ts';

const CONFIGS = { bot: 'wrangler.jsonc', admin: 'wrangler.admin.jsonc' } as const;

const target = process.argv[2];
if (target !== 'bot' && target !== 'admin') {
  console.log('Uso: npm run deploy:bot | npm run deploy:admin');
  process.exit(2);
}

const vars = readDevVars();
const payload: Record<string, string> = {};
for (const key of DEPLOY_VARS[target]) {
  const value = vars.get(key)?.trim();
  if (value) payload[key] = value;
  else console.log(`Aviso: ${key} vazio no .dev.vars (fica o valor já publicado, se houver).`);
}

const dir = mkdtempSync(join(tmpdir(), 'secretaria-deploy-'));
try {
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  const args = ['deploy', '-c', CONFIGS[target], ...process.argv.slice(3)];
  if (Object.keys(payload).length) args.push('--secrets-file', file);
  process.exitCode = wrangler(args);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
