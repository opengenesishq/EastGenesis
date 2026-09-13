import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { DigitalWorkerAuditEvent } from '../../shared/digital-worker-types'
import type { ProjectImportResult } from '../../shared/data-lifecycle-types'
import type { ProjectAggregateAuditRecord, ProjectAggregateExportBundle } from '../../shared/project-aggregate-types'
import {
  MANAGED_PERSONAL_WORKSPACE_ID,
  type ProjectWorkspaceEvent,
  type ProjectWorkspaceState
} from '../../shared/project-workspace-types'
import { DigitalWorkerStore } from '../digital-worker/domain-store'
import { withAssignmentOwnerWriteAccess } from '../assignment-owner-coordinator/readiness'
import { mutateLearningState, readLearningState } from '../learning/learning-store'
import {
  createProductionProjectAggregateService
} from '../project-aggregate/project-aggregate-factory'
import { projectAggregateCanonicalJson } from '../project-aggregate/codec'
import {
  projectLearningNamespace,
  projectLearningNamespaceDigest
} from '../project-aggregate/project-memory-adapter'
import { ProjectWorkspaceStore } from '../project-workspace/store'
import { getProjectPortfolioStore } from '../project-portfolio/store'
import { getMediaStore } from '../media/media-store'
import { ProjectImportJournal, PROJECT_IMPORT_PHASES, type ProjectImportJournalEntry, type ProjectImportPhase } from './project-import-journal'
import { ProjectImportSourceStore } from './project-import-source-store'
import {
  parseProjectAggregateImport,
  projectImportSemanticDigest,
  projectImportSemanticMismatchPath
} from './project-import-validation'
import { importWorkflowProjectAggregate, verifyWorkflowProjectAggregateImportable } from './workflow-project-import'
import {
  assertProjectPortableRuntimeImportable,
  importProjectPortableRuntime,
  rebindProjectPortableArtifactSources,
  verifyProjectPortableRuntime
} from './project-portable-runtime'
import {
  assertProjectRoutineSliceImportable,
  importProjectRoutineSlice,
  verifyProjectRoutineSlice
} from '../routines/routine-project-store'

export interface ProjectImportOptions {
  /** Stable caller-owned operation ID for Effect reconciliation; production direct imports omit it. */
  operationId?: string
  /** Test-only crash checkpoint; production callers leave this undefined. */
  failAfterPhase?: ProjectImportPhase
  /** Test-only window after a store commit but before its journal advance. */
  failBeforeJournalPhase?: ProjectImportPhase
}

export interface PreparedProjectAggregateImport {
  bundle: ProjectAggregateExportBundle
  execute(options?: ProjectImportOptions): Promise<ProjectImportResult>
}

export interface ProjectImportRecoveryFailure {
  operationId: string
  projectId: string
  error: string
}

export interface ProjectImportRecoveryResult {
  recovered: ProjectImportResult[]
  failures: ProjectImportRecoveryFailure[]
}

export class ProjectImportRecoveryPendingError extends Error {
  readonly code = 'PROJECT_IMPORT_RECOVERY_PENDING'
  readonly failures: ProjectImportRecoveryFailure[]

  constructor(failures: readonly ProjectImportRecoveryFailure[]) {
    super(`${failures.length} Project import operation(s) remain unresolved`)
    this.name = 'ProjectImportRecoveryPendingError'
    this.failures = structuredClone([...failures])
  }
}

const projectImportRecoveryFlights = new Map<string, Promise<ProjectImportRecoveryResult>>()

export function startProjectImportRecoveryReadiness(userDataRoot: string): Promise<ProjectImportRecoveryResult> {
  const root = requiredRoot(userDataRoot)
  const existing = projectImportRecoveryFlights.get(root)
  if (existing) return existing

  const flight = withAssignmentOwnerWriteAccess(root, async () => {
    const result = await recoverPendingProjectImportsInWriterSlot(root)
    if (result.failures.length > 0) throw new ProjectImportRecoveryPendingError(result.failures)
    return result
  })
  projectImportRecoveryFlights.set(root, flight)
  void flight.catch(() => {
    if (projectImportRecoveryFlights.get(root) === flight) projectImportRecoveryFlights.delete(root)
  })
  return flight
}

export async function importProjectAggregate(
  rawBundle: unknown,
  userDataRoot: string,
  options: ProjectImportOptions = {}
): Promise<ProjectImportResult> {
  return (await prepareProjectAggregateImport(rawBundle, userDataRoot)).execute(options)
}

