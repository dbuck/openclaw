import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import type { ConversationReference } from "./teams/types.js";

export type ThreadRow = {
  conversation_id: string;
  reference_json: string;
  claude_session_id: string | null;
  working_dir: string | null;
  created_at: number;
  updated_at: number;
};

export class ThreadStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        conversation_id TEXT PRIMARY KEY,
        reference_json TEXT NOT NULL,
        claude_session_id TEXT,
        working_dir TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  upsertReference(reference: ConversationReference): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO threads (conversation_id, reference_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           reference_json = excluded.reference_json,
           updated_at = excluded.updated_at`,
      )
      .run(reference.conversation.id, JSON.stringify(reference), now, now);
  }

  getReference(conversationId: string): ConversationReference | null {
    const row = this.db
      .prepare<[string], ThreadRow>("SELECT * FROM threads WHERE conversation_id = ?")
      .get(conversationId);
    if (!row) return null;
    try {
      return JSON.parse(row.reference_json) as ConversationReference;
    } catch {
      return null;
    }
  }

  setSession(conversationId: string, claudeSessionId: string): void {
    this.db
      .prepare(
        "UPDATE threads SET claude_session_id = ?, updated_at = ? WHERE conversation_id = ?",
      )
      .run(claudeSessionId, Date.now(), conversationId);
  }

  getSession(conversationId: string): string | null {
    const row = this.db
      .prepare<[string], { claude_session_id: string | null }>(
        "SELECT claude_session_id FROM threads WHERE conversation_id = ?",
      )
      .get(conversationId);
    return row?.claude_session_id ?? null;
  }

  setWorkingDir(conversationId: string, workingDir: string | null): void {
    this.db
      .prepare("UPDATE threads SET working_dir = ?, updated_at = ? WHERE conversation_id = ?")
      .run(workingDir, Date.now(), conversationId);
  }

  getWorkingDir(conversationId: string): string | null {
    const row = this.db
      .prepare<[string], { working_dir: string | null }>(
        "SELECT working_dir FROM threads WHERE conversation_id = ?",
      )
      .get(conversationId);
    return row?.working_dir ?? null;
  }

  close(): void {
    this.db.close();
  }
}
