// Exclusão dos dados de um contato (LGPD) pelo terminal.
//
//   npm run lgpd:apagar -- --empresa barbearia --telefone 5519999999999 --remote
//
// Registra o pedido no banco; o bot apaga tudo (D1, agenda Google e estado
// da conversa) no cron de manutenção, em até 1 hora. Pelo painel (botão
// "Apagar dados do contato" na conversa) é na hora.

import { ulid } from '../src/shared/ids.ts';
import { flagValue, targetFlag, wrangler } from './lib/dev-vars.ts';
import { SEED } from './lib/memory-db.ts';

const args = process.argv.slice(2);
const command = args[0];

const TENANT_ALIASES: Record<string, string> = {
  barbearia: SEED.barber.tenantId,
  dentista: SEED.dental.tenantId,
};

function main(): void {
  if (command !== 'apagar') {
    console.log('Uso: npm run lgpd:apagar -- --empresa <id> --telefone <55DDDNÚMERO> --local|--remote');
    process.exit(2);
  }
  const target = targetFlag(args);
  const empresa = flagValue(args, 'empresa') ?? '';
  if (!/^[A-Za-z0-9]{3,40}$/.test(empresa)) throw new Error('--empresa: barbearia, dentista ou o id da empresa (painel).');
  const tenantId = TENANT_ALIASES[empresa] ?? empresa;
  const phone = (flagValue(args, 'telefone') ?? '').replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(phone)) throw new Error('--telefone: só números, com DDI (ex.: 5519999999999).');

  // Valores já validados (letras e números): seguros no SQL.
  const sql = `INSERT OR IGNORE INTO erasure_requests (id, tenant_id, wa_id, requested_at)
    SELECT '${ulid()}', t.id, '${phone}', '${new Date().toISOString()}' FROM tenants t WHERE t.id = '${tenantId}'`;
  const status = wrangler(['d1', 'execute', 'secretaria', target, '--command', sql]);
  if (status !== 0) process.exit(status);
  console.log('\nPedido registrado. O bot apaga os dados em até 1 hora (se a empresa e o telefone existirem).');
  console.log('Para apagar na hora, use o botão "Apagar dados do contato" na conversa, no painel.');
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
