import { app, BrowserWindow, ipcMain } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  awaitAssignmentOwnerReadiness,
  DigitalWorkerStore,
  failAssignmentOwnerReadiness,
  openAssignmentOwnerCoordinator,
  retryAssignmentOwnerReadiness,
  startAssignmentOwnerReadiness,
  withAssignmentOwnerReadAccess,
  withAssignmentOwnerWriteAccess,
  type AssignmentListFilter,
  type AuditListFilter,
  type LeaseHeartbeatInput,
  type LeaseListFilter,
  type ReassignResult,
  type RevisionOptions,
  type WorkerLifecycleOptions
} from '../digital-worker'
import { openProjectWorkspaceStore } from '../project-workspace'
import type {
  AcquireLeaseInput,
  AssignmentInput,
  AssignmentAssigneeKind,
  DigitalWorkerAssignmentListFilter,
  DigitalWorkerAuditListFilter,
  DigitalWorkerHeartbeatInput,
  DigitalWorkerLeaseListFilter,
  DigitalWorkerLifecycleOptions,
  DigitalWorkerListOptions,
  DigitalWorkerReleaseOptions,
  DigitalWorkerReassignInput,
  DigitalWorkerRevisionOptions,
  DigitalWorkerRoleTemplateListOptions,
  DigitalWorkerStatus,
  DigitalWorkerPatch,
  JsonObject,
  LeaseTokenInput,
  RoleTemplateInput,
  RoleTemplatePatch,
  RoleTemplateSource,
  AssignmentStatus,
  WorkerLeaseStatus
} from '../../shared/digital-worker-types'
import {
  digitalWorkerMutationProjectIds,
  isProjectOwnedDigitalWorkerMutation,
  verifyDigitalWorkerMutation
} from './digital-worker-project-mutation'
import { DIGITAL_WORKER_FEATURE_HANDLERS } from './digital-worker-feature-handlers'
import { assertActiveProject, assertProjectWorkItem } from './digital-worker-project-boundary'

const ROLE_TEMPLATE_SOURCES = new Set<RoleTemplateSource>(['builtin', 'user', 'imported', 'system'])
const WORKER_STATUSES = new Set<DigitalWorkerStatus>(['proposed', 'active', 'paused', 'retired'])
const ASSIGNEE_KINDS = new Set<AssignmentAssigneeKind>(['digital_worker', 'human'])
const ASSIGNMENT_STATUSES = new Set<AssignmentStatus>(['active', 'released'])
const LEASE_STATUSES = new Set<WorkerLeaseStatus>(['active', 'released', 'expired'])
const AUDIT_KINDS = new Set([
  'role_template.created', 'role_template.updated', 'role_template.deleted',
  'worker.created', 'worker.updated', 'worker.lifecycle', 'worker.deleted',
  'assignment.created', 'assignment.released', 'lease.acquired',
  'lease.heartbeat', 'lease.released', 'lease.expired'
])

type DigitalWorkerActionHandler = (store: DigitalWorkerStore, payload: Record<string, unknown>) => unknown

