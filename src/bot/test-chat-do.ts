import { DurableObject } from 'cloudflare:workers';
import { runTestTurn } from '../core/test-chat.ts';
import type { TestTurnInput, TestTurnResult } from '../ports/bot-admin.ts';
import { systemClock } from '../ports/runtime.ts';
import type { Env } from './env.ts';
import { createEngine, createRepo } from './services.ts';

/**
 * Durable Object do chat de teste do painel (um por empresa). Não guarda
 * estado: existe para rodar o motor com os 30 s de CPU de um objeto (o
 * Worker comum tem 10 ms). O histórico fica no D1, no número simulador.
 */
export class TestChatDO extends DurableObject<Env> {
  async turn(tenantId: string, input: TestTurnInput): Promise<TestTurnResult> {
    const repo = createRepo(this.env);
    const engine = createEngine(this.env, repo, { test: true });
    return runTestTurn(tenantId, input, { repo, engine, clock: systemClock });
  }
}
