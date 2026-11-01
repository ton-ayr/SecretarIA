// Cadastro da conta Meta e do número de WhatsApp pelo terminal. O caminho
// normal agora é o painel (Contas Meta e aba WhatsApp da empresa).
//
//   npm run meta -- conta --waba <WABA_ID> --remote
//       cifra o META_ACCESS_TOKEN do .dev.vars com a ENCRYPTION_KEY e grava
//
//   npm run meta -- numero --empresa barbearia --phone-id <PHONE_NUMBER_ID>
//                          --telefone "+1 555 000 0100" --waba <WABA_ID> --remote
//       liga o número da Meta ao número da empresa (troca o número de exemplo)
//
// Use --local para o banco do seu computador ou --remote para a produção.

import { encryptSecret } from '../src/shared/crypto.ts';
import { ulid } from '../src/shared/ids.ts';
import { flagValue, readDevVars, targetFlag, wrangler } from './lib/dev-vars.ts';
import { SEED } from './lib/memory-db.ts';

const args = process.argv.slice(2);
const command = args[0];

const TENANT_ALIASES: Record<string, string> = {
  barbearia: SEED.barber.tenantId,
  dentista: SEED.dental.tenantId,
};

function required(name: string, pattern: RegExp, hint: string): string {
  const value = flagValue(args, name);
  if (!value || !pattern.test(value)) {
    console.error(`--${name} inválido ou ausente (${hint}).`);
    process.exit(2);
  }
  return value;
}

function runSql(target: string, sql: string): never {
  process.exit(wrangler(['d1', 'execute', 'secretaria', target, '--command', sql]));
}

async function main(): Promise<void> {
  if (command === 'conta') {
    const target = targetFlag(args);
    const waba = required('waba', /^\d{5,30}$/, 'só números');
    const vars = readDevVars();
    const token = vars.get('META_ACCESS_TOKEN')?.trim();
    const key = vars.get('ENCRYPTION_KEY')?.trim();
    if (!token) throw new Error('Coloque o token permanente em META_ACCESS_TOKEN no .dev.vars.');
    if (!key) throw new Error('Falta ENCRYPTION_KEY no .dev.vars (rode: npm run secrets -- gerar).');
    const sealed = await encryptSecret(key, token);
    const now = new Date().toISOString();
    console.log(`Gravando a conta Meta ${waba} (token cifrado) em ${target === '--remote' ? 'produção' : 'local'}…`);
    runSql(
      target,
      `INSERT INTO meta_accounts (id, waba_id, access_token_enc, key_version, created_at)
       VALUES ('${ulid()}', '${waba}', '${sealed}', 1, '${now}')
       ON CONFLICT (waba_id) DO UPDATE SET access_token_enc = excluded.access_token_enc, key_version = excluded.key_version`,
    );
  }

  if (command === 'numero') {
    const target = targetFlag(args);
    const empresa = required('empresa', /^[A-Za-z0-9]+$/, 'barbearia, dentista ou o id da empresa');
    const tenantId = TENANT_ALIASES[empresa] ?? empresa;
    const phoneId = required('phone-id', /^\d{5,30}$/, 'só números');
    const display = required('telefone', /^[+\d\s()-]{8,25}$/, 'ex.: "+1 555 000 0100"');
    const waba = required('waba', /^\d{5,30}$/, 'só números');
    console.log(`Ligando o número ${display} à empresa ${empresa}…`);
    runSql(
      target,
      `UPDATE phone_numbers SET meta_phone_number_id = '${phoneId}', display_phone = '${display}',
         meta_account_id = (SELECT id FROM meta_accounts WHERE waba_id = '${waba}')
       WHERE tenant_id = '${tenantId}' AND kind = 'whatsapp'`,
    );
  }

  console.log('Uso: npm run meta -- conta ... | numero ... (veja o topo de scripts/meta.ts)');
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