const DIGITAL_WORKER_ACTION_HANDLERS = {
  verifyDigitalWorkerStore: (store, payload) => {
    assertGatewayPayload(payload, [], 'verifyDigitalWorkerStore')
    return store.verify()
  },
  getDigitalWorkerStoreSnapshot: (store, payload) => {
    assertGatewayPayload(payload, [], 'getDigitalWorkerStoreSnapshot')
    return store.snapshot()
  },
  ...DIGITAL_WORKER_FEATURE_HANDLERS,
  listDigitalWorkerRoleTemplates: (store, payload) => {
    assertGatewayPayload(payload, ['options'], 'listDigitalWorkerRoleTemplates')
    return store.listRoleTemplates(normalizeRoleTemplateListOptions(payload.options))
  },
  getDigitalWorkerRoleTemplate: (store, payload) => {
    assertGatewayPayload(payload, ['id'], 'getDigitalWorkerRoleTemplate')
    return store.getRoleTemplate(requiredId(payload.id, 'roleTemplate id'))
  },
  createDigitalWorkerRoleTemplate: (store, payload) => {
    assertGatewayPayload(payload, ['input'], 'createDigitalWorkerRoleTemplate')
    return store.createRoleTemplate(normalizeRoleTemplateInput(payload.input))
  },
  updateDigitalWorkerRoleTemplate: (store, payload) => {
    assertGatewayPayload(payload, ['id', 'patch', 'options'], 'updateDigitalWorkerRoleTemplate')
    return store.updateRoleTemplate(
      requiredId(payload.id, 'roleTemplate id'),
      normalizeRoleTemplatePatch(payload.patch),
      normalizeRevisionOptions(payload.options)
    )
  },
  deleteDigitalWorkerRoleTemplate: (store, payload) => {
    assertGatewayPayload(payload, ['id', 'options'], 'deleteDigitalWorkerRoleTemplate')
    return store.deleteRoleTemplate(requiredId(payload.id, 'roleTemplate id'), normalizeRevisionOptions(payload.options))
  },
  listDigitalWorkers: (store, payload) => {
    assertGatewayPayload(payload, ['options'], 'listDigitalWorkers')
    return store.listDigitalWorkers(normalizeWorkerListOptions(payload.options))
  },
  getDigitalWorker: (store, payload) => {
    assertGatewayPayload(payload, ['id'], 'getDigitalWorker')
    return store.getDigitalWorker(requiredId(payload.id, 'DigitalWorker id'))
  },
  createDigitalWorker: (store, payload) => {
    assertGatewayPayload(payload, ['input'], 'createDigitalWorker')
    return store.createDigitalWorker(normalizeDigitalWorkerInput(payload.input))
  },
  updateDigitalWorker: (store, payload) => {
    assertGatewayPayload(payload, ['id', 'patch', 'options'], 'updateDigitalWorker')
    return store.updateDigitalWorker(
      requiredId(payload.id, 'DigitalWorker id'),
      normalizeDigitalWorkerPatch(payload.patch),
      normalizeRevisionOptions(payload.options)
    )
  },
  activateDigitalWorker: workerLifecycleAction((store, id, options) => store.activateDigitalWorker(id, options)),
  pauseDigitalWorker: workerLifecycleAction((store, id, options) => store.pauseDigitalWorker(id, options)),
  resumeDigitalWorker: workerLifecycleAction((store, id, options) => store.resumeDigitalWorker(id, options)),
  retireDigitalWorker: workerLifecycleAction((store, id, options) => store.retireDigitalWorker(id, options)),
  deleteDigitalWorker: (store, payload) => {
    assertGatewayPayload(payload, ['id', 'options'], 'deleteDigitalWorker')
    return store.deleteDigitalWorker(requiredId(payload.id, 'DigitalWorker id'), normalizeRevisionOptions(payload.options))
  },
  getDigitalWorkerAssignment: (store, payload) => {
    assertGatewayPayload(payload, ['id'], 'getDigitalWorkerAssignment')
    return store.getAssignment(requiredId(payload.id, 'Assignment id'))
  },
  listDigitalWorkerAssignments: (store, payload) => {
    assertGatewayPayload(payload, ['filter'], 'listDigitalWorkerAssignments')
    return store.listAssignments(normalizeAssignmentFilter(payload.filter))
  },
  listDigitalWorkerAssignmentHistory: (store, payload) => {
    assertGatewayPayload(payload, ['filter'], 'listDigitalWorkerAssignmentHistory')
    return store.listAssignmentHistory(normalizeAssignmentFilter(payload.filter, false))
  },
  createDigitalWorkerAssignment: async (_store, payload) => {
    assertGatewayPayload(payload, ['input'], 'createDigitalWorkerAssignment')
    const input = normalizeAssignmentInput(payload.input)
    const coordinator = await assignmentOwnerCoordinator()
    const result = await coordinator.createAssignment({
      requestId: legacyCreateRequestId(input),
      input
    })
    return result.assignment
  },
  releaseDigitalWorkerAssignment: async (_store, payload) => {
    assertGatewayPayload(payload, ['id', 'options', 'releaseOptions'], 'releaseDigitalWorkerAssignment')
    const assignmentId = requiredId(payload.id, 'Assignment id')
    const coordinator = await assignmentOwnerCoordinator()
    const result = await coordinator.releaseAssignment({
      requestId: `legacy-release:${assignmentId}`,
      assignmentId,
      options: normalizeRevisionOptions(payload.options),
      releaseOptions: normalizeReleaseOptions(payload.releaseOptions)
    })
    return result.assignment
  },
  reassignDigitalWorkerAssignment: async (_store, payload) => {
    assertGatewayPayload(payload, ['input'], 'reassignDigitalWorkerAssignment')
    const input = normalizeReassignInput(payload.input)
    const coordinator = await assignmentOwnerCoordinator()
    const result = await coordinator.reassignAssignment({
      requestId: legacyReassignRequestId(input),
      currentAssignmentId: input.currentAssignmentId,
      nextInput: input.nextInput,
      expectedRevision: input.expectedRevision,
      expectedWorkItemRevision: input.expectedWorkItemRevision,
      expectedStoreRevision: input.expectedStoreRevision,
      now: input.now,
      reason: input.reason
    })
    if (!result.released || !result.assigned) {
      throw new Error(`Reassignment receipt is incomplete: ${result.journalId}`)
    }
    return { released: result.released, assigned: result.assigned }
  },
  coordinateDigitalWorkerAssignmentOwner: async (_store, payload) => {
    assertGatewayPayload(payload, ['input'], 'coordinateDigitalWorkerAssignmentOwner')
    const coordinator = await assignmentOwnerCoordinator()
    return coordinator.coordinate(payload.input)
  },
  recoverDigitalWorkerAssignmentOwners: async (_store, payload) => {
    assertGatewayPayload(payload, [], 'recoverDigitalWorkerAssignmentOwners')
    return retryAssignmentOwnerReadiness(app.getPath('userData'))
  },
  getDigitalWorkerAssignmentOwnerJournal: async (_store, payload) => {
    assertGatewayPayload(payload, ['requestId'], 'getDigitalWorkerAssignmentOwnerJournal')
    const coordinator = await diagnosticAssignmentOwnerCoordinator()
    return coordinator.getJournalEntry(requiredId(payload.requestId, 'requestId'))
  },
  listDigitalWorkerAssignmentOwnerAudit: async (_store, payload) => {
    assertGatewayPayload(payload, ['requestId'], 'listDigitalWorkerAssignmentOwnerAudit')
    const coordinator = await diagnosticAssignmentOwnerCoordinator()
    const requestId = payload.requestId === undefined ? undefined : requiredId(payload.requestId, 'requestId')
    return coordinator.listAudit(requestId)
  },
  getDigitalWorkerLease: (store, payload) => {
    assertGatewayPayload(payload, ['id'], 'getDigitalWorkerLease')
    return store.getLease(requiredId(payload.id, 'lease id'))
  },
  listDigitalWorkerLeases: (store, payload) => {
    assertGatewayPayload(payload, ['filter'], 'listDigitalWorkerLeases')
    return store.listLeases(normalizeLeaseFilter(payload.filter))
  },
  acquireDigitalWorkerLease: (store, payload) => {
    assertGatewayPayload(payload, ['input'], 'acquireDigitalWorkerLease')
    return store.acquireLease(normalizeAcquireLeaseInput(payload.input))
  },
  heartbeatDigitalWorkerLease: (store, payload) => {
    assertGatewayPayload(payload, ['input'], 'heartbeatDigitalWorkerLease')
    return store.heartbeatLease(normalizeHeartbeatInput(payload.input))
  },
  releaseDigitalWorkerLease: (store, payload) => {
    assertGatewayPayload(payload, ['input'], 'releaseDigitalWorkerLease')
    return store.releaseLease(normalizeLeaseTokenInput(payload.input))
  },
  listDigitalWorkerAuditEvents: (store, payload) => {
    assertGatewayPayload(payload, ['filter'], 'listDigitalWorkerAuditEvents')
    return store.listAuditEvents(normalizeAuditFilter(payload.filter))
  }
} satisfies Record<string, DigitalWorkerActionHandler>

