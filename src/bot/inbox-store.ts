import type { InboxItem, InboxStore } from '../core/conversation-flow.ts';

/**
 * InboxStore sobre o SQLite do Durable Object (ctx.storage.sql, síncrono).
 * Guarda só o necessário para um turno: IDs vistos (7 dias), caixa de
 * entrada, contador por hora e estado.
 */
export class SqlInboxStore implements InboxStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_seen_at ON seen(at);
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL,
        profile_name TEXT, received_at INTEGER NOT NULL, turn_tag TEXT
      );
      CREATE TABLE IF NOT EXISTS rate (hour INTEGER PRIMARY KEY, n INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // Objetos antigos não têm as colunas de mídia.
    const columns = new Set(
      sql
        .exec<{ name: string }>('PRAGMA table_info(inbox)')
        .toArray()
        .map((c) => c.name),
    );
    if (!columns.has('media_id')) sql.exec('ALTER TABLE inbox ADD COLUMN media_id TEXT');
    if (!columns.has('mime')) sql.exec('ALTER TABLE inbox ADD COLUMN mime TEXT');
    if (!columns.has('reply_id')) sql.exec('ALTER TABLE inbox ADD COLUMN reply_id TEXT');
  }

  markSeen(waMessageId: string, nowMs: number): boolean {
    return this.sql.exec('INSERT OR IGNORE INTO seen (id, at) VALUES (?, ?)', waMessageId, nowMs).rowsWritten > 0;
  }

  pruneSeen(beforeMs: number): void {
    this.sql.exec('DELETE FROM seen WHERE at < ?', beforeMs);
  }

  incrementRate(hourKey: number): number {
    this.sql.exec('DELETE FROM rate WHERE hour < ?', hourKey);
    const row = this.sql
      .exec<{ n: number }>(
        'INSERT INTO rate (hour, n) VALUES (?, 1) ON CONFLICT (hour) DO UPDATE SET n = n + 1 RETURNING n',
        hourKey,
      )
      .one();
    return row.n;
  }

  push(item: InboxItem, receivedAtMs: number): void {
    this.sql.exec(
      'INSERT OR IGNORE INTO inbox (id, kind, text, at, profile_name, received_at, media_id, mime, reply_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      item.waMessageId,
      item.kind,
      item.text,
      item.at,
      item.profileName,
      receivedAtMs,
      item.mediaId ?? null,
      item.mime ?? null,
      item.replyId ?? null,
    );
  }

  pending(): Array<InboxItem & { receivedAtMs: number }> {
    return this.sql
      .exec<{
        id: string;
        kind: string;
        text: string;
        at: string;
        profile_name: string | null;
        received_at: number;
        media_id: string | null;
        mime: string | null;
        reply_id: string | null;
      }>(
        'SELECT id, kind, text, at, profile_name, received_at, media_id, mime, reply_id FROM inbox WHERE turn_tag IS NULL ORDER BY received_at, rowid',
      )
      .toArray()
      .map((r) => ({
        waMessageId: r.id,
        kind: r.kind,
        text: r.text,
        at: r.at,
        profileName: r.profile_name,
        receivedAtMs: r.received_at,
        mediaId: r.media_id,
        mime: r.mime,
        replyId: r.reply_id,
      }));
  }

  take(waMessageIds: string[], turnTag: string): void {
    for (const id of waMessageIds) this.sql.exec('UPDATE inbox SET turn_tag = ? WHERE id = ?', turnTag, id);
  }

  releaseTaken(): void {
    this.sql.exec('UPDATE inbox SET turn_tag = NULL WHERE turn_tag IS NOT NULL');
  }

  remove(waMessageIds: string[]): void {
    for (const id of waMessageIds) this.sql.exec('DELETE FROM inbox WHERE id = ?', id);
  }

  getState(key: string): string | null {
    const rows = this.sql.exec<{ value: string }>('SELECT value FROM state WHERE key = ?', key).toArray();
    return rows[0]?.value ?? null;
  }

  setState(key: string, value: string | null): void {
    if (value === null) this.sql.exec('DELETE FROM state WHERE key = ?', key);
    else this.sql.exec('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }
}