export async function prepareProjectAggregateImport(
  rawBundle: unknown,
  userDataRoot: string
): Promise<PreparedProjectAggregateImport> {
  const root = requiredRoot(userDataRoot)
  const bundle = parseProjectAggregateImport(rawBundle)
  if (bundle.projectId === MANAGED_PERSONAL_WORKSPACE_ID) {
    throw new Error('Project import cannot use the managed personal Workspace identity')
  }
  await preflightProjectImport(root, bundle)
  return {
    bundle,
    execute: async (options: ProjectImportOptions = {}) => {
      const operationId = options.operationId === undefined
        ? randomUUID()
        : requiredId(options.operationId, 'operationId')
      const source = new ProjectImportSourceStore(root).write(operationId, bundle)
      const entry = await new ProjectImportJournal(root).begin({
        operationId,
        projectId: bundle.projectId,
        sourcePath: source.path,
        sourceDigest: source.sourceDigest,
        exportDigest: source.exportDigest,
        sourceAggregateDigest: bundle.aggregate.aggregateDigest,
        sourceSemanticDigest: projectImportSemanticDigest(bundle.aggregate)
      })
      return resumeProjectImport(root, entry, options)
    }
  }
}

export async function recoverPendingProjectImports(userDataRoot: string): Promise<ProjectImportRecoveryResult> {
  const root = requiredRoot(userDataRoot)
  return withAssignmentOwnerWriteAccess(root, () => recoverPendingProjectImportsInWriterSlot(root))
}

async function recoverPendingProjectImportsInWriterSlot(root: string): Promise<ProjectImportRecoveryResult> {
  const recovered: ProjectImportResult[] = []
  const failures: ProjectImportRecoveryFailure[] = []
  for (const entry of new ProjectImportJournal(root).listPending()) {
    try {
      recovered.push(await resumeProjectImport(root, entry))
    } catch (error) {
      failures.push({ operationId: entry.operationId, projectId: entry.projectId, error: errorText(error) })
    }
  }
  return { recovered, failures }
}

export async function verifyProjectImport(
  userDataRoot: string,
  operationId: string
): Promise<ProjectImportResult> {
  const root = requiredRoot(userDataRoot)
  const journal = new ProjectImportJournal(root)
  const entry = journal.getOperation(requiredId(operationId, 'operationId'))
  if (!entry || entry.phase !== 'completed') throw new Error(`Project import operation is not completed: ${operationId}`)
  const bundle = verifiedSourceBundle(root, entry)
  const service = createProductionProjectAggregateService(root)
  const aggregate = await service.queryProject(entry.projectId, {
    expectedAggregateRevision: entry.aggregateRevision,
    expectedAggregateDigest: entry.importedAggregateDigest
  })
  const semanticDigest = projectImportSemanticDigest(aggregate)
  if (semanticDigest !== entry.sourceSemanticDigest || semanticDigest !== entry.importedSemanticDigest) {
    throw new Error('Project import semantic readback changed after completion')
  }
  if (bundle.aggregate.aggregateDigest !== entry.sourceAggregateDigest) {
    throw new Error('Project import source aggregate receipt changed')
  }
  await verifyProjectRoutineSlice(resolve(root, 'routines'), entry.projectId, bundle.automation)
  await verifyProjectPortableRuntime(bundle, root)
  if (bundle.media !== undefined) {
    const media = await getMediaStore(root).exportProjectSlice(entry.projectId)
    if (media.mediaDigest !== bundle.media.mediaDigest) throw new Error('Project import Media readback changed after completion')
  }
  return resultFrom(entry, aggregate.objectCounts)
}

async function preflightProjectImport(root: string, bundle: ProjectAggregateExportBundle): Promise<void> {
  const aggregate = bundle.aggregate
  const workspaceState = await new ProjectWorkspaceStore(root).open().then((store) => store.getState())
  assertWorkspaceImportable(workspaceState, aggregate)
  assertWorkforceImportable(new DigitalWorkerStore(root), bundle)
  const learning = await readLearningState(resolve(root, 'learning'), projectLearningNamespace(aggregate.projectId))
  if (learning.records.length > 0 || learning.audit.length > 0) {
    throw new Error(`Project import Learning identity conflict: ${aggregate.projectId}`)
  }
  const service = createProductionProjectAggregateService(root)
  if (service.seals.readProject(aggregate.projectId)) {
    throw new Error(`Project import aggregate seal conflict: ${aggregate.projectId}`)
  }
  await verifyWorkflowProjectAggregateImportable(rebindProjectPortableArtifactSources(bundle, root), root)
  await assertProjectPortableRuntimeImportable(bundle, root)
  await assertProjectRoutineSliceImportable(resolve(root, 'routines'), aggregate.projectId, bundle.automation)
  const media = await getMediaStore(root).countProject(aggregate.projectId)
  if (media.productions > 0 || media.jobs > 0) throw new Error(`Project import Media identity conflict: ${aggregate.projectId}`)
}

