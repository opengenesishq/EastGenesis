import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export async function verifyTaskDagFinalizerStore(input) {
  const {
    assertRejects,
    finalizerAtomicFailureRoot,
    finalizerCorruptionRoot,
    finalizerRoot,
    meta,
    snapshotStore,
    SQL
  } = input
  const finalizerParentId = 'finalizer-parent-a'
  const terminalExecution = terminalExecutionFixture(finalizerParentId)
  const finalizerSnapshot = snapshotStore.buildTaskSnapshot({
    meta: meta(finalizerParentId, 'idle'),
    transcript: [],
    lastSeq: 0,
    eventCount: 0,
    reason: 'important-event',
    dagExecutions: [terminalExecution],
    now: 3200
  })
  const preparedFinalizer = {
    schemaVersion: 1,
    executionId: terminalExecution.id,
    parentSessionId: finalizerParentId,
    revision: 1,
    phase: 'prepared',
    terminalExecution,
    autoMergeOptions: { enabled: true, verificationCommand: 'npm run typecheck' },
    mergeSessions: [],
    patchOperationIds: [],
    rollbackOperationIds: [],
    verification: { status: 'not_started', command: 'npm run typecheck' },
    createdAt: 3200,
    updatedAt: 3200
  }
  const preparedBarrier = await snapshotStore.saveTaskDagFinalizationBarrier(
    finalizerSnapshot,
    preparedFinalizer,
    { expectedRevision: 0, rootDir: finalizerRoot }
  )
  assert.equal(preparedBarrier.snapshot.sessionId, finalizerParentId)
  assert.equal(preparedBarrier.finalization.revision, 1)
  assert.equal((await snapshotStore.listTaskSnapshots(finalizerRoot)).length, 1)
  assert.equal((await snapshotStore.listTaskDagFinalizations(undefined, finalizerRoot)).length, 1)
  assert.equal((await snapshotStore.listTaskDagFinalizations(finalizerParentId, finalizerRoot)).length, 1)
  assert.equal(
    (await snapshotStore.getTaskDagFinalization(terminalExecution.id, finalizerRoot)).phase,
    'prepared'
  )

  await verifyAtomicFailure({
    assertRejects,
    finalizerAtomicFailureRoot,
    finalizerSnapshot,
    preparedFinalizer,
    snapshotStore
  })
  const mergingFinalizer = await verifyRevisionCas({
    assertRejects,
    finalizerRoot,
    finalizerSnapshot,
    preparedFinalizer,
    snapshotStore,
    terminalExecution
  })
  await verifyDeletionBarrier({
    assertRejects,
    finalizerParentId,
    finalizerRoot,
    finalizerSnapshot,
    mergingFinalizer,
    snapshotStore,
    terminalExecution
  })
  await verifyCorruptFinalizerRows({
    assertRejects,
    finalizerCorruptionRoot,
    meta,
    snapshotStore,
    SQL
  })
}

function terminalExecutionFixture(parentSessionId) {
  return {
    id: 'dag-finalizer-a',
    parentSessionId,
    dag: {
      id: 'dag-finalizer-a',
      title: 'DAG finalizer store contract',
      source: 'verify durable finalization storage',
      complexity: 'single',
      createdAt: 3000,
      tasks: []
    },
    status: 'success',
    maxRetries: 0,
    startedAt: 3000,
    completedAt: 3100,
    layers: [],
    tasks: [],
    summary: 'DAG 调度完成:0/0 成功'
  }
}

async function verifyAtomicFailure(input) {
  const { assertRejects, finalizerAtomicFailureRoot, finalizerSnapshot, preparedFinalizer, snapshotStore } = input
  const mismatchedFinalizer = {
    ...preparedFinalizer,
    executionId: 'dag-finalizer-atomic-failure',
    parentSessionId: 'different-parent'
  }
  await assertRejects(
    () => snapshotStore.saveTaskDagFinalizationBarrier(
      finalizerSnapshot,
      mismatchedFinalizer,
      { expectedRevision: 0, rootDir: finalizerAtomicFailureRoot }
    ),
    'DAG finalizer parentSessionId 与任务快照不一致'
  )
  assert.equal((await snapshotStore.listTaskSnapshots(finalizerAtomicFailureRoot)).length, 0)
  assert.equal((await snapshotStore.listTaskDagFinalizations(undefined, finalizerAtomicFailureRoot)).length, 0)
}

