import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HistoryEntry, SessionMeta } from '../../shared/types'
import type { ProjectWorkspaceState } from '../../shared/project-workspace-types'
import { MANAGED_PERSONAL_WORKSPACE_ID } from '../../shared/project-workspace-types'
import { historyEntriesFromDocument, historyStoreDocument } from '../history-store-format'
import { activeSessionRecordsFromDocument, activeSessionRegistryDocument } from '../active-session-registry-format'
import { sessionCreationJournalDocument, sessionCreationJournalRecordsFromDocument } from '../session-creation-journal-format'
import { readProjectWorkspaceState, projectWorkspaceFile, ProjectWorkspacePersistence } from '../project-workspace/persistence'
import { canonicalJson, digest } from '../task/workflow-ledger-codec'
import { assertNoCredentialMaterial } from '../project-aggregate/codec'
import { writeDurableFileSync } from '../durable-file'
import { mutateTaskSnapshotDatabase, readTaskSnapshotDatabase } from '../task/task-snapshot'
import { captureHandoffLedger, importHandoffLedger, ledgerBaselines, placedSnapshot, type Baselines, type HandoffLedger, type MergeGuard } from './task-bundle-ledger'
import { listMemoryEntriesForLifecycle, mutateMemoryEntries, type LayeredMemoryEntry } from '../memory/memory-manager'
import { listRoutines, getRoutineStorePath, type Routine } from '../routineStore'
import { pauseSessionContinuations } from '../routines/pause-session-continuations'
import { codeForgeVerificationDirectory } from '../code-forge/verification-evidence'
import { runtimeContinuationReceiptPath } from '../session-runtime-continuation-path'
import { preparationSessionKey } from '../data-lifecycle/preparation-data-files'
import { listProjectSubmissionReceiptFiles } from '../data-lifecycle/submission-receipt-files'
import { artifactBlobPath } from '../task/artifact-lifecycle-content'
import { TaskHostOwnershipStore } from './ownership-store'
import { appendWorkflowEvent } from '../task/workflow-ledger-store'
import { recordWorkflowArtifactLocation } from '../task/workflow-ledger-artifact-graph'
import { buildProjectWorkspaceProjection } from '../project-workspace/ledger-migration-source'
import { ensureProjectWorkspaceLedgerProjectionForScopedRead } from '../project-workspace/ledger-migration'
import { messagePayloadDigest } from '../message-payload-digest'
import type { SendMessagePayload } from '../../shared/types'
import { PreparationPermissionStore } from '../permission/preparation-permission-store'
import { TaskExecutionAuthorityStore } from '../permission/task-execution-authority-store'
import { assertTaskExecutionAuthorityMarkersPortable } from '../data-lifecycle/task-execution-authority-portability'

type RecordValue = Record<string, unknown>
interface HandoffFile { path: string; data: string; digest: string; sizeBytes: number }
interface ArtifactPlacement { artifactId: string; sourcePath: string; path: string }
interface BundleState { schemaVersion: 1; sessionCreatedAt: number; baselines: Baselines; bundleDigests: string[] }
type ProjectSlice = Pick<ProjectWorkspaceState, 'workspaces' | 'goals' | 'workItems' | 'comments' | 'sharedApprovals' | 'events'>

export interface TaskHandoffBundle {
  schemaVersion: 1
  identity: { sessionId: string; sessionCreatedAt: number }
  projectId: string
  title: string
  cwd: string
  meta: RecordValue
  provenance: { sourceHostId: string; capturedAt: number; previousBundleDigests: string[]; scope: 'single_task'; sourceUserData: string }
  history: HistoryEntry
  active: RecordValue[]
  creation: RecordValue[]
  taskPlan?: RecordValue
  ledger: HandoffLedger
  project: ProjectSlice
  files: HandoffFile[]
  artifactPlacements: ArtifactPlacement[]
  memory: LayeredMemoryEntry[]
  routines: Routine[]
  requiredResources: string[]
  digest: string
}
const MAX_BYTES = 256 * 1024 * 1024
const MAX_FILES = 20_000

export async function captureTaskHandoffBundle(rootDir: string, sessionId: string): Promise<TaskHandoffBundle> {
  return captureBundle(rootDir, sessionId, true)
}

export async function assertTaskHandoffSourceCurrent(rootDir: string, bundle: TaskHandoffBundle): Promise<void> {
  validateTaskHandoffBundle(bundle)
  const current = await captureBundle(rootDir, bundle.identity.sessionId, false)
  const content = ({ provenance: _provenance, digest: _digest, ...value }: TaskHandoffBundle): unknown => value
  if (digest(content(current)) !== digest(content(bundle))) throw new Error('任务数据已在交接预览后变化，请重新冻结并预览')
}