type DigitalWorkerAction = keyof typeof DIGITAL_WORKER_ACTION_HANDLERS

const ASSIGNMENT_ACTIONS = new Set<DigitalWorkerAction>([
  'getDigitalWorkerAssignment',
  'listDigitalWorkerAssignments',
  'listDigitalWorkerAssignmentHistory',
  'createDigitalWorkerAssignment',
  'releaseDigitalWorkerAssignment',
  'reassignDigitalWorkerAssignment',
  'coordinateDigitalWorkerAssignmentOwner'
])
const ASSIGNMENT_MUTATION_ACTIONS = new Set<DigitalWorkerAction>([
  'createDigitalWorkerAssignment',
  'releaseDigitalWorkerAssignment',
  'reassignDigitalWorkerAssignment',
  'coordinateDigitalWorkerAssignmentOwner'
])
/** A single action gateway keeps the Electron bridge bounded without weakening validation. */
export function registerDigitalWorkerIpc(): void {
  startAssignmentOwnerReadiness(app.getPath('userData'))
  ipcMain.handle('digitalWorker:invoke', (event, rawRequest: unknown) => {
    assertTrustedDigitalWorkerSender(event)
    return dispatchDigitalWorkerAction(rawRequest)
  })
}

async function dispatchDigitalWorkerAction(rawRequest: unknown): Promise<unknown> {
  const request = requiredRecord(rawRequest, 'DigitalWorker gateway request')
  assertAllowedKeys(request, ['action', 'payload'], 'DigitalWorker gateway request')
  const action = normalizeDigitalWorkerAction(request.action)
  const payload = request.payload === undefined
    ? {}
    : requiredRecord(request.payload, `${action} payload`)
  const rootDir = app.getPath('userData')
  const beforeProjectIds = digitalWorkerMutationProjectIds(action, payload, rootDir)
  const invoke = async () => {
    try {
      await assertProjectWorkspaceBoundary(action, payload, rootDir)
      const result = await DIGITAL_WORKER_ACTION_HANDLERS[action](digitalWorkerStore(), payload)
      if (ASSIGNMENT_MUTATION_ACTIONS.has(action) && isProjectOwnedDigitalWorkerMutation(action)) {
        await verifyDigitalWorkerMutation(rootDir, beforeProjectIds, result)
      }
      return result
    } catch (error) {
      if (ASSIGNMENT_MUTATION_ACTIONS.has(action) && isRecoveryFailure(error)) {
        failAssignmentOwnerReadiness(rootDir, error)
      }
      throw error
    }
  }
  const result = ASSIGNMENT_MUTATION_ACTIONS.has(action)
    ? await withAssignmentOwnerWriteAccess(rootDir, invoke)
    : ASSIGNMENT_ACTIONS.has(action)
      ? await withAssignmentOwnerReadAccess(rootDir, invoke)
      : await invoke()
  if (!ASSIGNMENT_MUTATION_ACTIONS.has(action) && isProjectOwnedDigitalWorkerMutation(action)) {
    await verifyDigitalWorkerMutation(rootDir, beforeProjectIds, result)
  }
  return result
}

