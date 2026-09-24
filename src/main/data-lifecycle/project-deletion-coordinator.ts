import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DataPurgeTarget, DataRetentionSubject } from '../../shared/data-lifecycle-types'
import type { HistoryEntry } from '../../shared/types'
import type { MutationOptions, ProjectDeletionResult } from '../../shared/project-workspace-types'
import { AssignmentOwnerJournal } from '../assignment-owner-coordinator/journal'
import { DigitalWorkerStore } from '../digital-worker/domain-store'
import { learningStatePath } from '../learning/learning-store'
import { createProductionProjectAggregateService } from '../project-aggregate/project-aggregate-factory'
import { projectLearningNamespace } from '../project-aggregate/project-memory-adapter'
import { openProjectWorkspaceStore } from '../project-workspace/store'
import { getProjectPortfolioStore } from '../project-portfolio/store'
import { SupervisorStateStore } from '../task/supervisor-state'
import { readTaskSnapshotDatabase } from '../task/task-snapshot'
import { findWorkflowLedgerAuthorizedPurge } from '../task/workflow-ledger-authorized-purge'
import { selectConversationLedgerProjectSessionInventory } from '../task/conversation-ledger-store'
import { projectAggregateCanonicalJson } from '../project-aggregate/codec'
import { ProjectDeletionBackupStore } from './project-deletion-backup-store'
import {
  PROJECT_DELETION_PHASES,
  ProjectDeletionJournal,
  type ProjectDeletionJournalEntry,
  type ProjectDeletionPhase
} from './project-deletion-journal'
import {
  assertProjectSessionPurgeable,
  collectProjectSessionInventory,
  purgeProjectSessionData,
  scanProjectSessionResiduals
} from './project-session-purge'
import {
  captureProjectExternalResourceBoundaries,
  ProjectDeletionProofStore,
  type ProjectDeletionProof
} from './project-deletion-proof-store'
import {
  planWorkflowProjectPurgeBlobs,
  purgeWorkflowProjectData,
  scanWorkflowProjectResiduals
} from './workflow-project-purge'
import { purgeProjectRoutineSlice, scanProjectRoutineResiduals } from '../routines/routine-project-store'
import { historyEntriesFromDocument } from '../history-store-format'
import {
  assertDataPurgeAllowed,
  isDataRetentionBlockedError
} from './retention-authority'
import { withDataLifecycleMutation } from './data-lifecycle-mutation-lock'
import { prepareProjectMemoryRetentionExport } from '../memory/memory-retention'
import { getMediaStore } from '../media/media-store'
import {
  countMediaProjectFiles,
  purgeLegacyMediaProviderOutputFiles,
  purgeMediaProjectFiles
} from '../media/media-files'
import {
  countProjectConnectorCacheResiduals,
  purgeProjectConnectorCaches
} from '../project-workspace/project-connector-cache'
import { countProjectLayeredMemory, purgeProjectLayeredMemory } from './layered-memory-portability'

export interface ProjectDeletionCoordinatorOptions {
  /** Stable caller-owned operation ID for Effect reconciliation; direct callers omit it. */
  operationId?: string
  afterPhase?: (phase: ProjectDeletionPhase, entry: ProjectDeletionJournalEntry) => void | Promise<void>
}

type DeletionReceiptPatch = Partial<Pick<ProjectDeletionJournalEntry,
  'backupPath' | 'backupDigest' | 'exportDigest' | 'proofPath' | 'proofDigest'>>

interface DeletionProgress {
  current: () => number
  entry: () => ProjectDeletionJournalEntry
  advance: (phase: ProjectDeletionPhase, patch?: DeletionReceiptPatch) => Promise<void>
}

export async function purgeProjectPermanently(
  projectId: string,
  userDataRoot: string,
  mutationOptions: MutationOptions = {},
  options: ProjectDeletionCoordinatorOptions = {}
): Promise<ProjectDeletionResult> {
  const root = requiredRoot(userDataRoot)
  const id = requiredId(projectId, 'projectId')
  const journal = new ProjectDeletionJournal(root)
  let entry = journal.getPendingProject(id)
  if (!entry) entry = await prepareDeletion(id, root, mutationOptions, journal, options.operationId)
  return executeDeletion(root, entry, journal, options)
}

