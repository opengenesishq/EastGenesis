import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
let sql

/** Completed recovery snapshots are disposable; the canonical Run is durable. */
export async function readCanonicalFrozenRun(userData, sessionId, runId) {
  if (!runId) return undefined
  const SQL = await (sql ??= require('sql.js')({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') }))
  const db = new SQL.Database(readFileSync(path.join(userData, 'task-snapshots.db')))
  try {
    const statement = db.prepare('SELECT payload FROM workflow_runs WHERE id = ?')
    try {
      statement.bind([runId])
      if (!statement.step()) return undefined
      const row = JSON.parse(statement.getAsObject().payload)
      if (!row.taskRun) return undefined
      assert.equal(row.id, runId)
      assert.equal(row.sessionId, sessionId)
      assert.equal(row.taskRun.id, runId)
      assert.equal(row.taskRun.sessionId, sessionId)
      return row.taskRun
    } finally { statement.free() }
  } finally { db.close() }
}