async function assertProjectWorkspaceBoundary(
  action: DigitalWorkerAction,
  payload: Record<string, unknown>,
  rootDir: string
): Promise<void> {
  if (action === 'createDigitalWorker') {
    const input = normalizeDigitalWorkerInput(payload.input)
    await assertActiveProject(rootDir, input.projectId)
    return
  }
  if (action === 'refreshDigitalWorkerPerformance') {
    const worker = await digitalWorkerStore().getDigitalWorker(requiredId(payload.id, 'DigitalWorker id'))
    if (!worker) throw new Error('DigitalWorker not found')
    await assertActiveProject(rootDir, worker.projectId)
    return
  }
  if (action === 'createDigitalWorkerAssignment') {
    const input = normalizeAssignmentInput(payload.input)
    await assertProjectWorkItem(rootDir, input.projectId, input.workItemId)
    return
  }
  if (action === 'reassignDigitalWorkerAssignment') {
    const input = normalizeReassignInput(payload.input)
    await assertProjectWorkItem(rootDir, input.nextInput.projectId, input.nextInput.workItemId)
    return
  }
  if (action === 'acquireDigitalWorkerLease') {
    const input = normalizeAcquireLeaseInput(payload.input)
    await assertProjectWorkItem(rootDir, input.projectId, input.workItemId)
    return
  }
  if (action === 'deleteDigitalWorker') {
    const workerId = requiredId(payload.id, 'DigitalWorker id')
    const worker = await digitalWorkerStore().getDigitalWorker(workerId)
    if (!worker) return
    const workspace = await openProjectWorkspaceStore(rootDir)
    const squads = await workspace.listSquads(worker.projectId, { includeArchived: true, includeDeleted: true })
    const squad = squads.find((candidate) => candidate.members.some((member) =>
      member.type === 'digital_worker' && member.id === workerId))
    if (squad) {
      throw new Error(`DigitalWorker ${workerId} is still referenced by Squad ${squad.id}`)
    }
  }
}

function normalizeDigitalWorkerAction(value: unknown): DigitalWorkerAction {
  if (typeof value !== 'string' || value !== value.trim() || !Object.hasOwn(DIGITAL_WORKER_ACTION_HANDLERS, value)) {
    throw new Error('DigitalWorker gateway action is invalid')
  }
  return value as DigitalWorkerAction
}

function assertGatewayPayload(payload: Record<string, unknown>, allowed: readonly string[], action: string): void {
  assertAllowedKeys(payload, allowed, `${action} payload`)
}

function workerLifecycleAction(
  operation: (store: DigitalWorkerStore, id: string, options: WorkerLifecycleOptions) => Promise<unknown>
): DigitalWorkerActionHandler {
  return (store, payload) => {
    assertGatewayPayload(payload, ['id', 'options'], 'DigitalWorker lifecycle')
    return operation(
      store,
      requiredId(payload.id, 'DigitalWorker id'),
      normalizeLifecycleOptions(payload.options)
    )
  }
}

function digitalWorkerStore(): DigitalWorkerStore {
  // Keep the file at userData/digital-workers.json.  No renderer-supplied root.
  return new DigitalWorkerStore(app.getPath('userData'))
}

function assignmentOwnerCoordinator() {
  return awaitAssignmentOwnerReadiness(app.getPath('userData'))
}

function legacyCreateRequestId(input: AssignmentInput): string {
  return `legacy-create:${input.id ?? randomUUID()}`
}

function legacyReassignRequestId(input: DigitalWorkerReassignInput): string {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32)
  return `legacy-reassign:${input.currentAssignmentId}:${digest}`
}

function diagnosticAssignmentOwnerCoordinator() {
  return openAssignmentOwnerCoordinator(app.getPath('userData'), false)
}

function isRecoveryFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return code === 'RECOVERY_PENDING' || code === 'JOURNAL_CORRUPT'
}

export function assertTrustedDigitalWorkerSender(event: unknown, trustedSenders?: readonly unknown[]): void {
  if (!isTrustedDigitalWorkerSender(event, trustedSenders)) {
    throw new Error('DigitalWorker IPC sender is not trusted')
  }
}

export function isTrustedDigitalWorkerSender(event: unknown, trustedSenders?: readonly unknown[]): boolean {
  if (!isRecord(event)) return false
  const sender = event.sender
  if (!sender || typeof sender !== 'object') return false
  const isDestroyed = (sender as { isDestroyed?: () => boolean }).isDestroyed
  if (typeof isDestroyed === 'function' && isDestroyed.call(sender)) return false
  const owned = trustedSenders
    ? trustedSenders.includes(sender)
    : BrowserWindow.getAllWindows().some((window) => window.webContents === sender)
  if (!owned) return false
  const frame = event.senderFrame
  const mainFrame = (sender as { mainFrame?: unknown }).mainFrame
  if (!frame || typeof frame !== 'object' || frame !== mainFrame) return false
  const rawUrl = typeof (frame as { url?: unknown }).url === 'string'
    ? (frame as { url: string }).url
    : ''
  return isTrustedRendererUrl(rawUrl)
}

function isTrustedRendererUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    if (developmentUrl) {
      const expected = new URL(developmentUrl)
      return url.origin === expected.origin && url.pathname === expected.pathname
    }
    const expected = pathToFileURL(join(__dirname, '../renderer/index.html'))
    return url.protocol === 'file:' && url.href === expected.href
  } catch {
    return false
  }
}

function normalizeRoleTemplateListOptions(value: unknown): DigitalWorkerRoleTemplateListOptions {
  const record = optionalRecord(value, 'RoleTemplate list options')
  assertAllowedKeys(record, ['includeArchived'], 'RoleTemplate list options')
  return record.includeArchived === undefined ? {} : { includeArchived: booleanValue(record.includeArchived, 'includeArchived') }
}

