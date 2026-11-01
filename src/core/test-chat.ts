import { TEST_WA_ID, testPhoneMetaId } from '../ports/admin.ts';
import type { TestTurnInput, TestTurnResult } from '../ports/bot-admin.ts';
import type { ExternalCalendar } from '../ports/calendar.ts';
import type { HandoffNotifier } from '../ports/notifier.ts';
import type { Repo } from '../ports/repo.ts';
import type { Clock } from '../ports/runtime.ts';
import { ulid } from '../shared/ids.ts';
import type { TurnInput, TurnResult } from './engine.ts';
import type { PostJob } from './scheduling.ts';

/**
 * Chat de teste do painel: o mesmo motor, com o cadastro de verdade, pelo
 * número "simulador" da empresa. Diferenças de propósito:
 *  - nada sai pelo WhatsApp (o painel mostra a resposta);
 *  - a agenda Google é só lida (bloqueios valem; nenhum evento é criado);
 *  - a equipe não é avisada (o aviso "dá certo" de mentira, para o fluxo
 *    seguir igual ao real).
 * Horários marcados no teste ocupam a agenda até o "Limpar teste".
 */

export const TEST_PROFILE_NAME = 'Cliente Teste';

export function readOnlyCalendar(calendar: ExternalCalendar | undefined): ExternalCalendar | undefined {
  if (!calendar) return undefined;
  return {
    busy: (calendarId, timeMin, timeMax) => calendar.busy(calendarId, timeMin, timeMax),
    upsertEvent: async () => {},
    deleteEvent: async () => {},
  };
}

/** Finge que avisou a equipe, sem mandar nada. */
export const silentTeamNotifier: HandoffNotifier = {
  notifyHandoff: async () => 1,
  relayCustomerMessages: async () => 1,
  notifyBooking: async () => 1,
};

export interface TestChatDeps {
  repo: Repo;
  engine: {
    handleTurn(input: TurnInput): Promise<TurnResult>;
    runPostJobs(jobs: PostJob[]): Promise<void>;
  };
  clock: Clock;
}

export async function runTestTurn(tenantId: string, input: TestTurnInput, deps: TestChatDeps): Promise<TestTurnResult> {
  const now = deps.clock.now();
  const metaPhoneNumberId = testPhoneMetaId(tenantId);
  await deps.repo.forTenant(tenantId).ensureTestPhone(ulid(now.getTime()), metaPhoneNumberId, now.toISOString());

  const tapped = Boolean(input.replyId);
  const text = (tapped ? input.title : input.text)?.trim().slice(0, 1000) || (tapped ? 'opção' : '');
  if (!text) return { outcome: 'empty', reply: null, action: null, handoff: false, errorCode: null };

  const result = await deps.engine.handleTurn({
    metaPhoneNumberId,
    waId: TEST_WA_ID,
    // Como quase todo cliente do WhatsApp, o de teste tem nome de perfil.
    profileName: TEST_PROFILE_NAME,
    messages: [
      {
        text,
        kind: tapped ? 'interactive' : 'text',
        replyId: tapped ? (input.replyId ?? null) : null,
        waMessageId: `teste.${ulid(now.getTime())}`,
        at: now.toISOString(),
      },
    ],
  });
  if (result.postJobs.length) await deps.engine.runPostJobs(result.postJobs);

  return {
    outcome: result.outcome,
    reply: result.reply
      ? {
          text: result.reply.text,
          ...(result.reply.options ? { options: result.reply.options } : {}),
          ...(result.reply.listButton ? { listButton: result.reply.listButton } : {}),
          ...(result.reply.buttons ? { buttons: result.reply.buttons } : {}),
        }
      : null,
    action: result.action,
    handoff: result.outcome === 'handoff',
    errorCode: result.errorCode,
  };
}
