// Administração do bot do Telegram pelo terminal. O link de vínculo da equipe
// também sai pelo painel (aba Equipe); configurar o webhook e o operador, só aqui.
//
//   npm run telegram -- configurar --url https://secretaria-bot.SEU-SUBDOMINIO.workers.dev
//       registra o webhook do bot (POST /telegram/webhook) com o segredo
//
//   npm run telegram -- vincular --empresa barbearia --remote [--rotulo Dono]
//       gera um link de uso único (24 h) para a equipe da empresa receber avisos
//
//   npm run telegram -- operador --remote
//       gera um link de uso único (24 h) para você receber os alertas do operador
//
// Lê TELEGRAM_BOT_TOKEN e TELEGRAM_WEBHOOK_SECRET do .dev.vars.

import { OPERATOR_LINK_KEY } from '../src/adapters/telegram-notifier.ts';
import { TelegramClient } from '../src/adapters/telegram.ts';
import { randomToken } from '../src/shared/crypto.ts';
import { ulid } from '../src/shared/ids.ts';
import { flagValue, readDevVars, targetFlag, wrangler } from './lib/dev-vars.ts';
import { SEED } from './lib/memory-db.ts';

const args = process.argv.slice(2);
const command = args[0];
const LINK_TTL_MS = 24 * 60 * 60 * 1000;

const TENANT_ALIASES: Record<string, string> = {
  barbearia: SEED.barber.tenantId,
  dentista: SEED.dental.tenantId,
};

function botClient(): TelegramClient {
  const token = readDevVars().get('TELEGRAM_BOT_TOKEN')?.trim();
  if (!token) throw new Error('Coloque o token do @BotFather em TELEGRAM_BOT_TOKEN no .dev.vars.');
  return new TelegramClient(token);
}

async function main(): Promise<void> {
  if (command === 'configurar') {
    const base = flagValue(args, 'url')?.replace(/\/+$/, '');
    if (!base?.startsWith('https://')) throw new Error('Informe --url com o endereço https do Worker.');
    const secret = readDevVars().get('TELEGRAM_WEBHOOK_SECRET')?.trim();
    if (!secret) throw new Error('Falta TELEGRAM_WEBHOOK_SECRET (rode: npm run secrets -- gerar).');
    const tg = botClient();
    const me = await tg.getMe();
    await tg.setWebhook(`${base}/telegram/webhook`, secret, ['message', 'callback_query']);
    console.log(`Webhook do bot @${me.username} apontado para ${base}/telegram/webhook`);
    return;
  }

  if (command === 'vincular' || command === 'operador') {
    const target = targetFlag(args);
    const me = await botClient().getMe();
    const code = randomToken(32);
    const now = new Date();
    const expires = new Date(now.getTime() + LINK_TTL_MS).toISOString();

    let sql: string;
    let start: string;
    if (command === 'vincular') {
      const empresa = flagValue(args, 'empresa') ?? '';
      if (!/^[A-Za-z0-9]+$/.test(empresa)) throw new Error('--empresa: barbearia, dentista ou o id da empresa.');
      const tenantId = TENANT_ALIASES[empresa] ?? empresa;
      const label = (flagValue(args, 'rotulo') ?? '').replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 30);
      sql = `INSERT INTO notification_channels (id, tenant_id, kind, label, link_code, link_expires_at, active, created_at)
             VALUES ('${ulid()}', '${tenantId}', 'telegram', ${label ? `'${label}'` : 'NULL'}, '${code}', '${expires}', 0, '${now.toISOString()}')`;
      start = code;
    } else {
      sql = `INSERT INTO ops_settings (key, value, updated_at) VALUES ('${OPERATOR_LINK_KEY}', '${code}|${expires}', '${now.toISOString()}')
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
      start = `op_${code}`;
    }
    const status = wrangler(['d1', 'execute', 'secretaria', target, '--command', sql]);
    if (status !== 0) process.exit(status);
    console.log(`\nLink de uso único (vale até ${expires}):\nhttps://t.me/${me.username}?start=${start}\n`);
    console.log('Abra o link no Telegram de quem vai receber os avisos e toque em "Iniciar".');
    return;
  }

  console.log('Uso: npm run telegram -- configurar --url ... | vincular --empresa ... --remote | operador --remote');
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
