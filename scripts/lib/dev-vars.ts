import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './memory-db.ts';

// Leitura e escrita do .dev.vars e execução do Wrangler sem shell.
// Nada aqui imprime valores de segredos.

export const DEV_VARS = join(ROOT, '.dev.vars');

/** Identificam a conta: fora do git, vão junto com o deploy de cada Worker. */
export const DEPLOY_VARS = {
  bot: ['WORKERSAI_ACCOUNT_ID', 'PUBLIC_BASE_URL'],
  admin: ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD'],
} as const;

export function readDevVars(): Map<string, string> {
  const vars = new Map<string, string>();
  if (!existsSync(DEV_VARS)) return vars;
  for (const line of readFileSync(DEV_VARS, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars.set(m[1]!, value);
  }
  return vars;
}

/** Acrescenta ou troca chaves no .dev.vars, preservando o resto do arquivo. */
export function writeDevVars(updates: Record<string, string>): void {
  const lines = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, 'utf8').split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));
  const out = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m && pending.has(m[1]!)) {
      const v = pending.get(m[1]!)!;
      pending.delete(m[1]!);
      return `${m[1]}=${v}`;
    }
    return line;
  });
  while (out.length && out.at(-1) === '') out.pop();
  for (const [k, v] of pending) out.push(`${k}=${v}`);
  writeFileSync(DEV_VARS, `${out.join('\n')}\n`);
}

const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** Roda o Wrangler direto pelo Node (sem shell: nada de escapar aspas). */
export function wrangler(args: string[], input?: string): number {
  const res = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
  });
  return res.status ?? 1;
}

export function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** --local ou --remote é obrigatório: nunca mexer na produção por engano. */
export function targetFlag(args: string[]): '--local' | '--remote' {
  const local = args.includes('--local');
  const remote = args.includes('--remote');
  if (local === remote) {
    console.error('Informe --local (banco do seu computador) ou --remote (produção).');
    process.exit(2);
  }
  return remote ? '--remote' : '--local';
}
