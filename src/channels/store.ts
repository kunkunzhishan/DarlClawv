import path from "node:path";
import Database from "better-sqlite3";
import { ensureDir } from "../utils/fs.js";

export type ChannelChatRecord = {
  id: number;
  channel_id: string;
  external_chat_id: string;
  agent_id: string;
  thread_id?: string | null;
  created_at: string;
  updated_at: string;
};

export type ScheduledTaskRecord = {
  id: number;
  chat_id: number;
  cron: string;
  task: string;
  next_run_at: string;
  enabled: boolean;
};

export type ChannelStore = {
  db: Database.Database;
  close: () => void;
  upsertChannel: (args: { id: string; kind: string; enabled: boolean }) => void;
  getOrCreateChat: (args: {
    channelId: string;
    externalChatId: string;
    agentId: string;
  }) => ChannelChatRecord;
  updateChatThread: (chatId: number, threadId: string) => void;
  getChatById: (chatId: number) => ChannelChatRecord | null;
  insertMessage: (args: {
    chatId: number;
    externalMessageId: string;
    role: "user" | "assistant";
    text: string;
    ts: string;
  }) => boolean;
  listDueScheduledTasks: (nowIso: string) => ScheduledTaskRecord[];
  updateScheduledTaskNextRun: (taskId: number, nextRunAt: string) => void;
};

function nowIso(): string {
  return new Date().toISOString();
}

function initSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(channel_id, external_chat_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      external_message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      ts TEXT NOT NULL,
      UNIQUE(chat_id, external_message_id, role)
    );
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      cron TEXT NOT NULL,
      task TEXT NOT NULL,
      next_run_at TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );
  `);
}

export async function openChannelStore(dbPath: string): Promise<ChannelStore> {
  const resolved = path.resolve(dbPath);
  await ensureDir(path.dirname(resolved));
  const db = new Database(resolved);
  initSchema(db);

  const upsertChannelStmt = db.prepare(`
    INSERT INTO channels (id, kind, enabled, updated_at)
    VALUES (@id, @kind, @enabled, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `);

  const selectChatStmt = db.prepare(`
    SELECT * FROM chats WHERE channel_id = ? AND external_chat_id = ?
  `);
  const insertChatStmt = db.prepare(`
    INSERT INTO chats (channel_id, external_chat_id, agent_id, thread_id, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, ?)
  `);
  const updateChatThreadStmt = db.prepare(`
    UPDATE chats SET thread_id = ?, updated_at = ? WHERE id = ?
  `);
  const selectChatByIdStmt = db.prepare(`SELECT * FROM chats WHERE id = ?`);
  const insertMessageStmt = db.prepare(`
    INSERT OR IGNORE INTO messages (chat_id, external_message_id, role, text, ts)
    VALUES (?, ?, ?, ?, ?)
  `);
  const listDueTasksStmt = db.prepare(`
    SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC
  `);
  const updateTaskNextRunStmt = db.prepare(`
    UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?
  `);

  return {
    db,
    close: () => db.close(),
    upsertChannel: ({ id, kind, enabled }) => {
      upsertChannelStmt.run({ id, kind, enabled: enabled ? 1 : 0, updated_at: nowIso() });
    },
    getOrCreateChat: ({ channelId, externalChatId, agentId }) => {
      const existing = selectChatStmt.get(channelId, externalChatId) as ChannelChatRecord | undefined;
      if (existing) {
        return existing;
      }
      const ts = nowIso();
      const result = insertChatStmt.run(channelId, externalChatId, agentId, ts, ts);
      const id = Number(result.lastInsertRowid);
      return selectChatByIdStmt.get(id) as ChannelChatRecord;
    },
    updateChatThread: (chatId, threadId) => {
      updateChatThreadStmt.run(threadId, nowIso(), chatId);
    },
    getChatById: (chatId) => {
      const row = selectChatByIdStmt.get(chatId) as ChannelChatRecord | undefined;
      return row ?? null;
    },
    insertMessage: ({ chatId, externalMessageId, role, text, ts }) => {
      const result = insertMessageStmt.run(chatId, externalMessageId, role, text, ts);
      return result.changes > 0;
    },
    listDueScheduledTasks: (nowIsoValue) => listDueTasksStmt.all(nowIsoValue) as ScheduledTaskRecord[],
    updateScheduledTaskNextRun: (taskId, nextRunAt) => {
      updateTaskNextRunStmt.run(nextRunAt, taskId);
    }
  };
}