function normalizeRoleTemplateInput(value: unknown): RoleTemplateInput {
  const record = requiredRecord(value, 'RoleTemplate input')
  assertAllowedKeys(record, [
    'id', 'name', 'purpose', 'instructions', 'capabilityRefs', 'skillRefs', 'toolPolicy',
    'memoryPolicy', 'routingRequirements', 'verificationPolicy', 'escalationPolicy',
    'source', 'createdAt', 'updatedAt'
  ], 'RoleTemplate input')
  return {
    ...(record.id === undefined ? {} : { id: requiredId(record.id, 'RoleTemplate id') }),
    name: requiredText(record.name, 'name'),
    purpose: requiredContent(record.purpose, 'purpose', 8_192),
    ...(record.instructions === undefined ? {} : { instructions: requiredContent(record.instructions, 'instructions', 100_000) }),
    ...(record.capabilityRefs === undefined ? {} : { capabilityRefs: stringArray(record.capabilityRefs, 'capabilityRefs') }),
    ...(record.skillRefs === undefined ? {} : { skillRefs: stringArray(record.skillRefs, 'skillRefs') }),
    ...(record.toolPolicy === undefined ? {} : { toolPolicy: jsonObject(record.toolPolicy, 'toolPolicy') }),
    ...(record.memoryPolicy === undefined ? {} : { memoryPolicy: jsonObject(record.memoryPolicy, 'memoryPolicy') }),
    ...(record.routingRequirements === undefined ? {} : { routingRequirements: jsonObject(record.routingRequirements, 'routingRequirements') }),
    ...(record.verificationPolicy === undefined ? {} : { verificationPolicy: jsonObject(record.verificationPolicy, 'verificationPolicy') }),
    ...(record.escalationPolicy === undefined ? {} : { escalationPolicy: jsonObject(record.escalationPolicy, 'escalationPolicy') }),
    ...(record.source === undefined ? {} : { source: enumValue(record.source, 'source', ROLE_TEMPLATE_SOURCES) }),
    ...(record.createdAt === undefined ? {} : { createdAt: nonNegativeNumber(record.createdAt, 'createdAt') }),
    ...(record.updatedAt === undefined ? {} : { updatedAt: nonNegativeNumber(record.updatedAt, 'updatedAt') })
  }
}

function normalizeRoleTemplatePatch(value: unknown): RoleTemplatePatch {
  const record = requiredRecord(value, 'RoleTemplate patch')
  assertAllowedKeys(record, [
    'name', 'purpose', 'instructions', 'capabilityRefs', 'skillRefs', 'toolPolicy',
    'memoryPolicy', 'routingRequirements', 'verificationPolicy', 'escalationPolicy',
    'source', 'archivedAt'
  ], 'RoleTemplate patch')
  return {
    ...(record.name === undefined ? {} : { name: requiredText(record.name, 'name') }),
    ...(record.purpose === undefined ? {} : { purpose: requiredContent(record.purpose, 'purpose', 8_192) }),
    ...(record.instructions === undefined ? {} : { instructions: requiredContent(record.instructions, 'instructions', 100_000) }),
    ...(record.capabilityRefs === undefined ? {} : { capabilityRefs: stringArray(record.capabilityRefs, 'capabilityRefs') }),
    ...(record.skillRefs === undefined ? {} : { skillRefs: stringArray(record.skillRefs, 'skillRefs') }),
    ...(record.toolPolicy === undefined ? {} : { toolPolicy: jsonObject(record.toolPolicy, 'toolPolicy') }),
    ...(record.memoryPolicy === undefined ? {} : { memoryPolicy: jsonObject(record.memoryPolicy, 'memoryPolicy') }),
    ...(record.routingRequirements === undefined ? {} : { routingRequirements: jsonObject(record.routingRequirements, 'routingRequirements') }),
    ...(record.verificationPolicy === undefined ? {} : { verificationPolicy: jsonObject(record.verificationPolicy, 'verificationPolicy') }),
    ...(record.escalationPolicy === undefined ? {} : { escalationPolicy: jsonObject(record.escalationPolicy, 'escalationPolicy') }),
    ...(record.source === undefined ? {} : { source: enumValue(record.source, 'source', ROLE_TEMPLATE_SOURCES) }),
    ...(record.archivedAt === undefined
      ? {}
      : { archivedAt: record.archivedAt === null ? null : nonNegativeNumber(record.archivedAt, 'archivedAt') })
  }
}

function normalizeWorkerListOptions(value: unknown): DigitalWorkerListOptions {
  const record = optionalRecord(value, 'DigitalWorker list options')
  assertAllowedKeys(record, ['projectId', 'status', 'includeRetired'], 'DigitalWorker list options')
  return {
    ...(record.projectId === undefined ? {} : { projectId: requiredId(record.projectId, 'projectId') }),
    ...(record.status === undefined ? {} : { status: enumValue(record.status, 'status', WORKER_STATUSES) }),
    ...(record.includeRetired === undefined ? {} : { includeRetired: booleanValue(record.includeRetired, 'includeRetired') })
  }
}