export async function resumeProjectDeletions(
  userDataRoot: string,
  options: ProjectDeletionCoordinatorOptions = {}
): Promise<ProjectDeletionResult[]> {
  const root = requiredRoot(userDataRoot)
  const journal = new ProjectDeletionJournal(root)
  const results: ProjectDeletionResult[] = []
  for (const entry of journal.listPending()) {
    try {
      results.push(await executeDeletion(root, entry, journal, options))
    } catch (error) {
      if (!isDataRetentionBlockedError(error)) throw error
      console.info(`[caogen] Project deletion remains pending under retention authority: ${entry.projectId}`)
    }
  }
  return results
}

export function assertProjectDeletionResumeAllowed(
  userDataRoot: string,
  entry: ProjectDeletionJournalEntry
): void {
  assertDeletionAllowed(requiredRoot(userDataRoot), entry)
}

async function prepareDeletion(
  projectId: string,
  root: string,
  mutationOptions: MutationOptions,
  journal: ProjectDeletionJournal,
  operationId?: string
): Promise<ProjectDeletionJournalEntry> {
  const workspaceStore = await openProjectWorkspaceStore(root)
  const workspace = await workspaceStore.getWorkspace(projectId)
  if (!workspace) throw new Error(`Project not found: ${projectId}`)
  if (workspace.status !== 'deleted') {
    throw new Error(`Project ${projectId} must be moved to deleted state before permanent deletion`)
  }
  if (mutationOptions.expectedRevision !== undefined && mutationOptions.expectedRevision !== workspace.revision) {
    throw new Error(`stale_revision: Project ${projectId} is at ${workspace.revision}`)
  }
  const projectRetentionTarget: DataPurgeTarget = {
    subject: { kind: 'project', id: projectId },
    retentionAnchorAt: requiredTimestamp(workspace.deletedAt ?? workspace.updatedAt, 'Project retention anchor')
  }
  await prepareProjectMemoryRetentionExport(root, projectId)
  const service = createProductionProjectAggregateService(root)
  const currentSeal = service.seals.readProject(projectId)
  const seal = await service.sealProject(projectId, {
    expectedAggregateRevision: currentSeal?.aggregateRevision ?? 0
  })
  const aggregate = await service.exportProject(projectId, {
    expectedAggregateRevision: seal.aggregateRevision,
    expectedAggregateDigest: seal.aggregateDigest
  })
  const workflowSessionIds = aggregate.bundle.aggregate.workflow.runs.map((run) => run.sessionId)
  const portableSessionIds = aggregate.bundle.runtime?.sessionIds ?? []
  const routineSessionIds = (aggregate.bundle.automation?.runs ?? [])
    .map((run) => run.sessionId)
    .filter((sessionId): sessionId is string => Boolean(sessionId))
  const conversationInventory = await readTaskSnapshotDatabase(root, (db) =>
    selectConversationLedgerProjectSessionInventory(db, projectId))
  const inventory = collectProjectSessionInventory(
    root,
    projectId,
    [...workflowSessionIds, ...portableSessionIds, ...routineSessionIds, ...conversationInventory.sessionIds],
    conversationInventory.sdkSessionIds
  )
  assertProjectSessionPurgeable(root, inventory.sessionIds)
  const retention = projectDeletionRetentionScope(root, projectRetentionTarget, inventory.sessionIds)
  const artifactBlobDigests = await planWorkflowProjectPurgeBlobs(projectId, root)
  const effectArtifactRefs = aggregate.bundle.runtime?.effectArtifacts?.map((record) => record.artifactRef) ?? []
  return withDataLifecycleMutation(root, async () => {
    const entry = await journal.begin({
      ...(operationId === undefined ? {} : { operationId }),
      projectId,
      expectedWorkspaceRevision: workspace.revision,
      sessionIds: inventory.sessionIds,
      sdkSessionIds: inventory.sdkSessionIds,
      artifactBlobDigests,
      retentionTargets: retention.targets,
      legalHoldSubjects: retention.relatedLegalHoldSubjects,
      effectArtifactRefs,
      externalResources: captureProjectExternalResourceBoundaries(aggregate.bundle.aggregate.resources)
    })
    assertDeletionAllowed(root, entry)
    return entry
  })
}

async function executeDeletion(
  root: string,
  initial: ProjectDeletionJournalEntry,
  journal: ProjectDeletionJournal,
  options: ProjectDeletionCoordinatorOptions
): Promise<ProjectDeletionResult> {
  return withDataLifecycleMutation(root, () => executeDeletionLocked(root, initial, journal, options))
}

