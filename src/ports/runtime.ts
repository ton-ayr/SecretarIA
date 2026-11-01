// Relógio e logger: injetados para que o motor seja testável.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/**
 * Campos de log. Nunca coloque telefone, nome ou texto de mensagem aqui:
 * use contact_ref para identificar o contato.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}
