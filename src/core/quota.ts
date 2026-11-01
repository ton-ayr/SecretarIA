import type { LlmDailyTotals } from '../ports/repo.ts';

export type QuotaLimits = Record<string, { requests?: number; tokens?: number }>;

export const QUOTA_ALERT_THRESHOLD = 0.7;

export interface QuotaAlert {
  provider: string;
  model: string;
  /** Maior fração usada (0 a 1+) entre requisições e tokens. */
  usedRatio: number;
}

/** Modelos que passaram do limite de alerta e ainda não foram avisados hoje. */
export function quotaAlertsDue(
  totals: LlmDailyTotals[],
  limits: QuotaLimits,
  threshold = QUOTA_ALERT_THRESHOLD,
): QuotaAlert[] {
  const alerts: QuotaAlert[] = [];
  for (const t of totals) {
    if (t.alertSentAt) continue;
    const limit = limits[`${t.provider}:${t.model}`];
    if (!limit) continue;
    const usedRatio = Math.max(
      limit.requests ? t.requests / limit.requests : 0,
      limit.tokens ? t.tokens / limit.tokens : 0,
    );
    if (usedRatio >= threshold) alerts.push({ provider: t.provider, model: t.model, usedRatio });
  }
  return alerts;
}

export function parseQuotaLimits(json: string | undefined): QuotaLimits {
  if (!json) return {};
  try {
    return JSON.parse(json) as QuotaLimits;
  } catch {
    return {};
  }
}