async function executeDeletionLocked(
  root: string,
  initial: ProjectDeletionJournalEntry,
  journal: ProjectDeletionJournal,
  options: ProjectDeletionCoordinatorOptions
): Promise<ProjectDeletionResult> {
  let entry = initial
  assertProjectSessionPurgeable(root, entry.sessionIds)
  const current = (): number => PROJECT_DELETION_PHASES.indexOf(entry.phase)
  const advance = async (
    phase: ProjectDeletionPhase,
    patch: DeletionReceiptPatch = {}
  ): Promise<void> => {
    entry = await journal.advance(entry.operationId, phase, patch)
    await options.afterPhase?.(phase, entry)
  }
  const progress: DeletionProgress = { current, entry: () => entry, advance }

  if (current() < phaseIndex('backup_written')) {
    const aggregate = await verifiedAggregateExport(root, entry.projectId)
    const receipt = new ProjectDeletionBackupStore(root).write(entry.operationId, entry.projectId, aggregate)
    await advance('backup_written', {
      backupPath: receipt.path,
      backupDigest: receipt.backupDigest,
      exportDigest: receipt.exportDigest
    })
  } else {
    requireBackupReceipt(root, entry)
  }

  if (current() < phaseIndex('workflow_purged')) {
    assertDeletionAllowed(root, entry)
    await purgeWorkflowProjectData(
      entry.projectId,
      root,
      entry.operationId,
      entry.sessionIds,
      entry.artifactBlobDigests,
      entry.effectArtifactRefs ?? []
    )
    await advance('workflow_purged')
  }

  if (current() < phaseIndex('project_stores_purged')) {
    assertDeletionAllowed(root, entry)
    await new DigitalWorkerStore(root).purgeProject(entry.projectId)
    await new AssignmentOwnerJournal(root).purgeProject(entry.projectId)
    await new SupervisorStateStore(root).purgeProject(entry.projectId)
    await getProjectPortfolioStore(root).purgeProject(entry.projectId)
    await purgeProjectConnectorCaches(root, entry.projectId)
    const mediaStore = getMediaStore(root)
    const legacyRemoteOutputs = await mediaStore.listUnsharedLegacyRemoteOutputPaths(entry.projectId)
    await purgeLegacyMediaProviderOutputFiles(root, legacyRemoteOutputs)
    await purgeMediaProjectFiles(root, entry.projectId)
    await mediaStore.purgeProject(entry.projectId)
    createProductionProjectAggregateService(root).seals.purgeProject(entry.projectId)
    await advance('project_stores_purged')
  }

  if (current() < phaseIndex('automation_purged')) {
    assertDeletionAllowed(root, entry)
    await purgeProjectRoutineSlice(join(root, 'routines'), entry.projectId)
    await advance('automation_purged')
  } else {
    const residual = await scanProjectRoutineResiduals(join(root, 'routines'), entry.projectId)
    if (residual.routines > 0 || residual.runs > 0) {
      assertDeletionAllowed(root, entry)
      await purgeProjectRoutineSlice(join(root, 'routines'), entry.projectId)
    }
  }

  const sessionDataPending = current() < phaseIndex('session_data_purged')
  if (current() < phaseIndex('workspace_purged')) {
    assertDeletionAllowed(root, entry)
    purgeProjectSessionData(root, entry.projectId, entry.sessionIds, entry.sdkSessionIds)
  }
  if (sessionDataPending) await advance('session_data_purged')

  if (current() < phaseIndex('learning_purged')) {
    assertDeletionAllowed(root, entry)
    purgeCanonicalLearning(root, entry.projectId)
    await purgeProjectLayeredMemory(root, entry.projectId)
    await advance('learning_purged')
  } else if (await countProjectLayeredMemory(root, entry.projectId)) {
    // Resume journals written by versions that did not include the layered store.
    assertDeletionAllowed(root, entry)
    await purgeProjectLayeredMemory(root, entry.projectId)
  }

  await purgeWorkspacePhase(root, progress)
  const residuals = await verifyAndWriteProof(root, progress)

  if (current() < phaseIndex('completed')) await advance('completed')
  const proof = await verifyProjectDeletionProof(root, entry.operationId)
  return {
    operationId: entry.operationId,
    projectId: entry.projectId,
    phase: 'completed',
    backupPath: entry.backupPath as string,
    backupDigest: entry.backupDigest as string,
    exportDigest: entry.exportDigest as string,
    proofPath: proof.proofPath,
    proofDigest: proof.proofDigest,
    sessionIds: [...entry.sessionIds],
    sdkSessionIds: [...entry.sdkSessionIds],
    residuals
  }
}