function normalizeDigitalWorkerInput(value: unknown): import('../../shared/digital-worker-types').DigitalWorkerInput {
  const record = requiredRecord(value, 'DigitalWorker input')
  assertAllowedKeys(record, [
    'id', 'projectId', 'roleTemplateId', 'roleTemplateVersion', 'displayName', 'avatarProfile', 'status',
    'responsibilityScope', 'capabilityOverrides', 'toolPolicy', 'dataScope', 'memoryNamespace', 'budgetPolicy',
    'concurrencyLimit', 'acceptancePolicy', 'schedulePolicy', 'escalationPolicy', 'performanceProfile',
    'createdAt', 'updatedAt'
  ], 'DigitalWorker input')
  return {
    ...optionalField(record, 'id', (entry) => requiredId(entry, 'DigitalWorker id')),
    projectId: requiredId(record.projectId, 'projectId'),
    roleTemplateId: requiredId(record.roleTemplateId, 'roleTemplateId'),
    ...optionalField(record, 'roleTemplateVersion', (entry) => positiveInteger(entry, 'roleTemplateVersion')),
    displayName: requiredText(record.displayName, 'displayName'),
    ...optionalField(record, 'avatarProfile', (entry) => jsonObject(entry, 'avatarProfile')),
    ...optionalField(record, 'status', (entry) => enumValue(entry, 'status', WORKER_STATUSES)),
    ...optionalField(record, 'responsibilityScope', (entry) => stringArrayOrString(entry, 'responsibilityScope')),
    ...optionalField(record, 'capabilityOverrides', (entry) => jsonObject(entry, 'capabilityOverrides')),
    ...optionalField(record, 'toolPolicy', (entry) => jsonObject(entry, 'toolPolicy')),
    ...optionalField(record, 'dataScope', (entry) => jsonObject(entry, 'dataScope')),
    ...optionalField(record, 'memoryNamespace', (entry) => requiredText(entry, 'memoryNamespace')),
    ...optionalField(record, 'budgetPolicy', (entry) => jsonObject(entry, 'budgetPolicy')),
    ...optionalField(record, 'concurrencyLimit', (entry) => positiveInteger(entry, 'concurrencyLimit')),
    ...optionalField(record, 'acceptancePolicy', (entry) => jsonObject(entry, 'acceptancePolicy')),
    ...optionalField(record, 'schedulePolicy', (entry) => jsonObject(entry, 'schedulePolicy')),
    ...optionalField(record, 'escalationPolicy', (entry) => jsonObject(entry, 'escalationPolicy')),
    ...optionalField(record, 'performanceProfile', (entry) => jsonObject(entry, 'performanceProfile')),
    ...optionalField(record, 'createdAt', (entry) => nonNegativeNumber(entry, 'createdAt')),
    ...optionalField(record, 'updatedAt', (entry) => nonNegativeNumber(entry, 'updatedAt'))
  } as import('../../shared/digital-worker-types').DigitalWorkerInput
}

function normalizeDigitalWorkerPatch(value: unknown): DigitalWorkerPatch {
  const record = requiredRecord(value, 'DigitalWorker patch')
  assertAllowedKeys(record, [
    'displayName', 'avatarProfile', 'responsibilityScope', 'capabilityOverrides', 'toolPolicy', 'dataScope',
    'memoryNamespace', 'budgetPolicy', 'concurrencyLimit', 'acceptancePolicy', 'schedulePolicy', 'escalationPolicy',
    'performanceProfile'
  ], 'DigitalWorker patch')
  return {
    ...(record.displayName === undefined ? {} : { displayName: requiredText(record.displayName, 'displayName') }),
    ...(record.avatarProfile === undefined ? {} : { avatarProfile: jsonObject(record.avatarProfile, 'avatarProfile') }),
    ...(record.responsibilityScope === undefined ? {} : { responsibilityScope: stringArrayOrString(record.responsibilityScope, 'responsibilityScope') }),
    ...(record.capabilityOverrides === undefined ? {} : { capabilityOverrides: jsonObject(record.capabilityOverrides, 'capabilityOverrides') }),
    ...(record.toolPolicy === undefined ? {} : { toolPolicy: jsonObject(record.toolPolicy, 'toolPolicy') }),
    ...(record.dataScope === undefined ? {} : { dataScope: jsonObject(record.dataScope, 'dataScope') }),
    ...(record.memoryNamespace === undefined ? {} : { memoryNamespace: requiredText(record.memoryNamespace, 'memoryNamespace') }),
    ...(record.budgetPolicy === undefined ? {} : { budgetPolicy: jsonObject(record.budgetPolicy, 'budgetPolicy') }),
    ...(record.concurrencyLimit === undefined ? {} : { concurrencyLimit: positiveInteger(record.concurrencyLimit, 'concurrencyLimit') }),
    ...(record.acceptancePolicy === undefined ? {} : { acceptancePolicy: jsonObject(record.acceptancePolicy, 'acceptancePolicy') }),
    ...(record.schedulePolicy === undefined ? {} : { schedulePolicy: jsonObject(record.schedulePolicy, 'schedulePolicy') }),
    ...(record.escalationPolicy === undefined ? {} : { escalationPolicy: jsonObject(record.escalationPolicy, 'escalationPolicy') }),
    ...(record.performanceProfile === undefined ? {} : { performanceProfile: jsonObject(record.performanceProfile, 'performanceProfile') })
  }
}

