import type { InboxItem, InboxStore } from '../../src/core/conversation-flow.ts';

/** Corpo de webhook da Meta no formato oficial, para testes. */
export function sampleWebhook(overrides: { messages?: unknown[]; statuses?: unknown[]; phoneId?: string } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15556361310', phone_number_id: overrides.phoneId ?? '100000000000001' },
              contacts: [{ profile: { name: 'Maria' }, wa_id: '5511999990001' }],
              ...(overrides.messages ? { messages: overrides.messages } : {}),
              ...(overrides.statuses ? { statuses: overrides.statuses } : {}),
            },
          },
        ],
      },
    ],
  };
}

/** InboxStore em memória com a mesma semântica do SQLite do Durable Object. */
export class MemoryInboxStore implements InboxStore {
  seen = new Map<string, number>();
  rate = new Map<number, number>();
  inbox: Array<InboxItem & { receivedAtMs: number; turnTag: string | null }> = [];
  state = new Map<string, string>();

  markSeen(id: string, nowMs: number): boolean {
    if (this.seen.has(id)) return false;
    this.seen.set(id, nowMs);
    return true;
  }
  pruneSeen(beforeMs: number): void {
    for (const [id, at] of this.seen) if (at < beforeMs) this.seen.delete(id);
  }
  incrementRate(hour: number): number {
    for (const h of this.rate.keys()) if (h < hour) this.rate.delete(h);
    const n = (this.rate.get(hour) ?? 0) + 1;
    this.rate.set(hour, n);
    return n;
  }
  push(item: InboxItem, receivedAtMs: number): void {
    if (this.inbox.some((i) => i.waMessageId === item.waMessageId)) return;
    this.inbox.push({ ...item, receivedAtMs, turnTag: null });
  }
  pending() {
    return this.inbox
      .filter((i) => i.turnTag === null)
      .map(({ turnTag: _t, ...rest }) => ({
        ...rest,
        mediaId: rest.mediaId ?? null,
        mime: rest.mime ?? null,
        replyId: rest.replyId ?? null,
      }));
  }
  take(ids: string[], tag: string): void {
    for (const i of this.inbox) if (ids.includes(i.waMessageId)) i.turnTag = tag;
  }
  releaseTaken(): void {
    for (const i of this.inbox) i.turnTag = null;
  }
  remove(ids: string[]): void {
    this.inbox = this.inbox.filter((i) => !ids.includes(i.waMessageId));
  }
  getState(key: string): string | null {
    return this.state.get(key) ?? null;
  }
  setState(key: string, value: string | null): void {
    if (value === null) this.state.delete(key);
    else this.state.set(key, value);
  }
}