async function purgeWorkspacePhase(root: string, progress: DeletionProgress): Promise<void> {
  if (progress.current() >= phaseIndex('workspace_purged')) return
  const entry = progress.entry()
  assertDeletionAllowed(root, entry)
  const workspaceStore = await openProjectWorkspaceStore(root)
  const workspace = await workspaceStore.getWorkspace(entry.projectId)
  if (workspace) {
    if (workspace.status !== 'deleted') throw new Error(`Project ${entry.projectId} is no longer deleted`)
    if (workspace.revision !== entry.expectedWorkspaceRevision) {
      throw new Error(`stale_revision: Project ${entry.projectId} changed during permanent deletion`)
    }
    await workspaceStore.purgeWorkspace(entry.projectId, { expectedRevision: entry.expectedWorkspaceRevision })
  }
  await progress.advance('workspace_purged')
}

function projectDeletionRetentionScope(
  root: string,
  projectTarget: DataPurgeTarget,
  sessionIds: readonly string[]
): { targets: DataPurgeTarget[]; relatedLegalHoldSubjects: DataRetentionSubject[] } {
  const sessionIdSet = new Set(sessionIds)
  const historyById = new Map(readHistoryAtRoot(root)
    .filter((entry) => sessionIdSet.has(entry.id))
    .map((entry) => [entry.id, entry] as const))
  const sessionTargets = [...sessionIdSet].sort().flatMap((sessionId): DataPurgeTarget[] => {
    const history = historyById.get(sessionId)
    return history ? [{
      subject: { kind: 'session', id: sessionId },
      retentionAnchorAt: requiredTimestamp(history.updatedAt, 'Session retention anchor')
    }] : []
  })
  return {
    targets: [projectTarget, ...sessionTargets],
    relatedLegalHoldSubjects: [
      projectTarget.subject,
      ...[...sessionIdSet].sort().map((id) => ({ kind: 'session' as const, id }))
    ]
  }
}

function readHistoryAtRoot(root: string): HistoryEntry[] {
  const file = join(root, 'sessions.json')
  if (!existsSync(file)) return []
  return historyEntriesFromDocument<HistoryEntry>(JSON.parse(readFileSync(file, 'utf8')), 'Project retention History Store')
}

function assertDeletionAllowed(root: string, entry: ProjectDeletionJournalEntry): void {
  assertDataPurgeAllowed(root, {
    targets: entry.retentionTargets ?? [{
      subject: { kind: 'project', id: entry.projectId },
      retentionAnchorAt: entry.createdAt
    }],
    relatedLegalHoldSubjects: entry.legalHoldSubjects ?? [
      { kind: 'project', id: entry.projectId },
      ...entry.sessionIds.map((id) => ({ kind: 'session' as const, id }))
    ]
  })
}

async function verifyAndWriteProof(
  root: string,
  progress: DeletionProgress
): Promise<Record<string, number>> {
  let entry = progress.entry()
  const residuals = await scanProjectDeletionResiduals(root, entry)
  if (progress.current() < phaseIndex('verified')) {
    assertNoResiduals(residuals)
    await progress.advance('verified')
    entry = progress.entry()
  }
  if (progress.current() < phaseIndex('proof_written')) {
    const proof = await writeDeletionProof(root, entry, residuals)
    await progress.advance('proof_written', { proofPath: proof.path, proofDigest: proof.proofDigest })
  } else {
    requireProofReceipt(root, entry)
  }
  return residuals
}

function assertNoResiduals(residuals: Readonly<Record<string, number>>): void {
  const total = Object.values(residuals).reduce((sum, value) => sum + value, 0)
  if (total !== 0) throw new Error(`Project deletion left ${total} residual records: ${JSON.stringify(residuals)}`)
}