async function resumeProjectImport(
  root: string,
  initial: ProjectImportJournalEntry,
  options: ProjectImportOptions = {}
): Promise<ProjectImportResult> {
  const journal = new ProjectImportJournal(root)
  let entry = initial
  const bundle = verifiedSourceBundle(root, entry)
  const aggregate = bundle.aggregate
  const destinationAggregate = rebindProjectPortableArtifactSources(bundle, root)
  const current = (): number => PROJECT_IMPORT_PHASES.indexOf(entry.phase)
  const advance = async (
    phase: ProjectImportPhase,
    patch?: Parameters<ProjectImportJournal['advance']>[2]
  ): Promise<void> => {
    entry = await journal.advance(entry.operationId, phase, patch)
    if (options.failAfterPhase === phase) throw new Error(`injected Project import failure after ${phase}`)
  }

  if (current() < phaseIndex('workspace_imported')) {
    await new ProjectWorkspaceStore(root).open().then((store) => store.importProjectSlice({
      workspace: aggregate.workspace,
      goals: aggregate.goals,
      workItems: aggregate.workItems,
      squads: aggregate.squads,
      members: aggregate.members,
      invitations: aggregate.invitations,
      comments: aggregate.comments,
      sharedApprovals: aggregate.sharedApprovals,
      inboxReceipts: aggregate.inboxReceipts ?? [],
      events: workspaceEvents(aggregate.audit, aggregate.projectId)
    }))
    injectBeforeJournal(options, 'workspace_imported')
    await advance('workspace_imported')
  }

  if (current() < phaseIndex('workforce_imported')) {
    await new DigitalWorkerStore(root).importProjectSlice({
      projectId: aggregate.projectId,
      roleTemplates: bundle.dependencies.roleTemplates,
      workers: aggregate.digitalWorkers,
      assignments: aggregate.assignments,
      leases: aggregate.leases,
      audit: workforceEvents(aggregate.audit, aggregate.projectId)
    })
    injectBeforeJournal(options, 'workforce_imported')
    await advance('workforce_imported')
  }

  if (current() < phaseIndex('workflow_imported')) {
    await importWorkflowProjectAggregate(destinationAggregate, root)
    injectBeforeJournal(options, 'workflow_imported')
    await advance('workflow_imported')
  }

  if (current() < phaseIndex('runtime_imported')) {
    await importProjectPortableRuntime(bundle, root)
    injectBeforeJournal(options, 'runtime_imported')
    await advance('runtime_imported')
  }

  if (current() < phaseIndex('automation_imported')) {
    await importProjectRoutineSlice(resolve(root, 'routines'), aggregate.projectId, bundle.automation)
    injectBeforeJournal(options, 'automation_imported')
    await advance('automation_imported')
  }

  if (bundle.portfolio !== undefined) {
    await getProjectPortfolioStore(root).importProjectSlice(bundle.portfolio)
  }
  if (bundle.media !== undefined) {
    await getMediaStore(root).importProjectSlice(bundle.media)
  }

  if (current() < phaseIndex('learning_imported')) {
    await importProjectLearning(root, aggregate)
    injectBeforeJournal(options, 'learning_imported')
    await advance('learning_imported')
  }

  if (current() < phaseIndex('sealed')) {
    const service = createProductionProjectAggregateService(root)
    const live = await service.verifyLiveProject(aggregate.projectId)
    const importedSemanticDigest = projectImportSemanticDigest(live)
    if (importedSemanticDigest !== entry.sourceSemanticDigest) {
      const mismatch = projectImportSemanticMismatchPath(aggregate, live)
      const auditSummary = `sourceAudit=${aggregate.audit.length},liveAudit=${live.audit.length}`
      throw new Error(`Project import readback is not semantically equivalent to its source${mismatch ? ` at ${mismatch}` : ''} (${auditSummary})`)
    }
    const existingSeal = service.seals.readProject(aggregate.projectId)
    const seal = existingSeal ?? await service.sealProject(aggregate.projectId, { expectedAggregateRevision: 0 })
    if (existingSeal) await service.verifyProject(aggregate.projectId, {
      expectedAggregateRevision: existingSeal.aggregateRevision,
      expectedAggregateDigest: existingSeal.aggregateDigest
    })
    await advance('sealed', {
      importedAggregateDigest: seal.aggregateDigest,
      importedSemanticDigest,
      aggregateRevision: seal.aggregateRevision
    })
  }

  if (current() < phaseIndex('completed')) await advance('completed')
  return verifyProjectImport(root, entry.operationId)
}

