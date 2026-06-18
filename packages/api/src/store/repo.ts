import type Database from 'better-sqlite3';
import type { Account, Post } from '../types.js';

interface AccountRow {
  handle: string;
  display_name: string | null;
  enabled: number;
  added_at: string;
  last_fetched_at: string | null;
  last_status: string | null;
}

function rowToAccount(r: AccountRow): Account {
  return {
    handle: r.handle,
    display_name: r.display_name,
    enabled: r.enabled === 1,
    added_at: r.added_at,
    last_fetched_at: r.last_fetched_at,
    last_status: r.last_status === 'ok' || r.last_status === 'error' ? r.last_status : null,
  };
}

export function createRepo(db: Database.Database) {
  const getAccountStmt = db.prepare('SELECT * FROM accounts WHERE handle = ?');

  function getAccount(handle: string): Account | null {
    const row = getAccountStmt.get(handle) as AccountRow | undefined;
    return row ? rowToAccount(row) : null;
  }

  return {
    addAccount(handle: string, displayName: string | null = null): Account {
      const addedAt = new Date().toISOString();
      db.prepare(
        'INSERT INTO accounts (handle, display_name, enabled, added_at) VALUES (?, ?, 1, ?)',
      ).run(handle, displayName, addedAt);
      return getAccount(handle)!;
    },

    removeAccount(handle: string): boolean {
      return db.prepare('DELETE FROM accounts WHERE handle = ?').run(handle).changes > 0;
    },

    setAccountEnabled(handle: string, enabled: boolean): Account | null {
      const changed = db.prepare('UPDATE accounts SET enabled = ? WHERE handle = ?')
        .run(enabled ? 1 : 0, handle).changes;
      return changed > 0 ? getAccount(handle) : null;
    },

    setAccountStatus(handle: string, status: 'ok' | 'error', fetchedAt: string): void {
      db.prepare('UPDATE accounts SET last_status = ?, last_fetched_at = ? WHERE handle = ?')
        .run(status, fetchedAt, handle);
    },

    listAccounts(): Account[] {
      const rows = db.prepare('SELECT * FROM accounts ORDER BY handle').all() as AccountRow[];
      return rows.map(rowToAccount);
    },

    getEnabledHandles(): string[] {
      const rows = db.prepare('SELECT handle FROM accounts WHERE enabled = 1').all() as { handle: string }[];
      return rows.map(r => r.handle);
    },

    upsertPosts(posts: Post[]): number {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO posts (id, handle, text, url, media_url, posted_at, fetched_at)
         VALUES (@id, @handle, @text, @url, @media_url, @posted_at, @fetched_at)`,
      );
      const tx = db.transaction((items: Post[]) => {
        let inserted = 0;
        for (const p of items) inserted += stmt.run(p).changes;
        return inserted;
      });
      return tx(posts);
    },

    listPosts(opts: { handle?: string; q?: string; since?: string; limit?: number }): Post[] {
      const where: string[] = [];
      const params: Record<string, string> = {};
      if (opts.handle) { where.push('handle = @handle'); params.handle = opts.handle; }
      if (opts.q) { where.push('text LIKE @q'); params.q = `%${opts.q}%`; }
      if (opts.since) { where.push('posted_at > @since'); params.since = opts.since; }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const limit = opts.limit && opts.limit > 0 ? `LIMIT ${Math.floor(opts.limit)}` : '';
      return db.prepare(`SELECT * FROM posts ${clause} ORDER BY posted_at DESC ${limit}`).all(params) as Post[];
    },

    pruneOldPosts(retentionDays: number): number {
      const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
      return db.prepare('DELETE FROM posts WHERE posted_at < ?').run(cutoff).changes;
    },
  };
}