async function writeDeletionProof(
  root: string,
  entry: ProjectDeletionJournalEntry,
  residuals: Readonly<Record<string, number>>
) {
  requireBackupReceipt(root, entry)
  const backup = new ProjectDeletionBackupStore(root).read(
    entry.backupPath as string,
    entry.operationId,
    entry.projectId
  )
  const authorization = await readTaskSnapshotDatabase(root, (db) =>
    findWorkflowLedgerAuthorizedPurge(db, entry.operationId))
  if (!authorization) throw new Error('project deletion authorized purge record is missing')
  return new ProjectDeletionProofStore(root).write({
    operationId: entry.operationId,
    projectId: entry.projectId,
    expectedWorkspaceRevision: entry.expectedWorkspaceRevision,
    backupPath: entry.backupPath as string,
    backupDigest: entry.backupDigest as string,
    exportDigest: entry.exportDigest as string,
    sessionIds: entry.sessionIds,
    sdkSessionIds: entry.sdkSessionIds,
    artifactBlobDigests: entry.artifactBlobDigests,
    effectArtifactRefs: entry.effectArtifactRefs ?? [],
    authorizedPurge: authorization,
    residuals,
    externalResourcesBefore: entry.externalResources ??
      captureProjectExternalResourceBoundaries(backup.aggregateExport.aggregate.resources)
  })
}

export async function verifyProjectDeletionProof(
  userDataRoot: string,
  operationId: string
): Promise<{ proofPath: string; proofDigest: string; proof: ProjectDeletionProof; verifiedAt: number }> {
  const root = requiredRoot(userDataRoot)
  const operation = requiredId(operationId, 'operationId')
  const entry = new ProjectDeletionJournal(root).getOperation(operation)
  if (!entry) throw new Error(`project deletion operation not found: ${operation}`)
  if (entry.phase !== 'completed' || !entry.completedAt) {
    throw new Error(`project deletion operation ${operation} is not completed`)
  }
  if (!entry.proofPath || !entry.proofDigest) throw new Error('project deletion journal is missing its proof receipt')
  requireBackupReceipt(root, entry)
  const proof = new ProjectDeletionProofStore(root).read(entry.proofPath, operation, entry.projectId)
  if (proof.proofDigest !== entry.proofDigest) throw new Error('project deletion proof receipt changed')
  const authorization = await readTaskSnapshotDatabase(root, (db) =>
    findWorkflowLedgerAuthorizedPurge(db, operation))
  if (!authorization || authorization.projectId !== entry.projectId ||
      authorization.seq !== proof.authorizedPurge.seq || authorization.digest !== proof.authorizedPurge.recordDigest ||
      projectAggregateCanonicalJson(authorization.removed) !== projectAggregateCanonicalJson(proof.authorizedPurge.removed)) {
    throw new Error('project deletion proof no longer matches its authorized purge record')
  }
  const residuals = await scanProjectDeletionResiduals(root, entry)
  if (projectAggregateCanonicalJson(residuals) !== projectAggregateCanonicalJson(proof.residuals)) {
    throw new Error('project deletion proof no longer matches the live residual scan')
  }
  const total = Object.values(residuals).reduce((sum, value) => sum + value, 0)
  if (total !== 0) throw new Error(`project deletion proof verification found ${total} residual records`)
  return {
    proofPath: entry.proofPath,
    proofDigest: entry.proofDigest,
    proof,
    verifiedAt: Date.now()
  }
}

async function verifiedAggregateExport(root: string, projectId: string) {
  await prepareProjectMemoryRetentionExport(root, projectId)
  const service = createProductionProjectAggregateService(root)
  const currentSeal = service.seals.readProject(projectId)
  const seal = await service.sealProject(projectId, {
    expectedAggregateRevision: currentSeal?.aggregateRevision ?? 0
  })
  return service.exportProject(projectId, {
    expectedAggregateRevision: seal.aggregateRevision,
    expectedAggregateDigest: seal.aggregateDigest
  })
}