async function captureBundle(rootDir: string, sessionId: string, remember: boolean): Promise<TaskHandoffBundle> {
  const root = resolve(rootDir)
  safeId(sessionId)
  const history = histories(root).find(item => item.id === sessionId)
  if (!history) throw new Error('交接任务缺少持久历史记录')
  if (!Number.isFinite(history.createdAt) || history.createdAt <= 0 || !isAbsolute(history.cwd)) throw new Error('交接任务原身份或目录无效')
  const active = activeRecords(root).filter(item => item.id === sessionId)
  const meta = active[0] ?? history as unknown as RecordValue
  const ledger = await captureHandoffLedger(root, sessionId, history.workItemId)
  const projectId = history.workspaceId ?? history.personalWorkspaceId ?? history.projectId ?? ''
  if (!projectId) throw new Error('交接任务缺少 canonical 工作区身份')
  const state = await readProjectWorkspaceState(projectWorkspaceFile(root))
  const project = selectProject(state, ledger, projectId, sessionId, history)
  const creation = creationRecords(root).filter(item => (item.sessionId ?? item.id) === sessionId)
  assertTaskExecutionAuthorityMarkersPortable(root, [sessionId], [history, ...active, ...creation, ...ledger.snapshots])
  const taskPlan = plans(root).sessions?.[sessionId] as RecordValue | undefined
  const files = captureFiles(root, sessionId, history, ledger)
  const artifactPlacements = captureArtifacts(root, ledger, files)
  const memory = (await listMemoryEntriesForLifecycle(join(root, 'memory'))).filter(item =>
    item.layer !== 'user' && (item.sessionId === sessionId || Boolean(history.workItemId && item.workItemId === history.workItemId)))
  const routines = (await listRoutines(join(root, 'routines'))).filter(item => item.executionTarget?.sessionId === sessionId)
  const prior = readBundleState(root, sessionId)
  const body: Omit<TaskHandoffBundle, 'digest'> = {
    schemaVersion: 1, identity: { sessionId, sessionCreatedAt: history.createdAt }, projectId,
    title: history.title, cwd: history.cwd, meta,
    provenance: { sourceHostId: new TaskHostOwnershipStore(root).hostIdentity().hostId, capturedAt: Date.now(),
      previousBundleDigests: prior?.bundleDigests ?? [], scope: 'single_task', sourceUserData: root },
    history, active, creation, taskPlan, ledger, project, files, artifactPlacements, memory, routines,
    requiredResources: requiredResources(history, project)
  }
  const bundle = { ...body, digest: digest(body) }
  validateTaskHandoffBundle(bundle)
  // The outgoing baseline is retained locally for a later B -> A comparison.
  if (remember) {
    const baselines = await captureBaselines(root, bundle)
    persistState(root, bundle, baselines)
    archiveSource(root, bundle)
  }
  return bundle
}

export function validateTaskHandoffBundle(bundle: TaskHandoffBundle): void {
  if (!bundle || bundle.schemaVersion !== 1 || !bundle.identity || bundle.provenance?.scope !== 'single_task') throw new Error('交接资料包版本无效')
  safeId(bundle.identity.sessionId)
  if (!Number.isFinite(bundle.identity.sessionCreatedAt) || bundle.identity.sessionCreatedAt <= 0 ||
    bundle.history?.id !== bundle.identity.sessionId || bundle.history.createdAt !== bundle.identity.sessionCreatedAt ||
    !isAbsolute(bundle.cwd) || !bundle.projectId || !Array.isArray(bundle.files)) throw new Error('交接资料包身份无效')
  const { digest: expected, ...body } = bundle
  if (digest(body) !== expected) throw new Error('交接资料包摘要不匹配')
  if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_BYTES) throw new Error('任务资料包超过 256 MiB 上限')
  // Reject secret-bearing original records rather than silently altering evidence.
  assertNoCredentialMaterial({ history: bundle.history, active: bundle.active, creation: bundle.creation, taskPlan: bundle.taskPlan,
    ledger: bundle.ledger, project: bundle.project, memory: bundle.memory, routines: bundle.routines })
  const sessionId = bundle.identity.sessionId
  if (bundle.active.some(item => item.id !== sessionId) || bundle.creation.some(item => (item.sessionId ?? item.id) !== sessionId) ||
    bundle.ledger.runs.some(item => item.sessionId !== sessionId || item.taskRun.sessionId !== sessionId) ||
    bundle.ledger.snapshots.some(item => item.sessionId !== sessionId || item.meta.id !== sessionId) ||
    bundle.routines.some(item => item.executionTarget?.sessionId !== sessionId) ||
    bundle.memory.some(item => item.layer === 'user' || (item.sessionId !== sessionId && item.workItemId !== bundle.history.workItemId))) throw new Error('交接资料包越过原任务范围')
  const ids = new Set<string>(), sdkIds = sdkSessionIds(bundle.history, bundle.ledger)
  let total = 0
  if (bundle.files.length > MAX_FILES) throw new Error('任务资料包文件数量超过上限')
  for (const file of bundle.files) {
    safeRelative(file.path)
    if (!allowedFile(file.path, sessionId, sdkIds, bundle.ledger) || ids.has(file.path.toLowerCase())) throw new Error(`任务资料路径无效或大小写冲突: ${file.path}`)
    ids.add(file.path.toLowerCase())
    const bytes = Buffer.from(file.data, 'base64')
    if (bytes.toString('base64') !== file.data || bytes.length !== file.sizeBytes || hash(bytes) !== file.digest) throw new Error(`任务资料文件摘要错误: ${file.path}`)
    total += bytes.length
    if (total > MAX_BYTES) throw new Error('任务资料文件超过上限')
    inspectFileSecrets(file.path, bytes)
    if (file.path.startsWith('private/project-goal-submissions/') || file.path.startsWith('private/session-inputs/')) {
      const receipt = JSON.parse(bytes.toString('utf8')) as RecordValue
      if (receipt.sessionId !== sessionId) throw new Error('提交回执包含其他任务身份')
    }
  }
  const workItems = new Set(bundle.ledger.workItems.map(item => item.id))
  if (bundle.project.workspaces.length !== 1 || bundle.project.workspaces[0].id !== bundle.projectId ||
    bundle.project.workItems.some(item => item.projectId !== bundle.projectId || !workItems.has(item.id))) throw new Error('工作区任务切片越界')
  for (const item of bundle.artifactPlacements) if (!bundle.ledger.artifacts.some(artifact => artifact.id === item.artifactId) || !ids.has(item.path.toLowerCase())) throw new Error('成果字节缺失')
  const goalIds = new Set(bundle.project.goals.map(item => item.id))
  if (bundle.project.goals.some(item => item.projectId !== bundle.projectId) ||
    bundle.project.comments.some(item => !workItems.has(item.workItemId)) || bundle.project.sharedApprovals.some(item => !workItems.has(item.workItemId)) ||
    bundle.project.events.some(item => item.projectId !== bundle.projectId || (!workItems.has(item.entityId) && !goalIds.has(item.entityId) && item.entityId !== bundle.projectId))) throw new Error('项目附属记录超出单任务闭包')
}

