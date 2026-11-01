// Agenda Google da empresa (conta de serviço) pelo terminal. A chave só se
// configura aqui; conectar e testar a agenda também dá pelo painel (aba Agenda).
//
//   npm run google -- chave C:\caminho\da\chave.json
//       guarda a chave no .dev.vars (base64, só e-mail + chave privada)
//       e mostra o e-mail da conta de serviço para compartilhar a agenda
//
//   npm run google -- testar --agenda email-da-agenda@gmail.com
//       confere se a conta de serviço lê e escreve nessa agenda
//
//   npm run google -- conectar --empresa barbearia --agenda email@gmail.com --remote
//       testa e liga a agenda à empresa (marcações viram eventos lá)
//
//   npm run google -- desconectar --empresa barbearia --remote
//
// Depois de "chave", envie o segredo ao Worker: npm run secrets -- enviar

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { GoogleCalendarClient, parseServiceAccount } from '../src/adapters/google-calendar.ts';
import { checkCalendarAccess } from '../src/core/calendar-check.ts';
import { flagValue, readDevVars, targetFlag, wrangler, writeDevVars } from './lib/dev-vars.ts';
import { SEED } from './lib/memory-db.ts';

const args = process.argv.slice(2);
const command = args[0];

const TENANT_ALIASES: Record<string, string> = {
  barbearia: SEED.barber.tenantId,
  dentista: SEED.dental.tenantId,
};

// E-mail da agenda (pessoal ou "...@group.calendar.google.com"). Sem aspas:
// o valor entra no comando SQL.
const CALENDAR_ID_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function tenantArg(): string {
  const empresa = flagValue(args, 'empresa') ?? '';
  if (!/^[A-Za-z0-9]+$/.test(empresa)) throw new Error('--empresa: barbearia, dentista ou o id da empresa.');
  return TENANT_ALIASES[empresa] ?? empresa;
}

function calendarArg(): string {
  const id = (flagValue(args, 'agenda') ?? '').trim();
  if (!CALENDAR_ID_RE.test(id)) throw new Error('--agenda: o ID da agenda (um e-mail, ex.: barbearia@gmail.com).');
  return id;
}

function client(): GoogleCalendarClient {
  const raw = readDevVars().get('GOOGLE_SERVICE_ACCOUNT')?.trim();
  if (!raw) throw new Error('Falta a chave. Rode antes: npm run google -- chave <arquivo.json>');
  return new GoogleCalendarClient(parseServiceAccount(raw));
}

/** Lê os ocupados e cria/apaga um evento de teste (mesma conferência do painel). */
async function check(calendarId: string): Promise<boolean> {
  const r = await checkCalendarAccess(client(), calendarId, new Date());
  if (r.read) console.log(`✔ Leitura ok (${r.busy} bloqueio(s) nos próximos 7 dias).`);
  if (r.write) console.log('✔ Escrita ok (evento de teste criado e apagado).');
  if (r.problem) console.error(`✗ ${r.problem}`);
  return r.read && r.write;
}

async function main(): Promise<void> {
  if (command === 'chave') {
    const file = args[1];
    if (!file) throw new Error('Informe o arquivo: npm run google -- chave C:\\caminho\\da\\chave.json');
    const path = resolve(file);
    const json = JSON.parse(readFileSync(path, 'utf8')) as { type?: string; client_email?: string; private_key?: string };
    if (json.type !== 'service_account' || !json.client_email || !json.private_key) {
      throw new Error('Esse arquivo não é a chave JSON de uma conta de serviço do Google.');
    }
    // Só o necessário: cabe no limite de tamanho de segredo do Worker.
    const minimal = JSON.stringify({ client_email: json.client_email, private_key: json.private_key });
    writeDevVars({ GOOGLE_SERVICE_ACCOUNT: Buffer.from(minimal, 'utf8').toString('base64') });
    console.log('Chave guardada no .dev.vars (GOOGLE_SERVICE_ACCOUNT).');
    console.log(`\nE-mail da conta de serviço (compartilhe a agenda com ele):\n${json.client_email}\n`);
    if (!relative(process.cwd(), path).startsWith('..')) {
      console.log('⚠ O arquivo da chave está dentro da pasta do projeto. Mova para fora (ou apague): ele não pode ir para o git.');
    }
    console.log('Próximo passo: npm run secrets -- enviar   (leva a chave para o Worker)');
    return;
  }

  if (command === 'testar') {
    process.exit((await check(calendarArg())) ? 0 : 1);
  }

  if (command === 'conectar') {
    const target = targetFlag(args);
    const tenantId = tenantArg();
    const calendarId = calendarArg();
    if (!(await check(calendarId))) process.exit(1);
    const sql = `UPDATE tenants SET google_calendar_id = '${calendarId}' WHERE id = '${tenantId}'`;
    const status = wrangler(['d1', 'execute', 'secretaria', target, '--command', sql]);
    if (status !== 0) process.exit(status);
    console.log('\nAgenda conectada. Novas marcações aparecem lá, e o que você bloquear lá some dos horários livres.');
    return;
  }

  if (command === 'desconectar') {
    const target = targetFlag(args);
    const sql = `UPDATE tenants SET google_calendar_id = NULL WHERE id = '${tenantArg()}'`;
    process.exit(wrangler(['d1', 'execute', 'secretaria', target, '--command', sql]));
  }

  console.log('Uso: npm run google -- chave <arquivo.json> | testar --agenda ... | conectar --empresa ... --agenda ... --remote | desconectar --empresa ... --remote');
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