async function verifyRevisionCas(input) {
  const { assertRejects, finalizerRoot, finalizerSnapshot, preparedFinalizer, snapshotStore, terminalExecution } = input
  const mergingFinalizer = {
    ...preparedFinalizer,
    revision: 2,
    phase: 'merging',
    updatedAt: 3300
  }
  await snapshotStore.saveTaskDagFinalizationBarrier(
    { ...finalizerSnapshot, updatedAt: 3300 },
    mergingFinalizer,
    { expectedRevision: 1, rootDir: finalizerRoot }
  )
  assert.equal((await snapshotStore.getTaskDagFinalization(terminalExecution.id, finalizerRoot)).revision, 2)
  await assertRejects(
    () => snapshotStore.saveTaskDagFinalizationBarrier(
      { ...finalizerSnapshot, updatedAt: 3400 },
      { ...mergingFinalizer, revision: 4, phase: 'merge_settled', updatedAt: 3400 },
      { expectedRevision: 2, rootDir: finalizerRoot }
    ),
    'DAG finalizer revision 必须连续递增:4 != 3'
  )
  await assertRejects(
    () => snapshotStore.saveTaskDagFinalizationBarrier(
      { ...finalizerSnapshot, updatedAt: 3500 },
      { ...mergingFinalizer, revision: 3, phase: 'merge_settled', updatedAt: 3500 },
      { expectedRevision: 1, rootDir: finalizerRoot }
    ),
    'stale_revision: DAG finalizer dag-finalizer-a 已从 1 更新到 2'
  )
  assert.equal((await snapshotStore.getTaskDagFinalization(terminalExecution.id, finalizerRoot)).revision, 2)
  return mergingFinalizer
}

async function verifyDeletionBarrier(input) {
  const {
    assertRejects,
    finalizerParentId,
    finalizerRoot,
    finalizerSnapshot,
    mergingFinalizer,
    snapshotStore,
    terminalExecution
  } = input
  await assertRejects(
    () => snapshotStore.deleteTaskSnapshot(finalizerParentId, finalizerRoot),
    'DAG finalizer dag-finalizer-a 尚未完成，不能删除父任务恢复快照'
  )
  assert(await snapshotStore.getTaskSnapshot(finalizerParentId, finalizerRoot), 'blocked delete must retain parent snapshot')
  const completedFinalizer = {
    ...mergingFinalizer,
    revision: 3,
    phase: 'completed',
    updatedAt: 3600
  }
  await snapshotStore.saveTaskDagFinalizationBarrier(
    { ...finalizerSnapshot, updatedAt: 3600 },
    completedFinalizer,
    { expectedRevision: 2, rootDir: finalizerRoot }
  )
  assert.equal(await snapshotStore.deleteTaskSnapshot(finalizerParentId, finalizerRoot), true)
  assert.equal(await snapshotStore.getTaskSnapshot(finalizerParentId, finalizerRoot), null)
  assert.equal(
    (await snapshotStore.getTaskDagFinalization(terminalExecution.id, finalizerRoot)).phase,
    'completed'
  )
}