export async function previewTaskHandoffImport(rootDir: string, bundle: TaskHandoffBundle, targetCwd: string): Promise<{ canImport: boolean; conflicts: string[]; missingResources: string[] }> {
  const conflicts: string[] = [], missingResources: string[] = []
  try {
    validateTaskHandoffBundle(bundle)
    if (!isAbsolute(targetCwd)) throw new Error('目标目录必须是绝对路径')
    const root = resolve(rootDir), prior = readBundleState(root, bundle.identity.sessionId)
    const guard = mergeGuard(prior, bundle)
    await previewStores(root, bundle, targetCwd, guard)
    await readTaskSnapshotDatabase(root, db => importHandoffLedger(db, bundle.ledger, targetCwd, guard))
    missingResources.push(...bundle.requiredResources)
  } catch (error) { conflicts.push(error instanceof Error ? error.message : String(error)) }
  return { canImport: conflicts.length === 0, conflicts, missingResources }
}

export async function importTaskHandoffBundle(rootDir: string, bundle: TaskHandoffBundle, targetCwd: string): Promise<void> {
  const root = resolve(rootDir)
  const preview = await previewTaskHandoffImport(root, bundle, targetCwd)
  if (!preview.canImport) throw new Error(preview.conflicts.join('; '))
  const ownership = new TaskHostOwnershipStore(root).status(bundle.identity.sessionId)
  if (!ownership || ownership.state !== 'preparing' || !ownership.incoming) throw new Error('目标任务必须先进入禁止执行的接收准备状态')
  const guard = mergeGuard(readBundleState(root, bundle.identity.sessionId), bundle)
  archiveSource(root, bundle)
  await pauseSessionContinuations(join(root, 'routines'), bundle.identity.sessionId)
  const targetMeta = { ...bundle.meta, id: bundle.identity.sessionId, cwd: targetCwd, status: 'idle', taskExecutionAuthorityRequired: true } as unknown as SessionMeta
  const preparation = new PreparationPermissionStore(root), preparationView = preparation.get(targetMeta)
  if (preparationView.status === 'granted') preparation.revoke(targetMeta, { expectedRevision: preparationView.revision }, 'task-handoff')
  const taskAuthority = new TaskExecutionAuthorityStore(root)
  if (taskAuthority.hasPersistedRestriction(targetMeta.id)) {
    const view = taskAuthority.get(targetMeta)
    if (view.status === 'granted') taskAuthority.revoke(targetMeta, { expectedRevision: view.revision }, 'task-handoff')
  }
  for (const file of bundle.files) {
    const path = safeTarget(root, file.path)
    const bytes = liveFileBytes(file, bundle, root)
    guard(`file:${file.path}`, existsSync(path) ? hash(readFileSync(path)) : undefined, hash(bytes))
    writeDurableFileSync(path, bytes, { mode: 0o600 })
  }
  await importProject(root, bundle, targetCwd, guard)
  await mutateTaskSnapshotDatabase(root, db => {
    importHandoffLedger(db, bundle.ledger, targetCwd, guard)
    const projection = buildProjectWorkspaceProjection({ workspace: bundle.project.workspaces[0], goals: bundle.project.goals, workItems: bundle.project.workItems })
    appendWorkflowEvent(db, {
      eventId: `task-handoff-import:${bundle.digest}`, streamId: `task-handoff:${bundle.identity.sessionId}`,
      entityType: 'system', entityId: bundle.projectId, kind: 'workflow.task-handoff.imported',
      occurredAt: bundle.provenance.capturedAt,
      payload: { format: 'caogen.task-handoff-authority.v1', projectId: bundle.projectId, sessionId: bundle.identity.sessionId,
        bundleDigest: bundle.digest, sourceHostId: bundle.provenance.sourceHostId,
        workItems: projection.workItems.map(item => ({ id: item.record.id, revision: item.record.revision, digest: item.descriptor.ledgerDigest })) }
    }, { projectId: bundle.projectId, sessionId: bundle.identity.sessionId })
    for (const item of bundle.artifactPlacements) {
      const artifact = bundle.ledger.artifacts.find(value => value.id === item.artifactId)!
      const file = bundle.files.find(value => value.path === item.path)!
      recordWorkflowArtifactLocation(db, { id: `handoff-location:${bundle.digest}:${item.artifactId}`, artifactId: artifact.id,
        projectId: artifact.projectId, goalId: artifact.goalId, workItemId: artifact.workItemId, runId: artifact.runId,
        kind: 'file', path: safeTarget(root, item.path), availability: 'available', checksum: `sha256:${file.digest}`, sizeBytes: file.sizeBytes,
        createdAt: bundle.provenance.capturedAt, updatedAt: bundle.provenance.capturedAt })
    }
  })
  // Rebuild the destination's own canonical Workspace descriptors, including
  // unrelated tasks already present there. This is a local projection, not a
  // claim that the source supplied a complete Project seal.
  await ensureProjectWorkspaceLedgerProjectionForScopedRead(bundle.projectId, root)
  const history = histories(root), nextHistory = placedHistory(bundle.history, targetCwd)
  guard(`history:${bundle.identity.sessionId}`, history.find(item => item.id === bundle.identity.sessionId), nextHistory)
  writeJson(join(root, 'sessions.json'), historyStoreDocument([...history.filter(item => item.id !== bundle.identity.sessionId), nextHistory]))
  // Dormant target: history activation is explicit; active registry cannot auto-start the imported task.
  writeJson(join(root, 'active-sessions.json'), activeSessionRegistryDocument(activeRecords(root).filter(item => item.id !== bundle.identity.sessionId)))
  const creation = creationRecords(root)
  writeJson(join(root, 'session-creation-journal.json'), sessionCreationJournalDocument([
    ...creation.filter(item => (item.sessionId ?? item.id) !== bundle.identity.sessionId)
  ]))
  if (bundle.taskPlan) { const planStore = plans(root); planStore.sessions[bundle.identity.sessionId] = bundle.taskPlan; planStore.revision += 1; writeJson(join(root, 'task-plans/task-plan-contracts.json'), planStore) }
  await mutateMemoryEntries(join(root, 'memory'), entries => {
    const ids = new Set(bundle.memory.map(item => item.id))
    for (const record of bundle.memory) guard(`memory:${record.id}`, entries.find(item => item.id === record.id), record)
    return { entries: [...entries.filter(item => !ids.has(item.id)), ...bundle.memory], result: undefined }
  })
  const routines = await listRoutines(join(root, 'routines')), routineIds = new Set(bundle.routines.map(item => item.id))
  const importedRoutines = bundle.routines.map(item => ({ ...item, enabled: false, nextRunAt: undefined, permissionMode: 'default' as const,
    ...(item.goalContinuationState ? { goalContinuationState: { ...item.goalContinuationState, status: 'paused' as const, reason: '跨主机接收后等待手动继续' } } : {}) }))
  writeJson(getRoutineStorePath(join(root, 'routines')), { version: 1, routines: [...routines.filter(item => !routineIds.has(item.id)), ...importedRoutines] })
  writeJson(join(stateDirectory(root, bundle.identity.sessionId), 'placement.json'), {
    schemaVersion: 1, bundleDigest: bundle.digest, identity: bundle.identity, sourceCwd: bundle.cwd, targetCwd,
    sourceUserData: bundle.provenance.sourceUserData, targetUserData: root, artifactPlacements: bundle.artifactPlacements,
    requiredResources: bundle.requiredResources, automaticContinuations: 'paused', authorization: 'target_local_required'
  })
  const baselines = await captureBaselines(root, bundle)
  persistState(root, bundle, baselines)
}