function verifiedSourceBundle(root: string, entry: ProjectImportJournalEntry): ProjectAggregateExportBundle {
  const sourceStore = new ProjectImportSourceStore(root)
  const receipt = sourceStore.verify(entry.sourcePath, entry.operationId, entry.projectId)
  if (receipt.sourceDigest !== entry.sourceDigest || receipt.exportDigest !== entry.exportDigest) {
    throw new Error('Project import source receipt changed')
  }
  return sourceStore.read(entry.sourcePath, entry.operationId, entry.projectId).bundle
}

async function importProjectLearning(
  root: string,
  aggregate: ProjectAggregateExportBundle['aggregate']
): Promise<void> {
  const learningRoot = resolve(root, 'learning')
  const namespace = projectLearningNamespace(aggregate.projectId)
  const project = projectLearningNamespaceDigest(aggregate.projectId)
  const records = aggregate.memory
    .map((entry) => ({ ...structuredClone(entry.record), project }))
    .sort((left, right) => left.id.localeCompare(right.id))
  const audit = learningEvents(aggregate.audit, aggregate.projectId)
  await mutateLearningState(learningRoot, namespace, (state) => {
    const existing = { records: [...state.records].sort((left, right) => left.id.localeCompare(right.id)), audit: state.audit }
    const incoming = { records, audit }
    if (state.records.length > 0 || state.audit.length > 0) {
      if (projectAggregateCanonicalJson(existing) === projectAggregateCanonicalJson(incoming)) return
      throw new Error(`Project import Learning identity conflict: ${aggregate.projectId}`)
    }
    state.records = records
    state.audit = audit
    delete state.materialization
  })
}

function assertWorkspaceImportable(state: ProjectWorkspaceState, aggregate: ProjectAggregateExportBundle['aggregate']): void {
  const conflicts = [
    ...state.workspaces.filter((item) => item.id === aggregate.projectId).map((item) => `project:${item.id}`),
    ...identityConflicts(state.goals, aggregate.goals).map((id) => `goal:${id}`),
    ...identityConflicts(state.workItems, aggregate.workItems).map((id) => `work_item:${id}`),
    ...identityConflicts(state.squads, aggregate.squads).map((id) => `squad:${id}`),
    ...identityConflicts(state.members, aggregate.members).map((id) => `member:${id}`),
    ...identityConflicts(state.invitations, aggregate.invitations).map((id) => `invitation:${id}`),
    ...identityConflicts(state.comments, aggregate.comments).map((id) => `comment:${id}`),
    ...identityConflicts(state.sharedApprovals, aggregate.sharedApprovals).map((id) => `shared_approval:${id}`),
    ...identityConflicts(state.inboxReceipts, aggregate.inboxReceipts ?? []).map((id) => `inbox_receipt:${id}`),
    ...identityConflicts(state.events, workspaceEvents(aggregate.audit, aggregate.projectId)).map((id) => `event:${id}`)
  ]
  if (conflicts.length > 0) throw new Error(`Project import Workspace identity conflict: ${conflicts.sort().join(', ')}`)
}

function assertWorkforceImportable(store: DigitalWorkerStore, bundle: ProjectAggregateExportBundle): void {
  const aggregate = bundle.aggregate
  const state = store.read()
  const conflicts = [
    ...identityConflicts(state.workers, aggregate.digitalWorkers).map((id) => `worker:${id}`),
    ...identityConflicts(state.assignments, aggregate.assignments).map((id) => `assignment:${id}`),
    ...identityConflicts(state.leases, aggregate.leases).map((id) => `lease:${id}`),
    ...identityConflicts(state.audit, workforceEvents(aggregate.audit, aggregate.projectId)).map((id) => `audit:${id}`)
  ]
  if (conflicts.length > 0) throw new Error(`Project import Workforce identity conflict: ${conflicts.sort().join(', ')}`)
  const dependencies = new Map(bundle.dependencies.roleTemplates.map((role) => [role.id, role]))
  for (const worker of aggregate.digitalWorkers) {
    const dependency = dependencies.get(worker.roleTemplateId)
    const installed = state.roleTemplates.find((role) => role.id === worker.roleTemplateId)
    if (!dependency) throw new Error(`Project import is missing RoleTemplate dependency: ${worker.roleTemplateId}`)
    if (installed && roleTemplateSemanticJson(installed) !== roleTemplateSemanticJson(dependency)) {
      throw new Error(`Project import RoleTemplate dependency conflicts with installed template: ${worker.roleTemplateId}`)
    }
  }
}

