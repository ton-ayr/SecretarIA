import type { LogFields, Logger } from '../ports/runtime.ts';

/** Logs em JSON de uma linha, lidos pelo Workers Logs. */
export class JsonLogger implements Logger {
  constructor(private readonly base: LogFields = {}) {}

  info(event: string, fields?: LogFields): void {
    this.write('info', event, fields);
  }
  warn(event: string, fields?: LogFields): void {
    this.write('warn', event, fields);
  }
  error(event: string, fields?: LogFields): void {
    this.write('error', event, fields);
  }

  private write(level: string, event: string, fields?: LogFields): void {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...this.base, ...fields }));
  }
}

/** Guarda os logs em memória. Usado em testes e no simulador. */
export class MemoryLogger implements Logger {
  readonly lines: Array<{ level: string; event: string } & LogFields> = [];
  info(event: string, fields?: LogFields): void {
    this.lines.push({ level: 'info', event, ...fields });
  }
  warn(event: string, fields?: LogFields): void {
    this.lines.push({ level: 'warn', event, ...fields });
  }
  error(event: string, fields?: LogFields): void {
    this.lines.push({ level: 'error', event, ...fields });
  }
}
