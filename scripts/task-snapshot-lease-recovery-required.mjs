#!/usr/bin/env node
/**
 * Regression gate for legacy task snapshots whose canonical WorkItem lease
 * is gone.  The fixture is in-memory and never reads userData or Providers.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const ts = require('typescript')

function extractMethod(file, className, methodName, globals) {
  const sourceText = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.ES2022, true)
  const owner = source.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === className)
  assert(owner, `${className} is missing`)
  const member = owner.members.find((node) => node.name?.getText(source) === methodName)
  assert(member, `${className}.${methodName} is missing`)
  const output = ts.transpileModule(`class Subject { ${member.getText(source)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return new Function(...Object.keys(globals), `${output}; return Subject.prototype.${methodName}`)(...Object.values(globals))
}

const supportSource = readFileSync(resolve(repoRoot, 'src/main/session-manager-support.ts'), 'utf8')
const bridgeSource = readFileSync(resolve(repoRoot, 'src/main/task/supervisor-taskrun-bridge.ts'), 'utf8')
const managerSource = readFileSync(resolve(repoRoot, 'src/main/sessionManager.ts'), 'utf8')
assert(supportSource.includes('snapshotNeedsReadOnlyRecovery'), 'recovery read-only lease probe is missing')
assert(supportSource.includes('bindSnapshotForRecovery'), 'stale lease binding guard is missing')
assert(bridgeSource.includes('assertSupervisorRunBindingRecoveryReady'), 'read-only Supervisor lease probe is missing')
assert(managerSource.includes('snapshotNeedsReadOnlyRecovery(reconciled.snapshot)'), 'snapshot reconciliation does not preserve stale lease history')
assert(managerSource.includes('bindSnapshotForRecovery(persisted)'), 'snapshot reconciliation does not use the stale lease guard')

let bindProbes = 0
let reconciledWrites = 0
let deletedSnapshots = 0
const reconcileTaskSnapshots = extractMethod(
  resolve(repoRoot, 'src/main/sessionManager.ts'),
  'SessionManager',
  'reconcileTaskSnapshots',
  {
    mapWithConcurrencyInOrder: async (items, _concurrency, action) => Promise.all(items.map(action)),
    TASK_SNAPSHOT_RECONCILIATION_CONCURRENCY: 1,
    isInteractiveOperationSnapshot: () => false,
    reconcileSnapshotWithReceipts: (snapshot) => ({ snapshot, terminalRun: snapshot.run }),
    reconcileExistingPersistedTaskSnapshot: async (snapshot) => { reconciledWrites += 1; return snapshot },
    deleteTaskSnapshot: async () => { deletedSnapshots += 1 }
  }
)

const legacySnapshot = {
  id: 'legacy-snapshot',
  sessionId: 'legacy-session',
  meta: { id: 'legacy-session', workspaceId: 'workspace', goalId: 'goal', workItemId: 'work-item' },
  run: { id: 'legacy-run', sessionId: 'legacy-session', status: 'completed' },
  transcript: [],
  dagRuntimes: []
}
const workflow = {
  snapshotNeedsReadOnlyRecovery: async (snapshot) => {
    bindProbes += 1
    assert.equal(snapshot.run.id, 'legacy-run')
    return true
  },
  bindSnapshotForRecovery: async () => { throw new Error('must not reserve or bind stale historical snapshot') }
}
const result = await reconcileTaskSnapshots.call({
  sessions: new Map(),
  dagFinalizationCoordinator: { hasIncomplete: () => false },
  workflow
}, [legacySnapshot])

assert.equal(bindProbes, 1)
assert.deepEqual(result, [legacySnapshot], 'legacy snapshot must remain visible for manual recovery')
assert.equal(reconciledWrites, 0, 'stale lease recovery must not rewrite historical snapshot data')
assert.equal(deletedSnapshots, 0, 'stale lease recovery must not delete the recovery entry')
console.log('PASS stale canonical lease keeps the full task snapshot list readable')
console.log('PASS stale canonical lease performs no Run reservation, lease creation, replay, write, or delete')
console.log('task snapshot lease recovery: 2/2 passed; synthetic fixture only')
