import Database from 'better-sqlite3';
import path from 'path';
import { SCHEMA } from './schema';

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'amtracked.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}
