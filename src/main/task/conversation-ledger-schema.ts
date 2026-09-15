import type { WorkflowLedgerDatabase } from './workflow-ledger-db'

export const CONVERSATION_LEDGER_STREAMS_TABLE = 'conversation_ledger_streams'
export const CONVERSATION_LEDGER_GENERATIONS_TABLE = 'conversation_ledger_generations'
export const CONVERSATION_LEDGER_EVENTS_TABLE = 'conversation_ledger_events'

export const CONVERSATION_LEDGER_TABLES = [
  CONVERSATION_LEDGER_STREAMS_TABLE,
  CONVERSATION_LEDGER_GENERATIONS_TABLE,
  CONVERSATION_LEDGER_EVENTS_TABLE
] as const

export function setupConversationLedgerSchema(db: WorkflowLedgerDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS conversation_ledger_streams (
      sdk_session_id TEXT PRIMARY KEY,
      origin_session_id TEXT NOT NULL,
      current_session_id TEXT NOT NULL,
      source_sdk_session_id TEXT,
      project_id TEXT,
      workspace_id TEXT,
      goal_id TEXT,
      work_item_id TEXT,
      source_cwd TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_binding TEXT NOT NULL DEFAULT 'provider',
      model TEXT NOT NULL,
      engine TEXT,
      current_generation INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  // Existing archives were all provider-bound. Preserve that stricter default
  // while giving newly created local plans an explicit, durable discriminator.
  const streamColumns = db.exec('PRAGMA table_info(conversation_ledger_streams)')[0]?.values ?? []
  if (!streamColumns.some((column) => column[1] === 'provider_binding')) {
    db.run("ALTER TABLE conversation_ledger_streams ADD COLUMN provider_binding TEXT NOT NULL DEFAULT 'provider'")
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_conversation_ledger_streams_session ON conversation_ledger_streams(current_session_id);')
  db.run('CREATE INDEX IF NOT EXISTS idx_conversation_ledger_streams_project ON conversation_ledger_streams(project_id);')
  db.run('CREATE INDEX IF NOT EXISTS idx_conversation_ledger_streams_work_item ON conversation_ledger_streams(work_item_id);')
  db.run(`
    CREATE TABLE IF NOT EXISTS conversation_ledger_generations (
      sdk_session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      entry_count INTEGER NOT NULL,
      ledger_mode TEXT NOT NULL,
      ledger_head_digest TEXT,
      archive_head_digest TEXT,
      supersedes_generation INTEGER,
      rewrite_reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (sdk_session_id, generation),
      FOREIGN KEY (sdk_session_id) REFERENCES conversation_ledger_streams(sdk_session_id) ON DELETE CASCADE
    );
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_conversation_ledger_generations_current ON conversation_ledger_generations(sdk_session_id, generation DESC);')
  db.run(`
    CREATE TABLE IF NOT EXISTS conversation_ledger_events (
      sdk_session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      ledger_digest TEXT,
      source_digest TEXT NOT NULL,
      previous_archive_digest TEXT NOT NULL,
      archive_digest TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (sdk_session_id, generation, seq),
      FOREIGN KEY (sdk_session_id, generation)
        REFERENCES conversation_ledger_generations(sdk_session_id, generation) ON DELETE CASCADE
    );
  `)
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_ledger_events_identity ON conversation_ledger_events(sdk_session_id, generation, event_id);')
  db.run('CREATE INDEX IF NOT EXISTS idx_conversation_ledger_events_stream ON conversation_ledger_events(stream_id, seq);')
}
