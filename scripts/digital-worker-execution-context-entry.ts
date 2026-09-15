import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { SessionMeta } from '../src/shared/types'
import type { StableMessagePayload } from '../src/main/stable-message-payload'
import { DigitalWorkerStore } from '../src/main/digital-worker/domain-store'
import { createDigitalWorkerSessionBinding } from '../src/main/digital-worker/session-binding'
import { buildDigitalWorkerExecutionPrompt } from '../src/main/digital-worker/worker-execution-prompt'
import { augmentNativePayloadWithLayeredMemory } from '../src/main/native-layered-prompt'
import { buildDigitalWorkerMemoryPrompt, proposeDigitalWorkerMemory, decideDigitalWorkerMemory } from '../src/main/digital-worker/worker-memory'
import { assertDigitalWorkerProviderDispatchAllowed, DigitalWorkerProviderDispatchDeniedError } from '../src/main/digital-worker/session-action-policy'
import { createSessionTaskRun } from '../src/main/task/task-run'
import { taskRuntimeRegistry } from '../src/main/task/task-runtime-registry'

const root = process.argv[2]
const checks: string[] = []
let providerCalls = 0
globalThis.fetch = async () => { providerCalls++; throw new Error('Network forbidden in Worker context fixture') }
const hooks = globalThis as typeof globalThis & { __workerContextRetrieval?: () => Promise<string> }
const request: StableMessagePayload = { text: '生成报告并提供验证证据', images: [], documents: [], messageId: 'fixture-message' }

async function fixture(id: string) {
  const stateRoot = join(root, id)
  const store = new DigitalWorkerStore(stateRoot)
  const role = await store.createRoleTemplate({ id: `role-${id}`, name: 'Document specialist', purpose: 'Produce verifiable documents',
    instructions: 'Read the supplied source, generate the requested document, inspect its contents, and report the artifact path.',
    verificationPolicy: { requireArtifactInspection: true }, createdAt: 100, updatedAt: 100 })
  const proposed = await store.createDigitalWorker({ id: `worker-${id}`, projectId: 'project-context', roleTemplateId: role.id,
    displayName: `Document Worker ${id}`, responsibilityScope: ['Prepare reports from the assigned source'],
    toolPolicy: { read: true, write: true }, dataScope: { requireExplicitScope: true, allowedDataClasses: ['S2'], allowedResourceIds: ['brief'] },
    acceptancePolicy: { minimumEvidenceCount: 1, requireUserApproval: true }, concurrencyLimit: 2,
    escalationPolicy: { target: 'user', afterFailures: 2 }, createdAt: 110, updatedAt: 110 })
  const worker = await store.activateDigitalWorker(proposed.id, { expectedRevision: proposed.revision, now: 120 })
  const assignment = await store.createAssignment({ id: `assignment-${id}`, projectId: worker.projectId, workItemId: `work-${id}`,
    assigneeKind: 'digital_worker', assigneeId: worker.id, scope: { dataClass: 'S2', resourceIds: ['brief'] }, assignedAt: 130, assignedBy: 'local-test-user' })
  const meta: SessionMeta = { id: `session-${id}`, projectId: worker.projectId, workspaceId: worker.projectId, workItemId: assignment.workItemId,
    engine: 'openai', model: 'fixture-openai-model', providerId: 'fixture-openai-provider', title: id, cwd: stateRoot, createdAt: 140,
    status: 'idle', taskStrategy: 'execute', permissionMode: 'default', costUsd: 0, contextTokens: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } }
  meta.digitalWorkerBinding = createDigitalWorkerSessionBinding(meta, stateRoot)
  taskRuntimeRegistry.set(meta.id, createSessionTaskRun(meta))
  return { stateRoot, store, role, worker, assignment, meta }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

async function assertDeniedAfterPreparation(id: string, mutate: (value: Fixture) => Promise<unknown>, pattern: RegExp) {
  const value = await fixture(id)
  assert.match((await augmentNativePayloadWithLayeredMemory(request, value.meta, value.stateRoot)).payload.text, /DigitalWorker Execution Context/)
  await assertDigitalWorkerProviderDispatchAllowed(value.meta, value.stateRoot)
  await mutate(value)
  await assert.rejects(augmentNativePayloadWithLayeredMemory(request, value.meta, value.stateRoot), pattern)
  await assert.rejects(assertDigitalWorkerProviderDispatchAllowed(value.meta, value.stateRoot), (error: unknown) => {
    assert(error instanceof DigitalWorkerProviderDispatchDeniedError)
    assert.match(error.message, pattern)
    return true
  })
}

