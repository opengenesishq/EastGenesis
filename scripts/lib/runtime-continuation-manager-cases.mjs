import assert from 'node:assert/strict'
import { fixture, continuationProvider } from './runtime-continuation-smoke-runtime.mjs'
import { eventually } from './anthropic-messages-smoke-support.mjs'

/** Exercise the production send facade while replacing unrelated UI/supervisor infrastructure. */
export async function verifyContinuationSendFacade(runtime, checks) {
  const source = await fixture(runtime, 'manager-continuation')
  const manager = managerHarness(runtime, source)
  const originalPrepare = runtime.continuation.prepareRuntimeContinuation
  runtime.continuation.prepareRuntimeContinuation = (input) => originalPrepare({ ...input, create: runtime.create })
  try {
    runtime.providers.commitProviderProfileStore([
      continuationProvider('openai', runtime.port, 100), continuationProvider('anthropic', runtime.port, 0.001)
    ])
    const before = runtime.requests.length
    manager.modelAttemptRecoveryGate.decideSend = () => ({ allowed: false, consumeReplay: false, error: 'unknown ModelAttempt result' })
    assert.equal(await manager.send(source.engine.meta.id, { text: '继续', messageId: 'blocked-attempt' }), false)
    assert.equal(runtime.requests.length, before)
    assert.equal(manager.sessions.get(source.engine.meta.id), source.engine)
    assert(source.engine.meta.lastError.includes('unknown ModelAttempt'), source.engine.meta.lastError)
    await source.engine.start()
    manager.modelAttemptRecoveryGate.decideSend = () => ({ allowed: true, consumeReplay: false })
    assert.equal(await manager.send(source.engine.meta.id, { text: '继续第二步', messageId: 'facade-next' }), true)
    const successor = manager.sessions.get(source.engine.meta.id)
    await eventually(() => runtime.requests.length === before + 1, 'facade did not send exactly one successor request')
    await eventually(() => successor.meta.status === 'idle', 'successor did not settle')
    assert.equal(runtime.requests.at(-1).providerId, 'anthropic')
    assert.equal(successor.meta.engine, 'anthropic')
    const actual = runtime.load('main/model/native-request-budget.js').nativeBudgetSnapshot(successor.meta).actualTextCostUsd
    assert.equal(successor.meta.costUsd, actual, 'Session cost must use settled text charges across protocols')
    assert(successor.meta.costUsd > source.engine.meta.costUsd, 'continuation lost accumulated text cost')
    assert(manager.snapshots.some((meta) => meta.runtimeContinuation?.state === 'committed'))
    assert.equal(source.events.filter(({ event }) => event.kind === 'user-message' && event.messageId === 'facade-next').length, 1)
    await successor.retireForContinuation()
    checks.push('production SessionManager.send blocks unknown Attempt before handoff, persists successor before exactly one next-turn HTTP request')
  } finally { runtime.continuation.prepareRuntimeContinuation = originalPrepare }
}

function managerHarness(runtime, source) {
  const { sessionManager } = runtime.load('main/sessionManager.js')
  const manager = Object.create(Object.getPrototypeOf(sessionManager))
  const id = source.engine.meta.id
  manager.sessions = new Map([[id, source.engine]])
  manager.taskRuns = { get: (key) => runtime.registry.get(key), set: (key, run) => runtime.registry.set(key, run) }
  manager.taskPlans = { authorizeSend: () => true }
  manager.taskSnapshotReplay = { blocksOrdinarySend: () => false }
  manager.supervisor = { blocksSend: () => false, authorizeSend: async () => undefined, settleAcceptedSend: async () => undefined }
  manager.modelAttemptRecoveryGate = { refreshBeforeSend: async () => undefined, acceptedSend: () => undefined }
  manager.sessionStarts = { ensure: async () => undefined, forget: () => undefined }
  manager.snapshots = []
  manager.writeTaskSnapshot = async () => { manager.snapshots.push(structuredClone(manager.sessions.get(id).meta)) }
  manager.persistActiveSessions = () => undefined
  const events = runtime.load('main/session-task-run-events.js')
  manager.taskRuns.supersedeArchivedExecution = () => false
  manager.dispatch = (sessionId, event, seq, identity) => {
    event = manager.normalizeTurnResultCost(manager.sessions.get(sessionId), event)
    events.handleSessionTaskRunEvent(manager.taskRuns, sessionId, event, identity,
      { cwd: source.engine.meta.cwd, supervisorPauseIntent: false, preserveClosedRun: false })
    source.emit(event, seq, identity)
  }
  return manager
}