async function verifyCorruptFinalizerRows(input) {
  const { assertRejects, finalizerCorruptionRoot, meta, snapshotStore, SQL } = input
  const variants = [
    {
      name: 'invalid-json',
      mutate(db, executionId) {
        db.run('UPDATE dag_finalizers SET payload = ? WHERE execution_id = ?', ['{bad-json', executionId])
      }
    },
    {
      name: 'payload-revision-mismatch',
      mutate(db, executionId) {
        const row = db.exec(
          'SELECT payload FROM dag_finalizers WHERE execution_id = ?',
          [executionId]
        )[0]?.values[0]?.[0]
        const payload = JSON.parse(String(row))
        payload.revision += 1
        db.run('UPDATE dag_finalizers SET payload = ? WHERE execution_id = ?', [
          JSON.stringify(payload),
          executionId
        ])
      }
    },
    {
      name: 'sql-parent-mismatch',
      mutate(db, executionId) {
        db.run(
          'UPDATE dag_finalizers SET parent_session_id = ? WHERE execution_id = ?',
          ['corrupt-parent', executionId]
        )
      }
    }
  ]

  for (const [index, variant] of variants.entries()) {
    const root = `${finalizerCorruptionRoot}-${index}`
    const parentSessionId = `corrupt-finalizer-parent-${index}`
    const execution = terminalExecutionFixture(parentSessionId)
    execution.id = `dag-corrupt-finalizer-${index}`
    execution.dag.id = execution.id
    const snapshot = snapshotStore.buildTaskSnapshot({
      meta: meta(parentSessionId, 'idle'),
      transcript: [],
      lastSeq: 0,
      eventCount: 0,
      reason: 'important-event',
      dagExecutions: [execution],
      now: 3200
    })
    const finalization = {
      schemaVersion: 1,
      executionId: execution.id,
      parentSessionId,
      revision: 1,
      phase: 'prepared',
      terminalExecution: execution,
      autoMergeOptions: { enabled: true },
      mergeSessions: [],
      patchOperationIds: [],
      rollbackOperationIds: [],
      verification: { status: 'not_started' },
      createdAt: 3200,
      updatedAt: 3200
    }
    await snapshotStore.saveTaskDagFinalizationBarrier(snapshot, finalization, {
      expectedRevision: 0,
      rootDir: root
    })
    const dbPath = snapshotStore.taskSnapshotsDbFile(root)
    const beforeBytes = readFileSync(dbPath)
    const beforeSnapshot = await snapshotStore.getTaskSnapshot(parentSessionId, root)
    const db = new SQL.Database(beforeBytes)
    try {
      variant.mutate(db, execution.id)
      writeFileSync(dbPath, db.export())
    } finally {
      db.close()
    }
    const assertCorrupt = async (operation) => {
      await assert.rejects(operation, (error) => {
        assert.equal(error?.code, 'DAG_FINALIZATION_CORRUPTION', variant.name)
        return true
      })
      assert.deepEqual(readFileSync(dbPath), beforeBytes, `${variant.name} row bytes changed`)
      assert.deepEqual(
        await snapshotStore.getTaskSnapshot(parentSessionId, root),
        beforeSnapshot,
        `${variant.name} parent snapshot changed`
      )
    }
    await assertCorrupt(() => snapshotStore.getTaskDagFinalization(execution.id, root))
    await assertCorrupt(() => snapshotStore.listTaskDagFinalizations(undefined, root))
    await assertCorrupt(() => snapshotStore.saveTaskDagFinalizationBarrier(
      { ...snapshot, updatedAt: 3300 },
      { ...finalization, revision: 2, phase: 'merging', updatedAt: 3300 },
      { expectedRevision: 1, rootDir: root }
    ))
    await assertCorrupt(() => snapshotStore.deleteTaskSnapshot(parentSessionId, root))
  }
}