async function assertDeniedDuringRetrieval(id: string, mutate: (value: Fixture) => Promise<unknown>, pattern: RegExp) {
  const value = await fixture(id)
  let entered!: () => void
  let release!: () => void
  const didEnter = new Promise<void>((resolve) => { entered = resolve })
  const mayFinish = new Promise<void>((resolve) => { release = resolve })
  hooks.__workerContextRetrieval = async () => { entered(); await mayFinish; return '' }
  const pending = augmentNativePayloadWithLayeredMemory(request, value.meta, value.stateRoot)
  try {
    await didEnter
    await mutate(value)
    release()
    await assert.rejects(pending, pattern)
  } finally {
    release()
    delete hooks.__workerContextRetrieval
  }
}

async function reassign(value: Fixture) {
  const next = await value.store.createDigitalWorker({ id: `${value.worker.id}-next`, projectId: value.worker.projectId,
    roleTemplateId: value.role.id, displayName: 'Replacement Worker' })
  await value.store.activateDigitalWorker(next.id, { expectedRevision: next.revision })
  return value.store.reassignAssignment(value.assignment.id, { id: `${value.assignment.id}-next`,
    projectId: value.worker.projectId, workItemId: value.assignment.workItemId, assigneeKind: 'digital_worker', assigneeId: next.id,
    assignedAt: 150, assignedBy: 'local-test-user' }, { expectedRevision: value.assignment.revision }, { now: 150 })
}