function normalizeAssignmentInput(value: unknown): AssignmentInput {
  const record = requiredRecord(value, 'Assignment input')
  assertAllowedKeys(record, ['id', 'projectId', 'workItemId', 'assigneeKind', 'assigneeId', 'scope', 'assignedBy', 'assignedAt', 'reason'], 'Assignment input')
  return {
    ...(record.id === undefined ? {} : { id: requiredId(record.id, 'Assignment id') }),
    projectId: requiredId(record.projectId, 'projectId'),
    workItemId: requiredId(record.workItemId, 'workItemId'),
    assigneeKind: enumValue(record.assigneeKind, 'assigneeKind', ASSIGNEE_KINDS),
    assigneeId: requiredId(record.assigneeId, 'assigneeId'),
    ...(record.scope === undefined ? {} : { scope: jsonObject(record.scope, 'scope') }),
    assignedBy: requiredId(record.assignedBy, 'assignedBy'),
    ...(record.assignedAt === undefined ? {} : { assignedAt: nonNegativeNumber(record.assignedAt, 'assignedAt') }),
    ...(record.reason === undefined ? {} : { reason: requiredContent(record.reason, 'reason', 8_192) })
  }
}

function normalizeAssignmentFilter(value: unknown, allowIncludeHistory = true): AssignmentListFilter {
  const record = optionalRecord(value, 'Assignment filter')
  const keys = ['projectId', 'workItemId', 'assigneeId', 'assigneeKind', 'status']
  if (allowIncludeHistory) keys.push('includeHistory')
  assertAllowedKeys(record, keys, 'Assignment filter')
  return {
    ...(record.projectId === undefined ? {} : { projectId: requiredId(record.projectId, 'projectId') }),
    ...(record.workItemId === undefined ? {} : { workItemId: requiredId(record.workItemId, 'workItemId') }),
    ...(record.assigneeId === undefined ? {} : { assigneeId: requiredId(record.assigneeId, 'assigneeId') }),
    ...(record.assigneeKind === undefined ? {} : { assigneeKind: enumValue(record.assigneeKind, 'assigneeKind', ASSIGNEE_KINDS) }),
    ...(record.status === undefined ? {} : { status: enumValue(record.status, 'status', ASSIGNMENT_STATUSES) }),
    ...(allowIncludeHistory && record.includeHistory !== undefined ? { includeHistory: booleanValue(record.includeHistory, 'includeHistory') } : {})
  }
}

function normalizeReleaseOptions(value: unknown): DigitalWorkerReleaseOptions {
  const record = optionalRecord(value, 'Assignment release options')
  assertAllowedKeys(record, ['now', 'reason'], 'Assignment release options')
  return {
    ...(record.now === undefined ? {} : { now: nonNegativeNumber(record.now, 'release now') }),
    ...(record.reason === undefined ? {} : { reason: requiredContent(record.reason, 'reason', 8_192) })
  }
}

function normalizeReassignInput(value: unknown): DigitalWorkerReassignInput {
  const record = requiredRecord(value, 'Assignment reassign input')
  assertAllowedKeys(record, ['currentAssignmentId', 'nextInput', 'expectedRevision', 'expectedWorkItemRevision', 'expectedStoreRevision', 'now', 'reason'], 'Assignment reassign input')
  const revision = normalizeRevisionOptions({
    expectedRevision: record.expectedRevision,
    expectedStoreRevision: record.expectedStoreRevision
  })
  return {
    currentAssignmentId: requiredId(record.currentAssignmentId, 'Assignment id'),
    nextInput: normalizeAssignmentInput(record.nextInput),
    ...revision,
    ...(record.expectedWorkItemRevision === undefined
      ? {}
      : { expectedWorkItemRevision: positiveInteger(record.expectedWorkItemRevision, 'expectedWorkItemRevision') }),
    ...(record.now === undefined ? {} : { now: nonNegativeNumber(record.now, 'release now') }),
    ...(record.reason === undefined ? {} : { reason: requiredContent(record.reason, 'reason', 8_192) })
  }
}

function normalizeLeaseFilter(value: unknown): LeaseListFilter {
  const record = optionalRecord(value, 'Lease filter')
  assertAllowedKeys(record, ['projectId', 'workItemId', 'workerId', 'status', 'includeExpired'], 'Lease filter')
  return {
    ...(record.projectId === undefined ? {} : { projectId: requiredId(record.projectId, 'projectId') }),
    ...(record.workItemId === undefined ? {} : { workItemId: requiredId(record.workItemId, 'workItemId') }),
    ...(record.workerId === undefined ? {} : { workerId: requiredId(record.workerId, 'workerId') }),
    ...(record.status === undefined ? {} : { status: enumValue(record.status, 'status', LEASE_STATUSES) }),
    ...(record.includeExpired === undefined ? {} : { includeExpired: booleanValue(record.includeExpired, 'includeExpired') })
  }
}

function normalizeAcquireLeaseInput(value: unknown): AcquireLeaseInput {
  const record = requiredRecord(value, 'Lease acquire input')
  assertAllowedKeys(record, ['projectId', 'workItemId', 'workerId', 'assignmentId', 'ttlMs', 'now'], 'Lease acquire input')
  return {
    projectId: requiredId(record.projectId, 'projectId'),
    workItemId: requiredId(record.workItemId, 'workItemId'),
    workerId: requiredId(record.workerId, 'workerId'),
    ...(record.assignmentId === undefined ? {} : { assignmentId: requiredId(record.assignmentId, 'assignmentId') }),
    ...(record.ttlMs === undefined ? {} : { ttlMs: positiveInteger(record.ttlMs, 'ttlMs') }),
    ...(record.now === undefined ? {} : { now: nonNegativeNumber(record.now, 'lease now') })
  }
}

