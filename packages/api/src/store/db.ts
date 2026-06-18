import Database from 'better-sqlite3';
import { SCHEMA } from './schema.js';

export function openDb(filePath: string): Database.Database {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