async function previewStores(root: string, bundle: TaskHandoffBundle, cwd: string, guard: MergeGuard): Promise<void> {
  const existing = histories(root).find(item => item.id === bundle.identity.sessionId)
  if (existing && existing.createdAt !== bundle.identity.sessionCreatedAt) throw new Error('相同 Session ID 对应不同创建身份')
  guard(`history:${bundle.identity.sessionId}`, existing, placedHistory(bundle.history, cwd))
  const current = await readProjectWorkspaceState(projectWorkspaceFile(root))
  projectMerge(current, bundle, cwd, guard)
  const memory = await listMemoryEntriesForLifecycle(join(root, 'memory'))
  for (const item of bundle.memory) guard(`memory:${item.id}`, memory.find(value => value.id === item.id), item)
  const routines = await listRoutines(join(root, 'routines'))
  for (const item of bundle.routines) guard(`routine:${item.id}`, routines.find(value => value.id === item.id), item)
  if (bundle.taskPlan) guard(`plan:${bundle.identity.sessionId}`, plans(root).sessions[bundle.identity.sessionId], bundle.taskPlan)
  for (const file of bundle.files) {
    const path = safeTarget(root, file.path)
    guard(`file:${file.path}`, existsSync(path) ? hash(readFileSync(path)) : undefined, hash(liveFileBytes(file, bundle, root)))
  }
}

