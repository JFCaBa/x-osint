import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, migrate } from '../src/store/db.js';

function cols(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
}

describe('migrate', () => {
  it('adds AI columns to a fresh db', () => {
    const db = openDb(':memory:');
    const c = cols(db, 'posts');
    expect(c).toEqual(expect.arrayContaining(['ai_status', 'angle_match', 'angles', 'text_pt']));
  });

  it('adds AI columns to a legacy posts table missing them', () => {
    const legacy = new Database(':memory:');
    legacy.exec(`CREATE TABLE posts (id TEXT PRIMARY KEY, handle TEXT, text TEXT, url TEXT, media_url TEXT, posted_at TEXT, fetched_at TEXT)`);
    migrate(legacy);
    expect(cols(legacy, 'posts')).toEqual(expect.arrayContaining(['ai_status', 'angle_match', 'angles', 'text_pt']));
    // idempotent second run does not throw
    expect(() => migrate(legacy)).not.toThrow();
  });

  it('creates the exports table', () => {
    const db = openDb(':memory:');
    expect(cols(db, 'exports')).toEqual(expect.arrayContaining(['id', 'exported_at', 'covered_upto', 'row_count']));
  });
});
