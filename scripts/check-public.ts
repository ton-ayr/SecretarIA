// Barra o que não pode ir para o repositório público: tokens, arquivos de
// segredo, IDs na configuração e qualquer valor do .dev.vars. Sem .dev.vars
// (no CI), só as regras fixas valem. Nunca mostra o valor achado.
// Roda a cada commit (.githooks/pre-commit) e no CI.
//
//   npm run check:public

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDevVars } from './lib/dev-vars.ts';
import { ROOT } from './lib/memory-db.ts';
import { checkFile, privateTerms, type Finding } from './lib/public-check.ts';

// Só hashes de pacotes: dariam falso alarme nos padrões de token.
const SKIPPED = new Set(['package-lock.json']);

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
const terms = privateTerms(readDevVars());

const findings: Finding[] = [];
for (const file of files) {
  const path = join(ROOT, file);
  if (SKIPPED.has(file) || !existsSync(path)) continue;
  findings.push(...checkFile(file, readFileSync(path, 'utf8'), terms));
}

if (findings.length) {
  console.error('Isto não pode ir para o repositório público:');
  for (const f of findings) console.error(`  ${f.file}:${f.line} — ${f.reason}`);
  process.exit(1);
}
console.log(`Nada sensível em ${files.length} arquivos (${terms.length} termos privados conferidos).`);