function selectProject(state: ProjectWorkspaceState, ledger: HandoffLedger, projectId: string, sessionId: string, history: HistoryEntry): ProjectSlice {
  const workspace = state.workspaces.find(item => item.id === projectId)
  if (!workspace) throw new Error('任务引用的原工作区不存在')
  const workIds = new Set(ledger.workItems.map(item => item.id)); if (history.workItemId) workIds.add(history.workItemId)
  const goalIds = new Set(ledger.goals.map(item => item.id)); if (history.goalId) goalIds.add(history.goalId)
  let changed = true
  while (changed) {
    changed = false
    for (const item of state.workItems.filter(item => workIds.has(item.id))) {
      if (item.goalId) goalIds.add(item.goalId)
      if (item.parentId && !workIds.has(item.parentId)) { workIds.add(item.parentId); changed = true }
    }
  }
  const related = state.workItems.filter(item => item.projectId === projectId && !workIds.has(item.id) &&
    (goalIds.has(item.goalId ?? '') || item.dependencyIds?.some(id => workIds.has(id))))
  if (related.some(item => !['completed', 'cancelled', 'failed', 'archived'].includes(item.status))) throw new Error('同一 Goal 或依赖存在其他可执行任务')
  const workItems = state.workItems.filter(item => workIds.has(item.id))
  if (workItems.some(item => item.dependencyIds?.some(id => !workIds.has(id)))) throw new Error('任务依赖不在本次移交范围内')
  return { workspaces: [workspace], goals: state.goals.filter(item => goalIds.has(item.id)), workItems,
    comments: state.comments.filter(item => workIds.has(item.workItemId)), sharedApprovals: state.sharedApprovals.filter(item => workIds.has(item.workItemId)),
    events: state.events.filter(item => item.projectId === projectId && (workIds.has(item.entityId) || goalIds.has(item.entityId) || item.entityId === projectId)) }
}

function projectMerge(current: ProjectWorkspaceState, bundle: TaskHandoffBundle, cwd: string, guard: MergeGuard): ProjectWorkspaceState {
  const next = structuredClone(current)
  for (const kind of ['workspaces', 'goals', 'workItems', 'comments', 'sharedApprovals', 'events'] as const) {
    for (const original of bundle.project[kind]) {
      const record = kind === 'workspaces' ? placedWorkspace(original as ProjectWorkspaceState['workspaces'][number], bundle.cwd, cwd) : original
      const actual = current[kind].find(item => item.id === record.id)
      if (kind === 'workspaces' && record.id === MANAGED_PERSONAL_WORKSPACE_ID && actual) continue
      guard(`project:${kind}:${record.id}`, actual, record, kind === 'events')
      const index = next[kind].findIndex(item => item.id === record.id)
      const records = next[kind] as { id: string }[]
      if (index >= 0) records[index] = record
      else records.push(record)
    }
  }
  return next
}
async function importProject(root: string, bundle: TaskHandoffBundle, cwd: string, guard: MergeGuard): Promise<void> {
  const persistence = new ProjectWorkspacePersistence(root)
  await persistence.mutate(undefined, context => {
    const next = projectMerge(context.state, bundle, cwd, guard)
    for (const kind of ['workspaces', 'goals', 'workItems', 'comments', 'sharedApprovals', 'events'] as const) (context.state[kind] as unknown[]) = next[kind]
  })
}
function placedWorkspace(workspace: ProjectWorkspaceState['workspaces'][number], source: string, target: string): ProjectWorkspaceState['workspaces'][number] {
  return { ...workspace, resources: workspace.resources.map(resource => ({ ...resource,
    ...(resource.path && within(source, resource.path) ? { path: resolve(target, relative(source, resource.path)) } : {}),
    ...(resource.connector ? { connector: { ...resource.connector, authorization: { ...resource.connector.authorization, status: 'revoked' as const, credentialRef: undefined },
      lifecycle: resource.connector.lifecycle ? { ...resource.connector.lifecycle, enabled: false, autoRefresh: { intervalMs: 0 as const } } : undefined } } : {}) })) }
}