function normalizeHeartbeatInput(value: unknown): LeaseHeartbeatInput {
  const record = requiredRecord(value, 'Lease heartbeat input')
  assertAllowedKeys(record, ['leaseId', 'fencingToken', 'now', 'ttlMs'], 'Lease heartbeat input')
  return {
    leaseId: requiredId(record.leaseId, 'lease id'),
    fencingToken: positiveInteger(record.fencingToken, 'fencingToken'),
    ...(record.now === undefined ? {} : { now: nonNegativeNumber(record.now, 'lease heartbeat now') }),
    ...(record.ttlMs === undefined ? {} : { ttlMs: positiveInteger(record.ttlMs, 'ttlMs') })
  }
}

function normalizeLeaseTokenInput(value: unknown): LeaseTokenInput {
  const record = requiredRecord(value, 'Lease token input')
  assertAllowedKeys(record, ['leaseId', 'fencingToken', 'now'], 'Lease token input')
  return {
    leaseId: requiredId(record.leaseId, 'lease id'),
    fencingToken: positiveInteger(record.fencingToken, 'fencingToken'),
    ...(record.now === undefined ? {} : { now: nonNegativeNumber(record.now, 'lease release now') })
  }
}

function normalizeAuditFilter(value: unknown): AuditListFilter {
  const record = optionalRecord(value, 'Audit filter')
  assertAllowedKeys(record, ['projectId', 'entityId', 'kind'], 'Audit filter')
  return {
    ...(record.projectId === undefined ? {} : { projectId: requiredId(record.projectId, 'projectId') }),
    ...(record.entityId === undefined ? {} : { entityId: requiredId(record.entityId, 'entityId') }),
    ...(record.kind === undefined ? {} : { kind: enumValue(record.kind, 'kind', AUDIT_KINDS) as AuditListFilter['kind'] })
  }
}

function normalizeRevisionOptions(value: unknown): RevisionOptions {
  const record = optionalRecord(value, 'revision options')
  assertAllowedKeys(record, ['expectedRevision', 'expectedStoreRevision'], 'revision options')
  return {
    ...(record.expectedRevision === undefined ? {} : { expectedRevision: nonNegativeInteger(record.expectedRevision, 'expectedRevision') }),
    ...(record.expectedStoreRevision === undefined ? {} : { expectedStoreRevision: nonNegativeInteger(record.expectedStoreRevision, 'expectedStoreRevision') })
  }
}

function normalizeLifecycleOptions(value: unknown): WorkerLifecycleOptions {
  const record = optionalRecord(value, 'lifecycle options')
  assertAllowedKeys(record, ['expectedRevision', 'expectedStoreRevision', 'now'], 'lifecycle options')
  const options = normalizeRevisionOptions({
    expectedRevision: record.expectedRevision,
    expectedStoreRevision: record.expectedStoreRevision
  })
  return {
    ...options,
    ...(record.now === undefined ? {} : { now: nonNegativeNumber(record.now, 'lifecycle now') })
  }
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return value
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  return requiredRecord(value, label)
}

function optionalField(
  record: Record<string, unknown>,
  key: string,
  normalize: (value: unknown) => unknown
): Record<string, unknown> {
  if (record[key] === undefined) return {}
  return { [key]: normalize(record[key]) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains an unknown field: ${key}`)
  }
}

function requiredId(value: unknown, label: string): string {
  return requiredText(value, label, 256)
}

function requiredText(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\0-\x1F\x7F]/.test(normalized)) {
    throw new Error(`${label} has an invalid format`)
  }
  return normalized
}

function requiredContent(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\0\x08\x0B\x0C\x0E-\x1F\x7F]/.test(normalized)) {
    throw new Error(`${label} has an invalid format`)
  }
  return normalized
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((entry, index) => requiredText(entry, `${label}[${index}]`))
}

function stringArrayOrString(value: unknown, label: string): string[] | string {
  return typeof value === 'string' ? requiredText(value, label) : stringArray(value, label)
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`)
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return value as number
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive safe integer`)
  return value as number
}

function enumValue<T extends string>(value: unknown, label: string, values: ReadonlySet<T>): T {
  if (typeof value !== 'string' || !values.has(value as T)) throw new Error(`${label} has an invalid value`)
  return value as T
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  validateJsonValue(value, label, 0)
  return value as JsonObject
}

function validateJsonValue(value: unknown, label: string, depth: number): void {
  if (depth > 32) throw new Error(`${label} is too deeply nested`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateJsonValue(entry, `${label}[${index}]`, depth + 1))
    return
  }
  if (!isRecord(value)) throw new Error(`${label} contains an unsupported value`)
  for (const [key, entry] of Object.entries(value)) {
    if (!key || /[\0-\x1F\x7F]/.test(key)) throw new Error(`${label} contains an invalid key`)
    validateJsonValue(entry, `${label}.${key}`, depth + 1)
  }
}