function roleTemplateSemanticJson(role: ProjectAggregateExportBundle['dependencies']['roleTemplates'][number]): string {
  const {
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    revision: _revision,
    source: _source,
    ...semantic
  } = role
  return projectAggregateCanonicalJson(semantic)
}

function workspaceEvents(audit: readonly ProjectAggregateAuditRecord[], projectId: string): ProjectWorkspaceEvent[] {
  return audit.filter((entry) => entry.source === 'project_workspace')
    .map((entry) => requireOwnedEvent<ProjectWorkspaceEvent>(entry.value, projectId, 'ProjectWorkspace'))
    .sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id))
}

function workforceEvents(audit: readonly ProjectAggregateAuditRecord[], projectId: string): DigitalWorkerAuditEvent[] {
  return audit.filter((entry) => entry.source === 'digital_worker')
    .map((entry) => requireOwnedEvent<DigitalWorkerAuditEvent>(entry.value, projectId, 'DigitalWorker'))
    .sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id))
}

function learningEvents(audit: readonly ProjectAggregateAuditRecord[], projectId: string) {
  return audit.filter((entry) => entry.source === 'learning').map((entry) => {
    if (!entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value)) {
      throw new Error('Project import contains an invalid Learning audit wrapper')
    }
    const wrapper = entry.value as Record<string, unknown>
    if (wrapper.projectId !== projectId ||
        !wrapper.event || typeof wrapper.event !== 'object' || Array.isArray(wrapper.event)) {
      throw new Error('Project import contains an invalid Learning audit wrapper')
    }
    return structuredClone(wrapper.event) as ReturnType<typeof readLearningState> extends Promise<infer T>
      ? T extends { audit: infer A } ? A extends Array<infer E> ? E : never : never
      : never
  }).sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.id.localeCompare(right.id))
}

function requireOwnedEvent<T extends { id: string; projectId?: string }>(
  value: unknown,
  projectId: string,
  label: string
): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Project import contains an invalid ${label} event`)
  const event = value as Record<string, unknown>
  if (typeof event.id !== 'string' || !event.id.trim() || event.projectId !== projectId) {
    throw new Error(`Project import contains an invalid ${label} event`)
  }
  return structuredClone(value) as T
}

function identityConflicts<T extends { id: string }>(existing: readonly T[], incoming: readonly T[]): string[] {
  const ids = new Set(existing.map((item) => item.id))
  return incoming.filter((item) => ids.has(item.id)).map((item) => item.id)
}

function resultFrom(
  entry: ProjectImportJournalEntry,
  objectCounts: ProjectAggregateExportBundle['aggregate']['objectCounts']
): ProjectImportResult {
  if (!entry.importedAggregateDigest || !entry.importedSemanticDigest || !entry.aggregateRevision) {
    throw new Error('Project import completion receipt is incomplete')
  }
  return {
    operationId: entry.operationId,
    projectId: entry.projectId,
    phase: 'completed',
    sourcePath: entry.sourcePath,
    sourceDigest: entry.sourceDigest,
    exportDigest: entry.exportDigest,
    sourceAggregateDigest: entry.sourceAggregateDigest,
    importedAggregateDigest: entry.importedAggregateDigest,
    semanticDigest: entry.importedSemanticDigest,
    aggregateRevision: entry.aggregateRevision,
    sourceEquivalent: true,
    objectCounts
  }
}

function phaseIndex(phase: ProjectImportPhase): number {
  return PROJECT_IMPORT_PHASES.indexOf(phase)
}

function injectBeforeJournal(options: ProjectImportOptions, phase: ProjectImportPhase): void {
  if (options.failBeforeJournalPhase === phase) {
    throw new Error(`injected Project import failure before journal ${phase}`)
  }
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('userDataRoot is required')
  return resolve(value)
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${label} is required`)
  return value.trim()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
