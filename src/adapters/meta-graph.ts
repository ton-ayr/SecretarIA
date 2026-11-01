import type { MetaNumber } from '../ports/bot-admin.ts';

/**
 * Consultas de cadastro na Graph API da Meta (painel). O envio de mensagens
 * fica em whatsapp-cloud.ts.
 * GET /<WABA_ID>/phone_numbers (verificado em 2026-10-04, ARQUITETURA §16).
 */

export class MetaGraphError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MetaGraphError';
  }
}

const FIELDS = 'id,display_phone_number,verified_name,quality_rating,code_verification_status';

export async function listWabaPhoneNumbers(opts: {
  graphVersion: string;
  token: string;
  wabaId: string;
  fetchFn?: typeof fetch;
}): Promise<MetaNumber[]> {
  const fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  if (!/^\d{5,30}$/.test(opts.wabaId)) throw new MetaGraphError(400, 'WABA inválida');
  const url = `https://graph.facebook.com/${opts.graphVersion}/${opts.wabaId}/phone_numbers?fields=${FIELDS}&limit=50`;
  const res = await fetchFn(url, {
    headers: { authorization: `Bearer ${opts.token}`, 'user-agent': 'SecretarIA/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new MetaGraphError(res.status, `phone_numbers HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return (body.data ?? [])
    .filter((n) => typeof n.id === 'string' && /^\d{5,30}$/.test(n.id))
    .map((n) => ({
      id: str(n.id),
      displayPhoneNumber: str(n.display_phone_number),
      verifiedName: str(n.verified_name),
      qualityRating: str(n.quality_rating),
      codeVerificationStatus: str(n.code_verification_status),
    }));
}
