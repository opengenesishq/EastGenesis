import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { createPersonalTaskSmokeRuntime, waitForPersonalTask } from './personal-task-smoke-runtime.mjs'

const [tempRoot, phase, clientRequestId] = process.argv.slice(2)
if (!tempRoot || !['crash-created', 'crash-before-start', 'crash-claimed', 'resume', 'read-completed', 'read-blocked'].includes(phase) || !clientRequestId) throw new Error('restart fixture arguments are required')
const runtime = await createPersonalTaskSmokeRuntime({ tempRoot, keepData: true })
const input = { clientRequestId, text: 'SIGKILL_RESTART 保留个人任务原身份', businessLineId: 'assistant',
  providerId: 'personal-local', model: 'personal-local-model', routingScope: 'fixed', taskStrategy: 'view' }
try {
  if (phase === 'crash-before-start') {
    const original = runtime.manager.createManaged
    runtime.manager.createManaged = (...args) => original.call(runtime.manager, args[0], { ...args[1],
      beforeStart: async (session) => {
        const pending = runtime.load('main/session-creation-journal.ts').listPendingSessionCreations()
        assert(pending.some((draft) => draft.baseMeta.id === session.id), 'awaited initialization journal was acknowledged too early')
        writeFileSync(path.join(tempRoot, 'before-crash.json'), JSON.stringify({ session, requests: runtime.requests.length }))
        process.kill(process.pid, 'SIGKILL')
      }
    })
    await runtime.service.submit(input)
    throw new Error('pre-initialization crash fixture unexpectedly returned')
  }
  if (phase === 'crash-claimed') {
    runtime.manager.send = async (sessionId) => {
      writeFileSync(path.join(tempRoot, 'before-crash.json'), JSON.stringify({
        session: runtime.manager.get(sessionId).meta, requests: runtime.requests.length
      }))
      process.kill(process.pid, 'SIGKILL')
      throw new Error('SIGKILL claim fixture unexpectedly continued')
    }
    await runtime.service.submit(input)
    throw new Error('claim crash fixture unexpectedly returned')
  }
  if (phase === 'crash-created') {
    const original = runtime.manager.createManaged
    runtime.manager.createManaged = async (...args) => {
      const session = await original.apply(runtime.manager, args)
      writeFileSync(path.join(tempRoot, 'before-crash.json'), JSON.stringify({ session, requests: runtime.requests.length,
        snapshot: await runtime.load('main/task/task-snapshot.ts').getTaskSnapshot(session.id, runtime.userData),
        runs: await runtime.load('main/task/task-snapshot.ts').listTaskRuns(session.id, runtime.userData),
        transcript: runtime.manager.get(session.id)?.getTranscript() }))
      process.kill(process.pid, 'SIGKILL')
      throw new Error('SIGKILL fixture unexpectedly continued')
    }
    await runtime.service.submit(input)
    throw new Error('crash fixture unexpectedly returned')
  }
  assert.equal(runtime.requests.length, 0, 'startup sent a provider request')
  const before = await runtime.service.get(clientRequestId)
  assert.equal(runtime.requests.length, 0, 'receipt lookup sent a provider request')
  if (phase === 'read-blocked') {
    assert.equal(before.status, 'needs_reconciliation', JSON.stringify(before))
    const repeated = await runtime.service.submit(input)
    assert.equal(repeated.status, 'needs_reconciliation', JSON.stringify(repeated))
    assert.equal(runtime.requests.length, 0, 'unknown dispatch was automatically re-sent')
    const record = new (runtime.load('main/personal-task/personal-task-submission-store.ts').PersonalTaskSubmissionStore)(runtime.userData).read(clientRequestId)
    assert(Number.isFinite(record.dispatchClaimedAt))
    writeFileSync(path.join(tempRoot, 'read-blocked.json'), JSON.stringify({ before, repeated, requests: 0 }))
  } else if (phase === 'read-completed') {
    assert.equal(before.status, 'submitted', JSON.stringify(before))
    const repeated = await runtime.service.submit(input)
    assert.equal(repeated.status, 'submitted', JSON.stringify(repeated))
    assert.equal(runtime.requests.length, 0, 'completed task was sent again after process restart')
    writeFileSync(path.join(tempRoot, 'read-completed.json'), JSON.stringify({ before, repeated, requests: 0 }))
  } else {
    assert(['ready', 'not_sent'].includes(before.status), JSON.stringify(before))
    const receipt = await runtime.service.submit(input)
    assert.equal(receipt.status, 'submitted', JSON.stringify(receipt))
    assert.equal(receipt.session.projectId, undefined, 'personal task recovery registered a legacy code project')
    assert.equal((await waitForPersonalTask(runtime, receipt.binding.sessionId)).isError, false)
    assert.equal(runtime.requests.length, 1)
    writeFileSync(path.join(tempRoot, 'resumed.json'), JSON.stringify({ before, receipt, requests: 1 }))
  }
} finally { await runtime.close() }