export function verifyRecoveryUiAndTray(repoRoot) {
  const appSource = read('src/renderer/src/App.tsx')
  assert(appSource.includes('TaskRecoveryModal'), 'App should mount TaskRecoveryModal')
  const recoverySource = [
    read('src/renderer/src/components/TaskRecoveryModal.tsx'),
    read('src/renderer/src/components/TaskRecoveryItem.tsx')
  ].join('\n')
  for (const marker of [
    'taskSnapshots',
    'recoverTaskSnapshot',
    'resolveTaskEffect',
    'resolveTaskDagFinalization',
    'deleteTaskSnapshot',
    'setShowTaskRecovery'
  ]) {
    assert(recoverySource.includes(marker), `TaskRecoveryModal missing ${marker}`)
  }
  assert(
    (recoverySource.match(/snapshot\.run\?\.operation !== undefined/g) ?? []).length >= 2 &&
      !recoverySource.includes("operation?.source === 'renderer'"),
    'TaskRecoveryModal must block Agent recovery for every durable operation source'
  )
  const storeSource = [
    read('src/renderer/src/store.ts'),
    read('src/renderer/src/store/task-recovery-actions.ts')
  ].join('\n')
  assert(storeSource.includes('async recoverTaskSnapshot'), 'store should register recovered sessions')
  assert(storeSource.includes('window.agentDesk.listTaskSnapshots()'), 'store should own task snapshot listing')
  assert(storeSource.includes('async resolveTaskEffect'), 'store should own effect resolution state')
  assert(storeSource.includes('effectStatus: ev.effectStatus'), 'store should preserve live effect status')
  const toolCardSource = read('src/renderer/src/components/ToolCallCard.tsx')
  assert(toolCardSource.includes("effectStatus === 'waiting_reconciliation'"), 'tool card should distinguish reconciliation')
  assert(toolCardSource.includes("t('toolWaitingReconciliation')"), 'tool card should label reconciliation')
  const mainSource = read('src/main/index.ts')
  for (const marker of ['Tray', 'hasRunningSessions', 'win.hide()', 'updateTray']) {
    assert(mainSource.includes(marker), `main process missing tray marker ${marker}`)
  }
  assert(mainSource.includes('await sessionManager.disposeAll()'), 'main process should await snapshot shutdown flush')
  const sessionManagerSource = read('src/main/sessionManager.ts')
  for (const marker of [
    'flushTaskSnapshotMutations',
    'taskSnapshotReason',
    'shouldCleanupTaskSnapshot',
    'restoreTranscriptIfMissing',
    'task-snapshot-replay',
    'buildTaskSnapshotReplayPrompts',
    'TaskSnapshotReplayCoordinator',
    'this.taskSnapshotReplay.start(snapshot.sessionId, replayPrompts',
    'this.taskSnapshotReplay.handleEvent(sessionId, event, this.modelAttemptRecoveryGate.refreshAfterEvent(sessionId, event))',
    'this.taskSnapshotReplay.blocksOrdinarySend(id, options)',
    'const imported = await listTaskSnapshots()',
    'const workflowRecoveryBlocks = await this.workflow.recover(imported)',
    'const recoverable = await this.reconcileTaskSnapshots(imported, workflowRecoveryBlocks)'
  ]) {
    assert(sessionManagerSource.includes(marker), `sessionManager missing snapshot marker ${marker}`)
  }
  assert(
    !sessionManagerSource.includes('for (const prompt of replayPrompts) this.send('),
    'snapshot recovery must not dispatch every recovered prompt into one running turn'
  )
  const supervisorSource = read('src/main/session-supervisor-runtime.ts')
  assert(
    supervisorSource.includes('this.replaySnapshot(taskRun.sessionId, prompts'),
    'Supervisor resume must use the same sequential snapshot replay coordinator'
  )
  const taskRunEventSource = read('src/main/session-task-run-events.ts')
  for (const marker of [
    "event.kind === 'turn-result' ||",
    "event.kind === 'turn-result' && !event.isError",
    'TASK_SNAPSHOT_EVENT_INTERVAL',
    'runHasUnresolvedEffects(run)'
  ]) {
    assert(taskRunEventSource.includes(marker), `task-run event runtime missing snapshot marker ${marker}`)
  }
  assertSourceOrder(sessionManagerSource, [
    'const imported = await listTaskSnapshots()',
    'const workflowRecoveryBlocks = await this.workflow.recover(imported)',
    'const recoverable = await this.reconcileTaskSnapshots(imported, workflowRecoveryBlocks)',
    'this.restoreActiveSessions('
  ],
    'task snapshots must take recovery precedence over the legacy active-session registry'
  )
  const writeSnapshotSource = sessionManagerSource.slice(
    sessionManagerSource.indexOf('private async writeTaskSnapshot('),
    sessionManagerSource.indexOf('private snapshotSubtasksFor(')
  )
  assertSourceOrder(writeSnapshotSource, [
    'const persist = this.workflow.captureSnapshot(',
    'await this.workflow.flush(sessionId)',
    'await persist()',
    'await this.writeTaskSnapshot(',
    'await deleteTaskSnapshot('
  ], 'snapshot cleanup must capture before flush, persist after flush, and delete last')
  for (const marker of [
    'this.workflow.recoveryBlocks()',
    'this.workflow.assertRecoveryResolved(id)',
    'this.workflow.assertRecoveryResolved(stored.sessionId)',
    "if (this.sessions.has(id)) throw new Error('活动会话的恢复快照不能手动删除；请先关闭会话。')"
  ]) assert(sessionManagerSource.includes(marker), `sessionManager missing workflow recovery guard ${marker}`)
  assert(
    !sessionManagerSource.includes('this.preservingSnapshotsOnDispose = false'),
    'shutdown snapshot protection must remain active for late provider events'
  )
  const sessionSupportSource = read('src/main/session-manager-support.ts')
  assert(sessionSupportSource.includes('run: this.dependencies.runs.get(sessionId)'), 'snapshot writes must include TaskRun state')
  const transcriptSource = read('src/main/transcript.ts')
  assert(transcriptSource.includes('restoreTranscriptIfMissing'), 'transcript should restore missing snapshot transcripts')

  function read(relativePath) {
    return readFileSync(path.join(repoRoot, relativePath), 'utf8')
  }
}

function assertSourceOrder(source, markers, message) {
  let cursor = -1
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1)
    assert(next > cursor, `${message}: ${marker}`)
    cursor = next
  }
}
