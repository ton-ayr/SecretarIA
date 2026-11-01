// Simula a Meta chamando o webhook do `npm run dev:bot` (no seu computador),
// com assinatura válida. A resposta aparece no terminal do dev:bot.
//
//   npm run webhook:local -- "oi, quanto custa o corte?"
//   npm run webhook:local -- "quero marcar" --de 5511999990001 --phone-id 100000000000002
//   npm run webhook:local -- --repetir     reenvia a última mensagem (testa a idempotência)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signBody } from '../src/shared/signature.ts';
import { flagValue, readDevVars } from './lib/dev-vars.ts';
import { ROOT } from './lib/memory-db.ts';

const args = process.argv.slice(2);
const LAST = join(ROOT, '.wrangler', 'webhook-local-last.json');

async function main(): Promise<void> {
  const secret = flagValue(args, 'secret') ?? readDevVars().get('META_APP_SECRET') ?? 'local-test';
  const url = flagValue(args, 'url') ?? 'http://127.0.0.1:8787/webhook';

  let body: string;
  if (args.includes('--repetir') && existsSync(LAST)) {
    body = readFileSync(LAST, 'utf8');
  } else {
    const text = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'oi';
    const from = flagValue(args, 'de') ?? '5511999990001';
    const phoneId = flagValue(args, 'phone-id') ?? '100000000000001';
    body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA-LOCAL',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550000000', phone_number_id: phoneId },
                contacts: [{ profile: { name: 'Teste Local' }, wa_id: from }],
                messages: [
                  {
                    from,
                    id: `wamid.local.${Date.now()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    writeFileSync(LAST, body);
  }

  const sig = await signBody(secret, new TextEncoder().encode(body));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${sig}` },
    body,
  });
  console.log(`webhook → HTTP ${res.status} ${await res.text()}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
