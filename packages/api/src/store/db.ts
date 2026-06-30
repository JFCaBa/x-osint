import Database from 'better-sqlite3';
import { SCHEMA } from './schema.js';

const POST_COLUMNS: Record<string, string> = {
  ai_status: 'TEXT',
  angle_match: 'INTEGER',
  angles: 'TEXT',
  text_pt: 'TEXT',
};

export function migrate(db: Database.Database): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(posts)`).all() as { name: string }[]).map(c => c.name),
  );
  for (const [name, type] of Object.entries(POST_COLUMNS)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE posts ADD COLUMN ${name} ${type}`);
  }
}

export function openDb(filePath: string): Database.Database {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