function captureFiles(root: string, sessionId: string, history: HistoryEntry, ledger: HandoffLedger): HandoffFile[] {
  const paths = [join(root, 'attachments', sessionId), join(root, 'preview-annotations', sessionId), join(root, 'task-audit', `${sessionId}.jsonl`),
    join(root, 'patches', `${sessionId}.patch`), codeForgeVerificationDirectory(root, sessionId), runtimeContinuationReceiptPath(root, sessionId),
    join(root, 'preparation-drafts', preparationSessionKey(sessionId))]
  for (const sdk of sdkSessionIds(history, ledger)) paths.push(join(root, 'transcripts', `${sdk}.jsonl`), join(root, 'event-receipts', `${sdk}.jsonl`))
  for (const receipt of listProjectSubmissionReceiptFiles(root, history.workspaceId ?? history.projectId ?? '', new Set([sessionId]))) if (receipt.sessionId === sessionId) paths.push(receipt.path)
  for (const run of ledger.runs) for (const effect of run.taskRun.effects ?? []) if (effect.target.kind === 'git_index_update') {
    const ref = effect.target.artifactRef ?? `git-index/${effect.target.artifactRoot.split(/[\\/]/).at(-1)}`
    if (!/^git-index\/[a-f0-9]{64}$/.test(ref)) throw new Error('Effect 工件身份无效')
    paths.push(join(root, 'effect-artifacts', ref))
  }
  const files = new Map<string, HandoffFile>()
  for (const path of paths) captureTree(root, path, files)
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
}
function captureArtifacts(root: string, ledger: HandoffLedger, files: HandoffFile[]): ArtifactPlacement[] {
  const placements: ArtifactPlacement[] = [], purged = new Set(ledger.purges.map(item => item.artifactId))
  for (const item of ledger.lifecycles) {
    if (purged.has(item.artifactId)) continue
    const placed = ledger.artifactLocations.filter(location => location.artifactId === item.artifactId &&
      location.id.startsWith('handoff-location:') && location.path && within(root, location.path) && location.checksum === item.digest && location.sizeBytes === item.sizeBytes)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    const sourcePath = placed?.path ?? (item.storageKind === 'blob' ? artifactBlobPath(root, item.digest) : item.sourceRef?.startsWith('file:') ? fileURLToPath(item.sourceRef) : item.sourceRef)
    if (!sourcePath || !isAbsolute(sourcePath)) throw new Error(`成果没有可迁移的本地字节: ${item.artifactId}`)
    const bytes = readRegular(sourcePath)
    if (`sha256:${hash(bytes)}` !== item.digest || bytes.length !== item.sizeBytes) throw new Error(`成果版本已经变化: ${item.artifactId}`)
    const path = item.storageKind === 'blob' ? `artifact-blobs/sha256/${hash(bytes)}` : `task-handoff-content/${hash(Buffer.from(item.artifactId))}/${hash(bytes)}`
    if (!files.some(file => file.path === path)) files.push({ path, data: bytes.toString('base64'), digest: hash(bytes), sizeBytes: bytes.length })
    placements.push({ artifactId: item.artifactId, sourcePath, path })
  }
  for (const artifact of ledger.artifacts) {
    if (purged.has(artifact.id) || placements.some(item => item.artifactId === artifact.id)) continue
    const locations = ledger.artifactLocations.filter(item => item.artifactId === artifact.id && item.availability === 'available' && item.path)
    const location = locations.find(item => within(root, item.path!) && existsSync(item.path!)) ?? locations.find(item => existsSync(item.path!)) ?? locations[0]
    const sourcePath = location?.path ?? (artifact.uri?.startsWith('file:') ? fileURLToPath(artifact.uri) : artifact.uri && isAbsolute(artifact.uri) ? artifact.uri : undefined)
    if (!sourcePath) continue
    const bytes = readRegular(sourcePath), checksum = hash(bytes)
    if (![checksum, `sha256:${checksum}`].includes(artifact.digest)) throw new Error(`成果本地内容不匹配原版本：${artifact.id}`)
    const path = `task-handoff-content/${hash(Buffer.from(artifact.id))}/${checksum}`
    if (!files.some(file => file.path === path)) files.push({ path, data: bytes.toString('base64'), digest: checksum, sizeBytes: bytes.length })
    placements.push({ artifactId: artifact.id, sourcePath, path })
  }
  return placements
}
function captureTree(root: string, path: string, result: Map<string, HandoffFile>): void {
  if (!existsSync(path)) return
  const rel = relative(root, path).split(sep).join('/'); safeTarget(root, rel)
  const info = lstatSync(path)
  if (info.isSymbolicLink()) throw new Error(`任务资料不允许符号链接: ${rel}`)
  if (info.isDirectory()) { for (const name of readdirSync(path).sort()) captureTree(root, join(path, name), result); return }
  const bytes = readRegular(path)
  result.set(rel, { path: rel, data: bytes.toString('base64'), digest: hash(bytes), sizeBytes: bytes.length })
}
function allowedFile(path: string, sessionId: string, sdkIds: Set<string>, ledger: HandoffLedger): boolean {
  const prefix = (root: string): boolean => path.startsWith(`${root}/`)
  if (prefix(`attachments/${sessionId}`) || prefix(`preview-annotations/${sessionId}`) || path === `task-audit/${sessionId}.jsonl` || path === `patches/${sessionId}.patch` ||
    prefix(`code-forge-verifications/${digest(sessionId).replace(/^sha256:/, '')}`) || prefix(`preparation-drafts/${preparationSessionKey(sessionId)}`) ||
    path === `runtime-continuations/${hash(Buffer.from(sessionId))}.json` || prefix(`private/session-inputs/${hash(Buffer.from(sessionId))}`)) return true
  if (/^private\/project-goal-submissions\/goal-[a-f0-9]{24}\.json$/.test(path)) return true
  if ([...sdkIds].some(sdk => path === `transcripts/${sdk}.jsonl` || path === `event-receipts/${sdk}.jsonl`)) return true
  if (/^artifact-blobs\/sha256\/[a-f0-9]{64}$/.test(path) || /^task-handoff-content\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(path)) return true
  if (/^effect-artifacts\/git-index\/[a-f0-9]{64}\/(index|manifest\.json|objects\/[a-f0-9]{2}\/[a-f0-9]+)$/.test(path)) return ledger.runs.some(run => run.taskRun.effects?.some(effect => effect.target.kind === 'git_index_update' && path.includes(effect.target.artifactRef ?? effect.target.artifactRoot.split(/[\\/]/).at(-1)!)))
  return false
}
function sdkSessionIds(history: HistoryEntry, ledger: HandoffLedger): Set<string> {
  const ids = new Set([history.sdkSessionId, ...ledger.conversation.streams.map(row => String(row.sdk_session_id))].filter(Boolean))
  for (const id of ids) safeId(id)
  return ids
}

