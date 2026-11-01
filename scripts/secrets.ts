// Segredos do bot, sem nunca mostrá-los na tela.
//
//   npm run secrets -- gerar     cria no .dev.vars as chaves aleatórias que faltam
//   npm run secrets -- conferir  mostra quais segredos estão preenchidos
//   npm run secrets -- enviar    envia os segredos do .dev.vars para a Cloudflare
//   npm run secrets -- enviar-admin  envia ADMIN_EMAILS para o Worker do painel
//
// Atenção: ENCRYPTION_KEY nunca é trocada se já existir. Trocar a chave
// torna ilegíveis os tokens já cifrados no banco.

import { generateKey } from '../src/shared/crypto.ts';
import { DEPLOY_VARS, readDevVars, wrangler, writeDevVars } from './lib/dev-vars.ts';

/** Segredos que o Worker usa (wrangler secret). */
const WORKER_SECRETS = [
  'META_APP_SECRET',
  'META_VERIFY_TOKEN',
  'ENCRYPTION_KEY',
  'LOG_HASH_KEY',
  'GROQ_API_KEY',
  'WORKERSAI_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'GOOGLE_SERVICE_ACCOUNT',
] as const;

/** Gerados aqui (o resto vem dos painéis da Meta, Groq e Cloudflare). */
const GENERATED: Record<string, () => string> = {
  // Sem + / = para poder colar no painel da Meta sem surpresas.
  META_VERIFY_TOKEN: () => generateKey().replace(/[+/=]/g, ''),
  ENCRYPTION_KEY: () => generateKey(),
  LOG_HASH_KEY: () => generateKey().replace(/[+/=]/g, ''),
  // O Telegram aceita só A-Z, a-z, 0-9, _ e - no secret_token.
  TELEGRAM_WEBHOOK_SECRET: () => generateKey().replace(/[+/=]/g, ''),
};

/** Ficam só no computador: nunca vão para a Cloudflare. */
const LOCAL_ONLY = ['META_ACCESS_TOKEN', 'WHATSAPP_DRY_RUN'];

const command = process.argv[2];
const vars = readDevVars();
const filled = (k: string) => (vars.get(k) ?? '').trim().length > 0;

if (command === 'gerar') {
  const created: Record<string, string> = {};
  for (const [key, gen] of Object.entries(GENERATED)) {
    // Troca também o texto de exemplo que veio no .dev.vars.example.
    if (!filled(key) || vars.get(key)!.startsWith('troque-')) created[key] = gen();
  }
  if (Object.keys(created).length) writeDevVars(created);
  console.log(Object.keys(created).length ? `Criados no .dev.vars: ${Object.keys(created).join(', ')}` : 'Nada a criar.');
} else if (command === 'conferir') {
  for (const key of [...WORKER_SECRETS, 'META_ACCESS_TOKEN']) {
    console.log(`${filled(key) ? '✔' : '✗'} ${key}${LOCAL_ONLY.includes(key) ? ' (só local)' : ''}`);
  }
  console.log(`${filled('ADMIN_EMAILS') ? '✔' : '✗'} ADMIN_EMAILS (painel)`);
  for (const key of [...DEPLOY_VARS.bot, ...DEPLOY_VARS.admin]) {
    console.log(`${filled(key) ? '✔' : '✗'} ${key} (vai no deploy)`);
  }
} else if (command === 'enviar') {
  const payload: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of WORKER_SECRETS) {
    if (filled(key)) payload[key] = vars.get(key)!;
    else missing.push(key);
  }
  if (missing.length) console.log(`Faltando no .dev.vars (não enviados): ${missing.join(', ')}`);
  if (!Object.keys(payload).length) process.exit(1);
  console.log(`Enviando para a Cloudflare: ${Object.keys(payload).join(', ')}`);
  // JSON pela entrada padrão: os valores não aparecem na linha de comando.
  process.exit(wrangler(['secret', 'bulk'], JSON.stringify(payload)));
} else if (command === 'enviar-admin') {
  // Quem pode entrar no painel (além da política do Access). Fora do git.
  const emails = (vars.get('ADMIN_EMAILS') ?? '').trim();
  if (!emails) {
    console.log('Preencha ADMIN_EMAILS no .dev.vars (e-mails separados por vírgula).');
    process.exit(1);
  }
  console.log('Enviando ADMIN_EMAILS para o Worker do painel (secretaria-admin)…');
  process.exit(wrangler(['secret', 'bulk', '-c', 'wrangler.admin.jsonc'], JSON.stringify({ ADMIN_EMAILS: emails })));
} else {
  console.log('Uso: npm run secrets -- gerar | conferir | enviar | enviar-admin');
  process.exit(2);
}
