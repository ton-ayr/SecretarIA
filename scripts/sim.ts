// Simulador de terminal: conversa com o bot sem WhatsApp, usando o D1 local.
//
//   npm run sim                 IA real (chave no .dev.vars)
//   npm run sim -- --fake       IA falsa, sem gastar cota
//   npm run sim -- --empresa dentista
//   npm run sim -- --logs       mostra os logs JSON de cada turno
//
// Antes, uma vez: npm run db:migrate:local && npm run db:seed:local

import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { D1Repo } from '../src/adapters/d1-repo.ts';
import { EchoLLM } from '../src/adapters/fake-llm.ts';
import { buildLLMChain, type LLMEnv } from '../src/adapters/llm-config.ts';
import { ConversationEngine, type TurnResult } from '../src/core/engine.ts';
import { DEFAULT_PRICING } from '../src/core/pricing.ts';
import { parseQuotaLimits } from '../src/core/quota.ts';
import type { LLMProvider } from '../src/ports/llm.ts';
import { systemClock } from '../src/ports/runtime.ts';
import { JsonLogger, MemoryLogger } from '../src/shared/logger.ts';
import { openLocalPlatform, SEED } from './lib/memory-db.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const COMPANIES: Record<string, { label: string; meta: string }> = {
  barbearia: { label: 'Barbearia do Zé', meta: SEED.barber.metaPhoneNumberId },
  dentista: { label: 'Sorriso Clínica Odontológica', meta: SEED.dental.metaPhoneNumberId },
};

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function describeTurn(r: TurnResult): string {
  const parts = [
    r.outcome,
    r.provider ? `${r.provider}:${r.model}` : null,
    r.llmRequests ? `${r.llmRequests} req` : null,
    r.llmRequests ? `${r.usage.inputTokens}→${r.usage.outputTokens} tokens` : null,
    `${r.latencyMs} ms`,
  ];
  return dim(`  [${parts.filter(Boolean).join(' · ')}]`);
}

async function main(): Promise<void> {
  const platform = await openLocalPlatform({ persist: true });
  const env = platform.env as unknown as LLMEnv & Record<string, string | undefined>;

  const tables = await platform.db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'tenants'")
    .first<{ n: number }>();
  if (!tables?.n) {
    console.log('Banco local vazio. Rode antes: npm run db:migrate:local && npm run db:seed:local');
    await platform.dispose();
    return;
  }

  let llm: LLMProvider;
  if (flag('fake')) {
    llm = new EchoLLM();
  } else {
    const built = buildLLMChain(env);
    if (built.providers.length === 0) {
      console.log('Nenhum provedor de IA configurado. Preencha GROQ_API_KEY no .dev.vars ou use --fake.');
      await platform.dispose();
      return;
    }
    if (built.skipped.length) console.log(dim(`Provedores sem chave (ignorados): ${built.skipped.join(', ')}`));
    llm = built.chain;
  }

  const showLogs = flag('logs');
  const engine = new ConversationEngine({
    repo: new D1Repo(platform.db),
    llm,
    clock: systemClock,
    logger: showLogs ? new JsonLogger() : new MemoryLogger(),
    config: {
      pricing: DEFAULT_PRICING,
      quotaLimits: parseQuotaLimits(env.LLM_DAILY_LIMITS),
      logHashKey: env.LOG_HASH_KEY ?? 'simulador',
    },
  });

  let company = COMPANIES[option('empresa') ?? 'barbearia'] ? (option('empresa') ?? 'barbearia') : 'barbearia';
  let waId = `55000000${Date.now().toString().slice(-5)}`;

  console.log(bold(`\nSimulador SecretárIA — ${COMPANIES[company]!.label}${flag('fake') ? ' (IA falsa)' : ''}`));
  console.log(dim('Comandos: /novo (novo cliente) · /empresa barbearia|dentista · /sair'));
  console.log(dim('Use " | " para mandar várias mensagens seguidas no mesmo turno: oi | quero marcar\n'));

  const rl = createInterface({ input: stdin, output: stdout });
  // Com entrada por pipe, o readline fecha antes de terminar a fila.
  let inputClosed = false;
  rl.on('close', () => (inputClosed = true));
  const prompt = () => {
    if (!inputClosed) rl.prompt();
  };
  rl.setPrompt(bold('você › '));
  prompt();
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) {
        prompt();
        continue;
      }
      if (line === '/sair') break;
      if (line === '/novo') {
        waId = `55000000${Date.now().toString().slice(-5)}`;
        console.log(dim('  novo cliente'));
        prompt();
        continue;
      }
      if (line.startsWith('/empresa')) {
        const name = line.split(/\s+/)[1] ?? '';
        if (COMPANIES[name]) {
          company = name;
          console.log(dim(`  agora: ${COMPANIES[name]!.label}`));
        } else {
          console.log(dim(`  empresas: ${Object.keys(COMPANIES).join(', ')}`));
        }
        prompt();
        continue;
      }

      const texts = line.split(' | ').map((s) => s.trim()).filter(Boolean);
      const now = new Date().toISOString();
      const result = await engine.handleTurn({
        metaPhoneNumberId: COMPANIES[company]!.meta,
        waId,
        profileName: 'Cliente Simulado',
        messages: texts.map((text, i) => ({ text, waMessageId: `sim.${Date.now()}.${i}`, at: now })),
      });

      if (result.reply) console.log(`${bold('bot ›')} ${result.reply.text}`);
      else console.log(dim('  (sem resposta)'));
      console.log(describeTurn(result));

      if (result.summaryJob) {
        const ok = await engine.runSummary(result.summaryJob);
        if (ok) console.log(dim('  (resumo da conversa atualizado)'));
      }
      prompt();
    }
  } finally {
    rl.close();
    await platform.dispose();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