function liveFileBytes(file: HandoffFile, bundle: TaskHandoffBundle, root: string): Buffer {
  const bytes = Buffer.from(file.data, 'base64')
  if (file.path.startsWith('private/session-inputs/')) {
    const value = JSON.parse(bytes.toString('utf8')) as RecordValue
    if (value.sessionId !== bundle.identity.sessionId) throw new Error('提交回执超出原任务范围')
    const payload = value.payload as SendMessagePayload
    if (!payload || typeof payload.text !== 'string') throw new Error('提交回执缺少原始输入')
    const originalDigest = value.importedPayloadDigest ?? messagePayloadDigest(payload)
    const originalPaths = value.importedPayloadPaths ?? { images: (payload.images ?? []).map(item => item.path), documents: (payload.documents ?? []).map(item => item.path) }
    const remap = <T extends { path: string }>(item: T): T => {
      const rel = relative(bundle.provenance.sourceUserData, item.path).split(sep).join('/')
      if (!rel.startsWith(`attachments/${bundle.identity.sessionId}/`) || !bundle.files.some(source => source.path === rel)) throw new Error('提交回执附件未进入任务资料包')
      return { ...item, path: safeTarget(root, rel) }
    }
    value.payload = { ...payload, ...(payload.images ? { images: payload.images.map(remap) } : {}), ...(payload.documents ? { documents: payload.documents.map(remap) } : {}) }
    if (value.followUp) value.followUp = undefined
    if (value.phase === 'dispatching') value.phase = 'needs_reconciliation'
    if (value.phase !== 'queued') { value.importedPayloadDigest = originalDigest; value.importedPayloadPaths = originalPaths }
    return Buffer.from(canonicalJson(value))
  }
  // Continuation receipts are historical evidence only; no source auto-send permit survives.
  return bytes
}
function inspectFileSecrets(path: string, bytes: Buffer): void {
  if (path.endsWith('.json')) {
    const value = JSON.parse(bytes.toString('utf8')) as RecordValue
    if (path.startsWith('private/session-inputs/') && value.followUp) throw new Error('任务仍带有自动续跑机器许可，请先暂停并清理该许可')
    assertNoCredentialMaterial(value)
  } else if (path.endsWith('.jsonl')) for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) assertNoCredentialMaterial(JSON.parse(line))
  else if (!bytes.includes(0)) assertNoCredentialMaterial(bytes.toString('utf8'))
}

function placedHistory(history: HistoryEntry, cwd: string): HistoryEntry {
  return { ...history, cwd, sourceCwd: cwd, repoRoot: undefined, worktreePath: undefined, isolated: false,
    permissionMode: 'default', taskExecutionAuthorityRequired: true, responsesContext: undefined, workspaceHandoff: undefined, workspaceHandoffPending: undefined }
}
function requiredResources(history: HistoryEntry, project: ProjectSlice): string[] {
  const resources = new Set<string>()
  resources.add('目标机需重新确认任务执行权限；旧自动继续与计划任务保持暂停')
  if (history.providerId) resources.add(`目标机需配置 Provider：${history.providerId}；模型：${history.model}`)
  for (const resource of project.workspaces[0].resources) {
    if (resource.connector) resources.add(`连接器需本机重新授权：${resource.label ?? resource.id}`)
    else if (resource.path && !within(history.cwd, resource.path)) resources.add(`外部工作区资料需重新绑定：${resource.label ?? resource.id}`)
  }
  if (history.digitalWorkerBinding) resources.add('目标机需核对原数字员工及其权限配置')
  return [...resources]
}

