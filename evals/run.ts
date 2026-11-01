// Executor dos evals: roda cada caso num banco em memória com o seed e a IA
// configurada no .dev.vars, e mostra uma tabela de aprovado/reprovado.
//
//   npm run evals                       todos os casos, cadeia do wrangler.jsonc
//   npm run evals -- --only manipulacao um caso
//   npm run evals -- --chain groq:openai/gpt-oss-20b   compara outro modelo
//   npm run evals -- --fake             testa o executor sem gastar cota
//   npm run evals -- --trace            mostra as ferramentas que a IA chamou
//
// Sai com código 1 se algum caso reprovar.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { D1Repo } from '../src/adapters/d1-repo.ts';
import { EchoLLM } from '../src/adapters/fake-llm.ts';
import { buildLLMChain, type LLMEnv } from '../src/adapters/llm-config.ts';
import { ConversationEngine, type TurnResult } from '../src/core/engine.ts';
import { DEFAULT_PRICING } from '../src/core/pricing.ts';
import type { LLMProvider } from '../src/ports/llm.ts';
import type { HandoffNotifier } from '../src/ports/notifier.ts';
import { MemoryLogger } from '../src/shared/logger.ts';
import { createMemoryDb, ROOT, SEED } from '../scripts/lib/memory-db.ts';
import { CASES, checkConversation, EVAL_NOW, type EvalCase, type EvalReply } from './cases.ts';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

interface CaseResult {
  id: string;
  title: string;
  passed: boolean;
  failures: string[];
  reply: string;
  outcome: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  llmRequests: number;
  latencyMs: number;
}

let setTeam: (tenantId: string, active: boolean) => Promise<void> = async () => undefined;
let runSql: (sql: string) => Promise<void> = async () => undefined;

/** Relógio fixo (ver EVAL_NOW), andando 1 s por leitura. */
let clockMs = Date.parse(EVAL_NOW);
const evalClock = { now: () => new Date((clockMs += 1000)) };

async function runCase(engine: ConversationEngine, c: EvalCase, index: number): Promise<CaseResult> {
  const waId = `55999000${String(index).padStart(4, '0')}`;
  const tenantId = SEED[c.company].tenantId;
  if (c.team === false) await setTeam(tenantId, false);
  for (const sql of c.setup ?? []) await runSql(sql);
  let last: TurnResult | null = null;
  const replies: EvalReply[] = [];
  const preFailures: string[] = [];
  const totals = { tokensIn: 0, tokensOut: 0, llmRequests: 0, latencyMs: 0 };
  for (const [i, turn] of c.turns.entries()) {
    const at = evalClock.now().toISOString();
    let message: { text: string; kind?: 'interactive'; replyId?: string };
    if (typeof turn === 'string') {
      message = { text: turn };
    } else {
      // Toque numa opção da última resposta (lista de horários ou botões).
      const choices = [...(last?.reply?.options ?? []), ...(last?.reply?.buttons ?? [])];
      const choice = choices[turn.tap];
      if (!choice) {
        preFailures.push(`não havia opção ${turn.tap + 1} para tocar (a IA não mostrou horários pelo sistema)`);
        break;
      }
      message = { text: choice.title, kind: 'interactive', replyId: choice.id };
    }
    last = await engine.handleTurn({
      metaPhoneNumberId: SEED[c.company].metaPhoneNumberId,
      waId,
      profileName: 'Mariana Souza',
      messages: [{ ...message, waMessageId: `eval.${c.id}.${i}`, at }],
    });
    totals.tokensIn += last.usage.inputTokens;
    totals.tokensOut += last.usage.outputTokens;
    totals.llmRequests += last.llmRequests;
    totals.latencyMs += last.latencyMs;
    replies.push({
      text: last.reply?.text ?? '',
      outcome: last.outcome,
      action: last.action,
      server: Boolean(last.action || last.reply?.options?.length || last.reply?.buttons?.length),
    });
  }
  if (c.team === false) await setTeam(tenantId, true);
  const reply = last?.reply?.text ?? '';
  const failures =
    last && ['replied', 'handoff', 'fixed_reply', 'paused'].includes(last.outcome)
      ? [...preFailures, ...checkConversation(c, replies)]
      : [`resultado ${last?.outcome} (${last?.errorCode ?? '?'}): ${last?.failedAttempts.join('; ') || 'sem tentativas'}`];
  return {
    id: c.id,
    title: c.title,
    passed: failures.length === 0,
    failures,
    reply:
      replies.length > 1
        ? replies
            .map((r, i) => `[${i + 1}${r.outcome === 'handoff' ? ' → equipe' : ''}${r.server ? ' · sistema' : ''}] ${r.text}`)
            .join(' ')
        : reply,
    outcome: last?.outcome ?? 'none',
    provider: last?.provider ? `${last.provider}:${last.model}` : '-',
    ...totals,
  };
}