async function scanProjectDeletionResiduals(
  root: string,
  entry: ProjectDeletionJournalEntry
): Promise<Record<string, number>> {
  const workflow = await scanWorkflowProjectResiduals(
    entry.projectId,
    root,
    entry.sessionIds,
    entry.effectArtifactRefs ?? []
  )
  const workers = new DigitalWorkerStore(root).read()
  const assignmentJournal = await new AssignmentOwnerJournal(root).countProject(entry.projectId)
  const supervisor = await new SupervisorStateStore(root).listRuns({ projectId: entry.projectId })
  const sessions = scanProjectSessionResiduals(root, entry.projectId, entry.sessionIds, entry.sdkSessionIds)
  const automation = await scanProjectRoutineResiduals(join(root, 'routines'), entry.projectId)
  const workspaceStore = await openProjectWorkspaceStore(root)
  const [workspace, workspaceState] = await Promise.all([
    workspaceStore.getWorkspace(entry.projectId),
    workspaceStore.getState()
  ])
  const portfolio = await getProjectPortfolioStore(root).countProject(entry.projectId)
  const media = await getMediaStore(root).countProject(entry.projectId)
  const mediaFiles = await countMediaProjectFiles(root, entry.projectId)
  const connectorCache = await countProjectConnectorCacheResiduals(root, entry.projectId)
  const artifactSourceFiles = workflow.counts.artifact_source_files ?? 0
  const effectArtifacts = workflow.counts.effect_artifacts ?? 0
  return {
    workflow: workflow.total - artifactSourceFiles - effectArtifacts,
    artifactSourceFiles,
    effectArtifacts,
    digitalWorkers: workers.workers.filter((record) => record.projectId === entry.projectId).length,
    assignments: workers.assignments.filter((record) => record.projectId === entry.projectId).length,
    leases: workers.leases.filter((record) => record.projectId === entry.projectId).length,
    workerAudit: workers.audit.filter((record) => record.projectId === entry.projectId).length,
    assignmentJournal: assignmentJournal.entries + assignmentJournal.audit,
    supervisor: supervisor.length,
    aggregateSeal: createProductionProjectAggregateService(root).seals.readProject(entry.projectId) ? 1 : 0,
    learning: existsSync(canonicalLearningPath(root, entry.projectId)) ? 1 : 0,
    layeredMemory: await countProjectLayeredMemory(root, entry.projectId),
    routines: automation.routines,
    routineRuns: automation.runs,
    workspace: workspace ? 1 : 0,
    squads: workspaceState.squads.filter((record) => record.projectId === entry.projectId).length,
    members: workspaceState.members.filter((record) => record.projectId === entry.projectId).length,
    invitations: workspaceState.invitations.filter((record) => record.projectId === entry.projectId).length,
    comments: workspaceState.comments.filter((record) => record.projectId === entry.projectId).length,
    sharedApprovals: workspaceState.sharedApprovals.filter((record) => record.projectId === entry.projectId).length,
    inboxReceipts: workspaceState.inboxReceipts.filter((record) => record.projectId === entry.projectId).length,
    portfolioDependencies: portfolio.dependencies,
    portfolioMilestones: portfolio.milestones,
    mediaProductions: media.productions,
    mediaJobs: media.jobs,
    mediaFiles,
    connectorCache,
    ...Object.fromEntries(Object.entries(sessions).map(([key, value]) => [`sessions.${key}`, value]))
  }
}

function purgeCanonicalLearning(root: string, projectId: string): void {
  const target = canonicalLearningPath(root, projectId)
  if (!existsSync(target)) return
  const stat = lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('canonical Project Learning state is not a regular file')
  rmSync(target, { force: true })
}

function canonicalLearningPath(root: string, projectId: string): string {
  return learningStatePath(join(root, 'learning'), projectLearningNamespace(projectId))
}

function requireBackupReceipt(root: string, entry: ProjectDeletionJournalEntry): void {
  if (!entry.backupPath || !entry.backupDigest || !entry.exportDigest) {
    throw new Error('project deletion journal is missing its verified backup receipt')
  }
  const receipt = new ProjectDeletionBackupStore(root).verify(entry.backupPath, entry.operationId, entry.projectId)
  if (receipt.backupDigest !== entry.backupDigest || receipt.exportDigest !== entry.exportDigest) {
    throw new Error('project deletion backup receipt changed')
  }
}

function requireProofReceipt(root: string, entry: ProjectDeletionJournalEntry): void {
  if (!entry.proofPath || !entry.proofDigest) {
    throw new Error('project deletion journal is missing its proof receipt')
  }
  const receipt = new ProjectDeletionProofStore(root).verify(entry.proofPath, entry.operationId, entry.projectId)
  if (receipt.proofDigest !== entry.proofDigest) throw new Error('project deletion proof receipt changed')
}

function phaseIndex(phase: ProjectDeletionPhase): number {
  return PROJECT_DELETION_PHASES.indexOf(phase)
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('userDataRoot is required')
  return resolve(value)
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${label} is required`)
  return value.trim()
}

function requiredTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} is invalid`)
  return Number(value)
}