async function captureBaselines(root: string, bundle: TaskHandoffBundle): Promise<Baselines> {
  const live = await captureHandoffLedger(root, bundle.identity.sessionId, bundle.history.workItemId)
  const baselines = ledgerBaselines(live)
  const state = await readProjectWorkspaceState(projectWorkspaceFile(root))
  baselines[`history:${bundle.identity.sessionId}`] = digest(histories(root).find(item => item.id === bundle.identity.sessionId))
  for (const kind of ['workspaces', 'goals', 'workItems', 'comments', 'sharedApprovals', 'events'] as const) {
    for (const record of bundle.project[kind]) { const actual = state[kind].find(item => item.id === record.id); if (actual) baselines[`project:${kind}:${record.id}`] = digest(actual) }
  }
  for (const item of await listMemoryEntriesForLifecycle(join(root, 'memory'))) if (bundle.memory.some(source => source.id === item.id)) baselines[`memory:${item.id}`] = digest(item)
  for (const item of await listRoutines(join(root, 'routines'))) if (bundle.routines.some(source => source.id === item.id)) baselines[`routine:${item.id}`] = digest(item)
  if (bundle.taskPlan) baselines[`plan:${bundle.identity.sessionId}`] = digest(plans(root).sessions[bundle.identity.sessionId])
  for (const file of bundle.files) { const path = safeTarget(root, file.path); if (existsSync(path)) baselines[`file:${file.path}`] = digest(hash(readFileSync(path))) }
  return baselines
}
function mergeGuard(state: BundleState | undefined, bundle: TaskHandoffBundle): MergeGuard {
  if (state && state.sessionCreatedAt !== bundle.identity.sessionCreatedAt) throw new Error('原任务创建身份冲突')
  const known = Boolean(state && (state.bundleDigests.includes(bundle.digest) || bundle.provenance.previousBundleDigests.some(value => state.bundleDigests.includes(value))))
  return (key, actual, incoming, immutable = false) => {
    if (actual === undefined || actual === null || canonicalJson(actual) === canonicalJson(incoming)) return
    if (!immutable && known && state?.baselines[key] === digest(actual)) return
    throw new Error(`目标已有记录与交接版本冲突：${key}`)
  }
}
function readBundleState(root: string, sessionId: string): BundleState | undefined {
  const path = join(stateDirectory(root, sessionId), 'state.json')
  if (!existsSync(path)) return undefined
  const state = JSON.parse(readFileSync(path, 'utf8')) as BundleState
  if (state.schemaVersion !== 1 || !Number.isFinite(state.sessionCreatedAt) || !state.baselines || !Array.isArray(state.bundleDigests)) throw new Error('任务交接基线损坏')
  return state
}
function persistState(root: string, bundle: TaskHandoffBundle, baselines: Baselines): void {
  const prior = readBundleState(root, bundle.identity.sessionId)
  writeJson(join(stateDirectory(root, bundle.identity.sessionId), 'state.json'), { schemaVersion: 1, sessionCreatedAt: bundle.identity.sessionCreatedAt,
    baselines, bundleDigests: [...new Set([...(prior?.bundleDigests ?? []), ...bundle.provenance.previousBundleDigests, bundle.digest])] })
}
function archiveSource(root: string, bundle: TaskHandoffBundle): void {
  const path = join(stateDirectory(root, bundle.identity.sessionId), 'sources', `${bundle.digest.replace(/^sha256:/, '')}.json`)
  if (existsSync(path)) { if (digest(JSON.parse(readFileSync(path, 'utf8'))) !== digest(bundle)) throw new Error('交接来源档案摘要冲突'); return }
  writeJson(path, bundle)
}
function stateDirectory(root: string, sessionId: string): string { return join(root, 'task-handoff', 'task-data', hash(Buffer.from(sessionId))) }
function histories(root: string): HistoryEntry[] { return existsSync(join(root, 'sessions.json')) ? historyEntriesFromDocument(JSON.parse(readFileSync(join(root, 'sessions.json'), 'utf8'))) : [] }
function activeRecords(root: string): RecordValue[] { return existsSync(join(root, 'active-sessions.json')) ? activeSessionRecordsFromDocument(JSON.parse(readFileSync(join(root, 'active-sessions.json'), 'utf8'))) : [] }
function creationRecords(root: string): RecordValue[] { return existsSync(join(root, 'session-creation-journal.json')) ? sessionCreationJournalRecordsFromDocument(JSON.parse(readFileSync(join(root, 'session-creation-journal.json'), 'utf8'))) : [] }
function plans(root: string): { schemaVersion: number; revision: number; sessions: Record<string, RecordValue> } {
  const path = join(root, 'task-plans/task-plan-contracts.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schemaVersion: 1, revision: 0, sessions: {} }
}
function writeJson(path: string, value: unknown): void { writeDurableFileSync(path, `${canonicalJson(value)}\n`, { mode: 0o600 }) }
function safeId(id: string): void { if (typeof id !== 'string' || !id || id.length > 240 || /[\\/\0-\x1f]/.test(id) || id === '.' || id === '..') throw new Error('任务或对话身份含非法路径字符') }
function safeRelative(path: string): void { if (!path || isAbsolute(path) || /[\\\0-\x1f]/.test(path) || path.split('/').some(item => !item || item === '.' || item === '..')) throw new Error('任务资料相对路径无效') }
function safeTarget(root: string, rel: string): string {
  safeRelative(rel)
  let path = resolve(root)
  const parts = rel.split('/')
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i])
    let info: ReturnType<typeof lstatSync>
    try { info = lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1)) throw new Error('任务资料路径含链接或非普通文件')
  }
  return path
}
function readRegular(path: string): Buffer {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('任务资料必须是受限普通文件')
  return readFileSync(path)
}
function within(root: string, path: string): boolean { const rel = relative(resolve(root), resolve(path)); return !rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) }
function hash(value: Buffer): string { return createHash('sha256').update(value).digest('hex') }