async function main() {
  const emptyMemory = await fixture('without-memory')
  assert.equal(await buildDigitalWorkerMemoryPrompt(emptyMemory.stateRoot, emptyMemory.meta), '')
  const inputBefore = structuredClone(request)
  const result = await augmentNativePayloadWithLayeredMemory(request, emptyMemory.meta, emptyMemory.stateRoot)
  assert.equal(result.hasMemoryContext, false)
  for (const expected of [emptyMemory.worker.displayName, emptyMemory.worker.id, emptyMemory.role.instructions,
    `${emptyMemory.role.id}@${emptyMemory.role.version}`, emptyMemory.assignment.id, emptyMemory.assignment.workItemId,
    emptyMemory.worker.responsibilityScope[0], '"minimumEvidenceCount":1', '"requireUserApproval":true', '"requireArtifactInspection":true',
    '"allowedResourceIds":["brief"]', '"concurrencyLimit":2', request.text]) assert(result.payload.text.includes(expected), expected)
  assert.deepEqual(request, inputBefore)
  assert(!result.payload.text.includes('## DigitalWorker Memory'))
  checks.push('real assigned Worker receives role instructions, identity, scope and acceptance even with zero approved memories')

  const attachments: StableMessagePayload = { text: '', messageId: 'attachment-message',
    images: [{ id: 'image', hash: 'image-hash', path: '/fixture/image.png', mime: 'image/png', bytes: 1, createdAt: '2026-09-15' }],
    documents: [{ id: 'document', hash: 'document-hash', path: '/fixture/brief.txt', name: 'brief.txt', mime: 'text/plain; charset=utf-8', bytes: 1, createdAt: '2026-09-15', dataClass: 'S2' }],
    officeRevisionIntent: { planId: 'revision', planDigest: 'revision-digest', baseArtifactId: 'artifact', baseDigest: 'base-digest' } }
  const attachmentBefore = structuredClone(attachments)
  const augmented = (await augmentNativePayloadWithLayeredMemory(attachments, emptyMemory.meta, emptyMemory.stateRoot)).payload
  assert.match(augmented.text, /DigitalWorker Execution Context/)
  assert.equal(augmented.images, attachments.images)
  assert.equal(augmented.documents, attachments.documents)
  assert.equal(augmented.officeRevisionIntent, attachments.officeRevisionIntent)
  assert.equal(augmented.messageId, attachments.messageId)
  assert.deepEqual(attachments, attachmentBefore)
  for (const only of [{ ...attachments, documents: [] }, { ...attachments, images: [] }]) {
    assert.match((await augmentNativePayloadWithLayeredMemory(only, emptyMemory.meta, emptyMemory.stateRoot)).payload.text, /DigitalWorker Execution Context/)
  }
  checks.push('image-only, document-only and mixed attachment input receives Worker context without dropping payload fields or mutating input')

  const unscoped: SessionMeta = { ...emptyMemory.meta, id: 'unscoped', projectId: undefined, workspaceId: undefined, workItemId: undefined,
    digitalWorkerBinding: { kind: 'unscoped' } }
  assert.equal(buildDigitalWorkerExecutionPrompt(emptyMemory.stateRoot, unscoped), '')
  assert.equal((await augmentNativePayloadWithLayeredMemory(request, unscoped, emptyMemory.stateRoot)).payload, request)
  assert.equal((await augmentNativePayloadWithLayeredMemory(request, { ...unscoped, digitalWorkerBinding: undefined }, emptyMemory.stateRoot)).payload, request)
  checks.push('unscoped and legacy ordinary sessions never inherit an assigned Worker role')

  const switched: SessionMeta = { ...emptyMemory.meta, engine: 'anthropic', model: 'fixture-anthropic-model', providerId: 'fixture-anthropic-provider' }
  assert.equal(buildDigitalWorkerExecutionPrompt(emptyMemory.stateRoot, switched), buildDigitalWorkerExecutionPrompt(emptyMemory.stateRoot, emptyMemory.meta))
  assert.equal((await augmentNativePayloadWithLayeredMemory(request, switched, emptyMemory.stateRoot)).payload.text, result.payload.text)
  await assertDigitalWorkerProviderDispatchAllowed(switched, emptyMemory.stateRoot)
  checks.push('changing native model, provider and engine preserves the durable Worker identity and execution context')

  await assertDeniedAfterPreparation('reassigned', reassign, /Assignment|分配/)
  checks.push('released and replaced Assignment blocks old session prompt construction and actual Provider preflight')
  await assertDeniedAfterPreparation('paused', (f) => f.store.pauseDigitalWorker(f.worker.id, { expectedRevision: f.worker.revision }), /不可用/)
  checks.push('paused Worker blocks prompt construction and actual Provider preflight')
  await assertDeniedAfterPreparation('archived-role', (f) => f.store.updateRoleTemplate(f.role.id, { archivedAt: 150 }, { expectedRevision: f.role.revision }), /岗位模板不可用/)
  checks.push('role archived after context preparation blocks prompt construction and actual Provider preflight')
  await assertDeniedAfterPreparation('changed-role', (f) => f.store.updateRoleTemplate(f.role.id, { instructions: 'New instructions must not impersonate the pinned old role' }, { expectedRevision: f.role.revision }), /岗位版本已变化/)
  checks.push('role version changed after context preparation blocks dispatch until a matching Worker is assigned')

  await assertDeniedDuringRetrieval('retrieval-reassigned', reassign, /Assignment|分配/)
  await assertDeniedDuringRetrieval('retrieval-paused', (f) => f.store.pauseDigitalWorker(f.worker.id, { expectedRevision: f.worker.revision }), /不可用/)
  await assertDeniedDuringRetrieval('retrieval-role', (f) => f.store.updateRoleTemplate(f.role.id, { instructions: 'Changed during retrieval' }, { expectedRevision: f.role.revision }), /岗位版本已变化/)
  checks.push('reassignment, pause and role change during awaited retrieval fail closed before returning stale context')
  await assertDeniedDuringRetrieval('retrieval-policy', (f) => f.store.updateDigitalWorker(f.worker.id, { responsibilityScope: ['New responsibility'], toolPolicy: { read: true, write: false } }, { expectedRevision: f.worker.revision }), /执行约束在准备上下文时变化/)
  await assertDeniedDuringRetrieval('retrieval-namespace', (f) => f.store.updateDigitalWorker(f.worker.id, { memoryNamespace: 'worker/new-namespace' }, { expectedRevision: f.worker.revision }), /执行约束在准备上下文时变化/)
  checks.push('Worker responsibility, tool policy and memory namespace changes invalidate asynchronously prepared context')

  const memories = await fixture('approved-memory')
  const proposed = await proposeDigitalWorkerMemory(memories.store, memories.stateRoot, memories.worker.id, { memoryKind: 'rule', title: 'Report convention', body: 'WORKER_MEMORY_CANARY: inspect tables before reporting completion', reason: 'Keep the user-approved inspection convention for this Worker' })
  assert.equal(proposed.drafts.length, 1)
  assert.equal((await augmentNativePayloadWithLayeredMemory(request, memories.meta, memories.stateRoot)).hasMemoryContext, false)
  await decideDigitalWorkerMemory(memories.store, memories.stateRoot, memories.worker.id, proposed.drafts[0].id, 'approve')
  const withMemory = await augmentNativePayloadWithLayeredMemory(request, memories.meta, memories.stateRoot)
  assert.equal(withMemory.hasMemoryContext, true)
  assert.match(withMemory.payload.text, /WORKER_MEMORY_CANARY/)
  assert.match(withMemory.payload.text, /DigitalWorker Execution Context/)
  assert.match(withMemory.payload.text, /DigitalWorker Memory/)
  checks.push('real Worker learning drafts stay excluded; user-approved memory coexists with role execution instructions')

  const missingRun = { ...emptyMemory.meta, id: 'without-canonical-run' }
  await assert.rejects(assertDigitalWorkerProviderDispatchAllowed(missingRun, emptyMemory.stateRoot), /canonical TaskRun/)
  assert.equal(providerCalls, 0)
  checks.push('actual Provider preflight still requires a canonical TaskRun; fixture performs zero network calls')
  console.log(JSON.stringify({ status: 'passed', checks, providerCalls, humanEvidence: false,
    limitations: ['Real DigitalWorker store, Assignment binding, Worker memory, shared native prompt augmentation and Provider preflight run locally.',
      'Only Electron shell, shared memory retrieval, settings/skill lookup and IDE context are stubbed; no real Provider, Office execution or human acceptance is claimed.'] }))
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