async function main(): Promise<void> {
  const platform = await createMemoryDb({ seed: true });
  const env = platform.env as unknown as LLMEnv & Record<string, string | undefined>;

  let llm: LLMProvider;
  if (args.includes('--fake')) {
    llm = new EchoLLM();
  } else {
    const built = buildLLMChain({ ...env, LLM_CHAIN: option('chain') ?? env.LLM_CHAIN });
    if (built.providers.length === 0) {
      console.log('Nenhum provedor de IA configurado. Preencha GROQ_API_KEY no .dev.vars (ou use --fake).');
      await platform.dispose();
      process.exit(2);
    }
    llm = built.chain;
  }
  if (args.includes('--trace')) {
    const inner = llm;
    llm = {
      provider: inner.provider,
      model: inner.model,
      async chat(req) {
        const res = await inner.chat(req);
        for (const call of res.toolCalls) console.log(`  [ferramenta] ${call.name} ${call.arguments}`);
        if (!res.toolCalls.length) console.log(`  [texto] ${res.content.replace(/\n/g, ' ⏎ ')}`);
        return res;
      },
    };
  }

  // As duas empresas com "Telegram vinculado" (canal de mentira): os evals
  // conferem quando o bot chama a equipe, sem enviar nada de verdade.
  for (const t of [SEED.barber.tenantId, SEED.dental.tenantId]) {
    await platform.db
      .prepare(
        `INSERT INTO notification_channels (id, tenant_id, kind, target_enc, target_ref, active, created_at)
         VALUES (?1, ?2, 'telegram', 'eval', 'eval', 1, '2026-01-01T00:00:00.000Z')`,
      )
      .bind(`EVAL-${t}`, t)
      .run();
  }
  setTeam = async (tenantId, active) => {
    await platform.db
      .prepare('UPDATE notification_channels SET active = ?1 WHERE tenant_id = ?2')
      .bind(active ? 1 : 0, tenantId)
      .run();
  };
  runSql = async (sql) => {
    await platform.db.prepare(sql).run();
  };
  const notifier: HandoffNotifier = {
    notifyHandoff: async () => 1,
    relayCustomerMessages: async () => 1,
    notifyBooking: async () => 1,
  };

  const engine = new ConversationEngine({
    repo: new D1Repo(platform.db),
    llm,
    clock: evalClock,
    logger: new MemoryLogger(),
    notifier,
    scheduling: { publicBaseUrl: 'https://eval.test' },
    config: { pricing: DEFAULT_PRICING, quotaLimits: {}, logHashKey: 'evals' },
  });

  const only = option('only');
  const cases = CASES.filter((c) => !only || c.id === only);
  const results: CaseResult[] = [];
  for (const [i, c] of cases.entries()) {
    const r = await runCase(engine, c, i);
    results.push(r);
    const mark = r.passed ? '\x1b[32mAPROVADO\x1b[0m ' : '\x1b[31mREPROVADO\x1b[0m';
    console.log(`\n${mark} ${r.title} (${r.id})`);
    console.log(`  resposta: ${r.reply.replace(/\n/g, ' ⏎ ')}`);
    for (const f of r.failures) console.log(`  \x1b[31m✗ ${f}\x1b[0m`);
  }
  await platform.dispose();

  console.log('\n');
  console.table(
    results.map((r) => ({
      caso: r.id,
      resultado: r.passed ? 'aprovado' : 'REPROVADO',
      provedor: r.provider,
      'tokens entrada': r.tokensIn,
      'tokens saída': r.tokensOut,
      'req IA': r.llmRequests,
      ms: r.latencyMs,
    })),
  );
  const passed = results.filter((r) => r.passed).length;
  const avgIn = Math.round(results.reduce((s, r) => s + r.tokensIn, 0) / Math.max(1, results.length));
  const avgOut = Math.round(results.reduce((s, r) => s + r.tokensOut, 0) / Math.max(1, results.length));
  console.log(`\n${passed}/${results.length} aprovados · média por caso: ${avgIn} tokens de entrada, ${avgOut} de saída`);

  const dir = join(ROOT, 'evals', 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ chain: option('chain') ?? env.LLM_CHAIN, results }, null, 2));
  console.log(`Resultado salvo em ${file}`);

  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
