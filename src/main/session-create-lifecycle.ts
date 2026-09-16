import { statSync } from 'node:fs'
import { app } from 'electron'
import { resolve } from 'node:path'
import { newSessionMeta } from './session-meta'
import { getCaoGenDrivePolicy } from './model/drive'
import { resolveCreationModelRoute, sessionBusinessLine } from './model/session-runtime-routing'
import { assertBusinessLineTaskStrategy } from './business-line-execution-policy'
import { getProject, touchProject } from './projects'
import { getSettings } from './settings'
import { listHistory } from './history'
import { parseSessionConversationSource } from './session-conversation-source'
import { getProvider, listProviders, providerIsReady, resolveProviderEngine } from './providers'
import { isUnroutedLocalPlan } from './session-local-plan'
import { executeManagedWorktreeCreateEffect } from './ipc/worktree-operation-handlers'
import { openProjectWorkspaceStore, type ProjectWorkspaceStore } from './project-workspace/store'
import { executeInteractiveOperationEffect } from './task/operation-effect-gateway'
import { normalizeTaskStrategy, derivePermissionModeFromStrategy, migrateLegacyPermissionMode } from './task/task-strategy'
import { migrateLegacyEngineRecord } from './native-engine-migration'
import { MANAGED_PERSONAL_WORKSPACE_ID } from '../shared/project-workspace-types'
import {
  inspectManagedWorktreeIdentity,
  inspectManagedWorktreeRegistryRecord,
  prepareManagedWorktreeCreateEffect,
  prepareWorktree,
  type ManagedWorktreeRecord
} from './worktrees'
import type {
  AppSettings,
  CaoGenDriveMode,
  CreateSessionOptions,
  HistoryEntry,
  SessionMeta,
  SessionRoutingScope,
  TaskSnapshotWorktreeInfo,
  TaskSnapshotRecord
} from '../shared/types'
import { AUTO_MODEL, AUTO_PROVIDER_ID } from '../shared/types'
import type { WorkItem } from '../shared/project-workspace-types'
import { reconcileTaskExecutionAuthorityMarker } from './permission/task-execution-authority-marker'
import { assertSessionModelChange } from './session-model-change'
import { normalizeSessionRoutingControl } from '../shared/session-routing-control'

export interface SessionCreationDraft {
  opts: CreateSessionOptions
  baseMeta: SessionMeta
}

export interface SessionWorktreePlacement {
  isolated: boolean
  cwd: string
  record?: ManagedWorktreeRecord
}

export function prepareSessionCreationDraft(
  input: CreateSessionOptions,
  parentMeta?: SessionMeta
): SessionCreationDraft {
  const historySource = sessionConversationHistory(input)
  const resumeHistory = historySource?.history
  const forking = historySource?.mode === 'fork'
  const resumeWorktreeRecord = historySource?.mode === 'resume'
    ? resumeHistoryWorktreeRecord(resumeHistory)
    : undefined
  const opts = normalizedSessionCreationOptions(input, resumeHistory, historySource?.mode)
  const settings = getSettings()
  const driveMode = sessionDriveMode(opts, resumeHistory, settings)
  const drivePolicy = getCaoGenDrivePolicy(driveMode)
  const selectedModel = sessionModel(opts, resumeHistory, settings, forking)
  const routingScope = sessionRoutingScope(opts, resumeHistory, parentMeta, selectedModel)
  opts.businessLineId = sessionBusinessLine({ opts, history: resumeHistory, parent: parentMeta, settings, resuming: historySource?.mode === 'resume' })
  const requestedProviderId = forking ? initialProviderId(opts, settings) : resumeHistory?.providerId ?? initialProviderId(opts, settings)
  const taskStrategy = sessionTaskStrategy(opts, resumeHistory, parentMeta, settings, forking)
  const localPlanOnly = !historySource && !parentMeta && input.taskStrategy === 'plan' &&
    isUnroutedLocalPlan({ ...opts, taskStrategy, routingScope, model: selectedModel, providerId: requestedProviderId }) &&
    !listProviders().some(providerIsReady)
  const initialRoute = !localPlanOnly && (!resumeHistory || forking) ? resolveCreationModelRoute({
    opts: { ...opts, routingScope }, settings, driveMode, model: selectedModel, providerId: requestedProviderId
  }) : undefined
  const selectedProviderId = initialRoute?.providerId ?? requestedProviderId
  const provider = localPlanOnly ? undefined : explicitSessionProvider(selectedProviderId, selectedModel)
  const unassigned = sessionUnassigned(opts, resumeHistory, parentMeta)
  const domainOwnership = resolveSessionDomainOwnership(opts, resumeHistory, parentMeta, unassigned)
  const projectId = sessionProjectId(
    opts, resumeHistory, parentMeta, unassigned, Boolean(domainOwnership.workspaceId)
  )
  const baseMeta = createSessionDraftMeta({
    opts, resumeHistory, resumeWorktreeRecord, historyMode: historySource?.mode, driveMode, routingScope, projectId,
    ...domainOwnership, unassigned,
    // The unrouted planning container initializes only local transcript state.
    // Actual sends still have to acquire a valid Provider target at runtime.
    selectedModel, selectedProviderId, engine: provider ? resolveProviderEngine(provider) : 'openai',
    taskStrategy,
    defaultPermissionMode: drivePolicy.defaultPermissionMode
  })
  // A resumed, forked or delegated task cannot silently regain legacy file
  // access when its source required an explicit local grant.
  if (resumeHistory?.taskExecutionAuthorityRequired || parentMeta?.taskExecutionAuthorityRequired) {
    baseMeta.taskExecutionAuthorityRequired = true
  }
  // A model-change receipt belongs to the original task. Reopening that
  // conversation must keep its identity, including an unfinished switch.
  if (historySource?.mode === 'resume' && resumeHistory && (resumeWorktreeRecord || resumeHistory.modelChange || resumeHistory.routingControl)) {
    baseMeta.id = resumeHistory.id
    baseMeta.createdAt = resumeHistory.createdAt
  }
  if (historySource?.mode === 'resume' && resumeHistory?.routingControl) {
    baseMeta.routingControl = normalizeSessionRoutingControl(resumeHistory.routingControl, baseMeta)
  }
  if (historySource?.mode === 'resume' && resumeHistory?.modelChange) {
    // A new Session identity can replay conversation history, but cannot claim
    // the old Session's explicit routing decision or unfinished commit.
    if (baseMeta.id === resumeHistory.id) {
      baseMeta.modelChange = structuredClone(resumeHistory.modelChange)
      assertSessionModelChange({ ...baseMeta, sdkSessionId: resumeHistory.sdkSessionId })
    } else if (resumeHistory.modelChange.state === 'prepared') {
      throw new Error('原任务的模型切换尚未完成，请从恢复中心打开原任务并完成切换。')
    }
  }
  baseMeta.modelRoutingDecision = initialRoute?.decision ?? (historySource?.mode === 'resume' ? resumeHistory?.modelRoutingDecision : undefined)
  assertBusinessLineTaskStrategy(baseMeta, baseMeta.taskStrategy)
  return { opts, baseMeta }
}

interface SessionDraftMetaInput {
  opts: CreateSessionOptions
  resumeHistory?: HistoryEntry
  resumeWorktreeRecord?: ManagedWorktreeRecord
  historyMode?: 'resume' | 'fork'
  driveMode: CaoGenDriveMode
  routingScope: SessionRoutingScope
  projectId?: string
  workspaceId?: string
  goalId?: string
  workItemId?: string
  unassigned: boolean
  selectedModel: string
  selectedProviderId: string
  engine: NonNullable<SessionMeta['engine']>
  taskStrategy: SessionMeta['taskStrategy']
  defaultPermissionMode: SessionMeta['permissionMode']
}

function createSessionDraftMeta(input: SessionDraftMetaInput): SessionMeta {
  const { opts, resumeHistory, resumeWorktreeRecord } = input
  const derivedPermissionMode = sessionPermissionMode(resumeHistory, input.taskStrategy)
  const meta = newSessionMeta({
    ...sessionOwnership(opts, input.historyMode === 'fork' ? undefined : resumeHistory),
    ...sessionWorktreeIdentity(input.historyMode === 'resume' ? resumeHistory : undefined, resumeWorktreeRecord),
    cwd: opts.cwd,
    driveMode: input.driveMode,
    projectId: input.projectId,
    unassigned: input.unassigned,
    model: input.selectedModel,
    providerId: input.selectedProviderId,
    routingScope: input.routingScope,
    budgetUsd: positiveNumber(opts.budgetUsd),
    resumeSessionAt: input.historyMode === 'fork'
      ? undefined
      : opts.resumeSessionAt ?? resumeHistory?.resumeSessionAt,
    engine: input.engine,
    taskStrategy: input.taskStrategy,
    permissionMode: derivedPermissionMode,
    title: opts.title ?? resumeHistory?.title
  })
  return {
    ...meta,
    costUsd: input.historyMode === 'resume' ? resumeHistory?.costUsd ?? meta.costUsd : meta.costUsd,
    businessLineId: opts.businessLineId,
    workspaceId: input.workspaceId,
    goalId: input.goalId,
    workItemId: input.workItemId,
    personalWorkspaceId: normalizedOptionalId(opts.personalWorkspaceId ?? resumeHistory?.personalWorkspaceId),
    experienceModeOverride: normalizeExperienceModeOverride(
      opts.experienceModeOverride ?? resumeHistory?.experienceModeOverride
    ),
    digitalWorkerBinding: input.historyMode === 'resume' ? resumeHistory?.digitalWorkerBinding : undefined,
    conversationForkSourceSdkSessionId: input.historyMode === 'fork' ? resumeHistory?.sdkSessionId : undefined,
    conversationForkCheckpointId: input.historyMode === 'fork'
      ? normalizedOptionalId(opts.forkCheckpointId)
      : undefined,
    conversationForkSourceSessionId: input.historyMode === 'fork' ? resumeHistory?.id : undefined,
    ...sessionRuntimeHistory(input.historyMode, resumeHistory)
  }
}

function sessionRuntimeHistory(mode: SessionDraftMetaInput['historyMode'], history?: HistoryEntry) {
  return mode === 'resume'
    ? { responsesContext: history?.responsesContext, runtimeContinuation: history?.runtimeContinuation }
    : {}
}

function sessionPermissionMode(
  resumeHistory: HistoryEntry | undefined,
  taskStrategy: SessionMeta['taskStrategy']
): SessionMeta['permissionMode'] {
  // Permission mode is derived from strategy; legacy resume values are never trusted directly.
  const migration = resumeHistory
    ? migrateLegacyPermissionMode(resumeHistory.permissionMode, taskStrategy)
    : null
  const derivedPermissionMode = migration
    ? migration.mode
    : derivePermissionModeFromStrategy(taskStrategy)
  if (migration?.downgradedFromBypass) {
    console.warn(
      `[caogen] 会话恢复: 旧 permissionMode='bypassPermissions' 已降级为派生值 '${derivedPermissionMode}'(taskStrategy=${taskStrategy})。` +
      `如需跳过权限请在 Routine 中配置。`
    )
  }
  if (migration?.migratedFromPlan) {
    console.warn(
      `[caogen] 会话恢复: 旧 permissionMode='plan' 已被派生值 '${derivedPermissionMode}' 覆盖(taskStrategy=${taskStrategy})。`
    )
  }
  return derivedPermissionMode
}

function sessionOwnership(opts: CreateSessionOptions, history?: HistoryEntry) {
  return history
    ? {
        parentSessionId: history.parentSessionId,
        orchestrationId: history.orchestrationId,
        childTaskId: history.childTaskId,
        childRole: history.childRole
      }
    : {
        parentSessionId: opts.parentSessionId,
        orchestrationId: opts.orchestrationId,
        childTaskId: opts.childTaskId,
        childRole: opts.childRole
      }
}

function sessionWorktreeIdentity(history?: HistoryEntry, record?: ManagedWorktreeRecord) {
  if (record) {
    return {
      isolated: true,
      sourceCwd: record.sourceCwd,
      repoRoot: record.repoRoot,
      worktreePath: record.worktreePath,
      branch: record.branch,
      baseBranch: record.baseBranch,
      baseSha: record.baseSha,
      worktreeState: record.state
    }
  }
  return {
    isolated: history?.isolated,
    sourceCwd: history?.sourceCwd,
    repoRoot: history?.repoRoot,
    worktreePath: history?.worktreePath,
    branch: history?.branch,
    baseBranch: history?.baseBranch,
    baseSha: history?.baseSha,
    worktreeState: history?.worktreeState
  }
}

function normalizedSessionCreationOptions(
  input: CreateSessionOptions,
  history?: HistoryEntry,
  mode?: 'resume' | 'fork'
): CreateSessionOptions {
  if (!history) return { ...input, cwd: assertUsableSessionCwd(input.cwd) }
  if (mode === 'fork') {
    return {
      ...input,
      cwd: assertUsableSessionCwd(history.cwd),
      isolated: false,
      resumeSdkSessionId: undefined,
      resumeSessionAt: undefined
    }
  }
  return {
    ...input,
    cwd: assertUsableSessionCwd(history.cwd),
    resumeSdkSessionId: history.sdkSessionId
  }
}

function resumeHistoryWorktreeRecord(history?: HistoryEntry): ManagedWorktreeRecord | undefined {
  return history ? managedWorktreeRecordForHistory(history) : undefined
}

function sessionDriveMode(
  opts: CreateSessionOptions,
  history: HistoryEntry | undefined,
  settings: AppSettings
): CaoGenDriveMode {
  return opts.driveMode ?? history?.driveMode ?? settings.driveMode
}

function sessionModel(
  opts: CreateSessionOptions,
  history: HistoryEntry | undefined,
  settings: AppSettings,
  forking = false
): string {
  if (forking) return opts.model ?? ''
  if (history) return history.model
  if (opts.model !== undefined) return opts.model
  return opts.providerId === AUTO_PROVIDER_ID ? AUTO_MODEL : settings.defaultModel
}

function sessionUnassigned(
  opts: CreateSessionOptions,
  history?: HistoryEntry,
  parentMeta?: SessionMeta
): boolean {
  return opts.unassigned ?? history?.unassigned ?? parentMeta?.unassigned ?? false
}

export interface SessionDomainOwnership {
  workspaceId?: string
  goalId?: string
  workItemId?: string
}

type SessionDomainOwnershipClaim = SessionDomainOwnership & { unassigned?: boolean }

/**
 * Resolve canonical workflow ownership independently from the legacy path-based
 * projectId. Resume history is immutable when it already carries an identity;
 * a child may select another Goal/WorkItem only inside the inherited Workspace.
 */
export function resolveSessionDomainOwnership(
  opts: SessionDomainOwnershipClaim,
  history?: SessionDomainOwnershipClaim,
  parentMeta?: SessionDomainOwnershipClaim,
  unassigned = opts.unassigned ?? history?.unassigned ?? parentMeta?.unassigned ?? false
): SessionDomainOwnership {
  const requested = normalizedDomainOwnership(opts, 'session request')
  const historical = normalizedDomainOwnership(history, 'session history')
  const inherited = normalizedDomainOwnership(parentMeta, 'parent session')
  const workspaceId = consistentWorkspaceId(requested.workspaceId, historical.workspaceId, inherited.workspaceId)

  assertResumeOwnershipUnchanged('goalId', requested.goalId, historical.goalId)
  assertResumeOwnershipUnchanged('workItemId', requested.workItemId, historical.workItemId)

  const explicitGoalChanged = requested.goalId !== undefined && requested.goalId !== inherited.goalId
  const workItemId = historical.workItemId ?? requested.workItemId ??
    (explicitGoalChanged ? undefined : inherited.workItemId)
  const explicitWorkItemChanged = requested.workItemId !== undefined && requested.workItemId !== inherited.workItemId
  const goalId = historical.goalId ?? requested.goalId ?? (explicitWorkItemChanged ? undefined : inherited.goalId)
  return assertSessionDomainOwnership({ workspaceId, goalId, workItemId, unassigned })
}

/** Validate and normalize ownership restored from History, journals or snapshots. */
export function assertSessionDomainOwnership(
  claim: SessionDomainOwnershipClaim
): SessionDomainOwnership {
  const ownership = normalizedDomainOwnership(claim, 'session ownership')
  if ((ownership.goalId || ownership.workItemId) && !ownership.workspaceId) {
    throw new Error('canonical Goal/WorkItem ownership requires workspaceId')
  }
  if (claim.unassigned === true && ownership.workspaceId && ownership.workspaceId !== MANAGED_PERSONAL_WORKSPACE_ID) {
    throw new Error('unassigned session cannot claim canonical workspace ownership')
  }
  return ownership
}

/**
 * Resolve ownership against the persisted ProjectWorkspace aggregate before a
 * session is activated. WorkItem ownership is canonical and may supply its
 * Goal when the caller omitted the redundant Goal claim.
 */
export async function assertPersistedSessionDomainOwnership(
  claim: SessionDomainOwnershipClaim,
  rootDir?: string
): Promise<SessionDomainOwnership> {
  const ownership = assertSessionDomainOwnership(claim)
  if (!ownership.workspaceId) return ownership

  const store = await openProjectWorkspaceStore(rootDir)
  await assertActiveWorkspace(store, ownership.workspaceId)
  const workItem = await resolveOwnedWorkItem(store, ownership)
  const goalId = await resolveOwnedGoalId(store, ownership, workItem)

  return {
    workspaceId: ownership.workspaceId,
    goalId,
    workItemId: ownership.workItemId
  }
}

async function assertActiveWorkspace(store: ProjectWorkspaceStore, workspaceId: string): Promise<void> {
  const workspace = await store.getWorkspace(workspaceId)
  if (!workspace) throw new Error(`canonical Workspace does not exist:${workspaceId}`)
  if (workspace.status !== 'active') {
    throw new Error(`canonical Workspace is not active:${workspaceId}:${workspace.status}`)
  }
}

async function resolveOwnedWorkItem(
  store: ProjectWorkspaceStore,
  ownership: SessionDomainOwnership
): Promise<WorkItem | undefined> {
  if (!ownership.workItemId) return undefined
  const workItem = await store.getWorkItem(ownership.workItemId)
  if (!workItem) throw new Error(`canonical WorkItem does not exist:${ownership.workItemId}`)
  if (workItem.projectId !== ownership.workspaceId) {
    throw new Error(`canonical WorkItem crosses Workspace boundary:${workItem.id}`)
  }
  if (ownership.goalId !== undefined && workItem.goalId !== ownership.goalId) {
    throw new Error(`canonical WorkItem crosses Goal boundary:${workItem.id}`)
  }
  return workItem
}

async function resolveOwnedGoalId(
  store: ProjectWorkspaceStore,
  ownership: SessionDomainOwnership,
  workItem: WorkItem | undefined
): Promise<string | undefined> {
  const goalId = ownership.goalId ?? workItem?.goalId
  if (!goalId) return undefined
  const goal = await store.getGoal(goalId)
  if (!goal) throw new Error(`canonical Goal does not exist:${goalId}`)
  if (goal.projectId !== ownership.workspaceId) {
    throw new Error(`canonical Goal crosses Workspace boundary:${goal.id}`)
  }
  return goalId
}

function normalizedDomainOwnership(
  claim: SessionDomainOwnershipClaim | undefined,
  label: string
): SessionDomainOwnership {
  return {
    workspaceId: optionalOwnershipId(claim?.workspaceId, `${label} workspaceId`),
    goalId: optionalOwnershipId(claim?.goalId, `${label} goalId`),
    workItemId: optionalOwnershipId(claim?.workItemId, `${label} workItemId`)
  }
}

function optionalOwnershipId(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be a non-empty identifier`)
  }
  return value.trim()
}

function consistentWorkspaceId(
  requested: string | undefined,
  historical: string | undefined,
  inherited: string | undefined
): string | undefined {
  const claims = [requested, historical, inherited].filter((value): value is string => value !== undefined)
  if (new Set(claims).size > 1) {
    throw new Error('canonical workspace ownership cannot change across create/resume/parent scope')
  }
  return historical ?? requested ?? inherited
}

function assertResumeOwnershipUnchanged(
  field: 'goalId' | 'workItemId',
  requested: string | undefined,
  historical: string | undefined
): void {
  if (requested !== undefined && historical !== undefined && requested !== historical) {
    throw new Error(`resumed session cannot change canonical ${field}`)
  }
}

export function synchronousSessionPlacement(draft: SessionCreationDraft): SessionWorktreePlacement {
  const { opts, baseMeta } = draft
  const worktree = opts.resumeSdkSessionId !== undefined
    ? recoverySessionPlacement(baseMeta)
    : prepareWorktree({ sessionId: baseMeta.id, cwd: opts.cwd, isolated: opts.isolated })
  if ('error' in worktree) throw new Error(worktree.error)
  return worktree
}

export async function managedSessionPlacement(
  draft: SessionCreationDraft
): Promise<SessionWorktreePlacement> {
  const { opts, baseMeta } = draft
  if (opts.resumeSdkSessionId !== undefined) return recoverySessionPlacement(baseMeta)
  const prepared = prepareManagedWorktreeCreateEffect({
    sessionId: baseMeta.id,
    cwd: opts.cwd,
    isolated: opts.isolated
  })
  if ('error' in prepared) throw new Error(prepared.error)
  if (!prepared.isolated || 'existing' in prepared) return prepared
  const created = await executeManagedWorktreeCreateEffect(
    prepared.plan,
    baseMeta.workspaceId ?? baseMeta.projectId,
    executeInteractiveOperationEffect,
    {
      workspaceId: baseMeta.workspaceId,
      goalId: baseMeta.goalId,
      workItemId: baseMeta.workItemId
    }
  )
  if (!created.ok) {
    throw sessionCreateEffectError(
      'error' in created ? created : { error: 'managed worktree 创建未返回可确认结果' }
    )
  }
  return created
}

export function sessionMetaForPlacement(
  draft: SessionCreationDraft,
  worktree: SessionWorktreePlacement
): SessionMeta {
  if (worktree.record) {
    if (!worktree.isolated) throw new Error('managed worktree placement 必须标记为 isolated')
    if (worktree.record.sessionId !== draft.baseMeta.id) {
      throw new Error('managed worktree placement sessionId 与会话不一致')
    }
    if (worktree.cwd !== worktree.record.cwd) {
      throw new Error('managed worktree placement cwd 与 registry 不一致')
    }
    const identity = inspectManagedWorktreeIdentity(worktree.record)
    if ('error' in identity) {
      throw Object.assign(new Error(`managed worktree placement identity mismatch: ${identity.error}`), {
        nonRetryable: true,
        requiresReconciliation: true,
        sessionId: draft.baseMeta.id
      })
    }
  } else if (worktree.isolated) {
    throw new Error('isolated session placement 缺少 managed worktree registry record')
  }
  return applySessionPlacement(draft.baseMeta, worktree)
}

export function sessionMetaForRecovery(meta: SessionMeta): SessionMeta {
  const ownership = assertSessionDomainOwnership(meta)
  const migratedMeta = migrateLegacyEngineRecord(meta as SessionMeta & { engine?: string }) as SessionMeta
  return applySessionPlacement({
    ...migratedMeta,
    ...ownership,
    taskStrategy: normalizeTaskStrategy(migratedMeta.taskStrategy)
  }, recoverySessionPlacement(migratedMeta))
}

function sessionTaskStrategy(
  opts: CreateSessionOptions,
  history?: HistoryEntry,
  parentMeta?: SessionMeta,
  settings?: AppSettings,
  forking = false
): SessionMeta['taskStrategy'] {
  return normalizeTaskStrategy(
    forking
      ? opts.taskStrategy ?? history?.taskStrategy ?? parentMeta?.taskStrategy
      : history?.taskStrategy ?? opts.taskStrategy ?? parentMeta?.taskStrategy ?? settings?.defaultTaskStrategy
  )
}

export function assertTaskSnapshotWorktreeProjection(
  meta: SessionMeta,
  worktree: TaskSnapshotWorktreeInfo | undefined
): void {
  const metaClaimsManaged = sessionMetaClaimsManagedWorktree(meta)
  if (!worktree) {
    if (metaClaimsManaged) throw new Error('managed task snapshot 缺少 worktree identity projection')
    return
  }
  if (
    worktree.isolated !== meta.isolated ||
    worktree.sourceCwd !== meta.sourceCwd ||
    worktree.repoRoot !== meta.repoRoot ||
    worktree.worktreePath !== meta.worktreePath ||
    worktree.branch !== meta.branch ||
    worktree.baseBranch !== meta.baseBranch ||
    worktree.baseSha !== meta.baseSha ||
    worktree.state !== meta.worktreeState
  ) {
    throw new Error('task snapshot worktree projection 与 session metadata 不一致')
  }
}

function recoverySessionPlacement(meta: SessionMeta): SessionWorktreePlacement {
  const lookup = inspectManagedWorktreeRegistryRecord(meta.id)
  if ('error' in lookup) throw new Error(`managed worktree registry 不可用于恢复: ${lookup.error}`)
  const claimsManaged = sessionMetaClaimsManagedWorktree(meta)
  if (!lookup.record) {
    if (claimsManaged) throw new Error('managed session registry record 已丢失，拒绝恢复')
    return { isolated: false, cwd: assertUsableSessionCwd(meta.cwd) }
  }
  if (!claimsManaged || !sessionMetaMatchesManagedWorktreeRecord(meta, lookup.record)) {
    throw new Error('managed session metadata 与 registry identity 不一致，拒绝恢复')
  }
  const identity = inspectManagedWorktreeIdentity(lookup.record)
  if ('error' in identity) {
    throw new Error(`managed worktree recovery identity mismatch: ${identity.error}`)
  }
  return { isolated: true, cwd: lookup.record.cwd, record: lookup.record }
}

function applySessionPlacement(
  meta: SessionMeta,
  worktree: SessionWorktreePlacement
): SessionMeta {
  return {
    ...meta,
    cwd: worktree.cwd,
    isolated: worktree.isolated,
    sourceCwd: worktree.record?.sourceCwd,
    repoRoot: worktree.record?.repoRoot,
    worktreePath: worktree.record?.worktreePath,
    branch: worktree.record?.branch,
    baseBranch: worktree.record?.baseBranch,
    baseSha: worktree.record?.baseSha,
    worktreeState: worktree.record?.state
  }
}

function sessionMetaClaimsManagedWorktree(meta: SessionMeta): boolean {
  return meta.isolated === true || [
    meta.sourceCwd,
    meta.repoRoot,
    meta.worktreePath,
    meta.branch,
    meta.baseBranch,
    meta.baseSha,
    meta.worktreeState
  ].some((value) => value !== undefined)
}

function historyClaimsManagedWorktree(history: HistoryEntry): boolean {
  return history.isolated === true || [
    history.sourceCwd,
    history.repoRoot,
    history.worktreePath,
    history.branch,
    history.baseBranch,
    history.baseSha,
    history.worktreeState
  ].some((value) => value !== undefined)
}

function managedWorktreeRecordForHistory(history: HistoryEntry): ManagedWorktreeRecord | undefined {
  const lookup = inspectManagedWorktreeRegistryRecord(history.id)
  if ('error' in lookup) throw new Error(`managed worktree registry 不可用于历史恢复: ${lookup.error}`)
  if (!lookup.record) {
    if (historyClaimsManagedWorktree(history)) {
      throw new Error('历史会话声明 managed worktree，但 registry record 已丢失')
    }
    return undefined
  }
  if (!historyMatchesManagedWorktreeRecord(history, lookup.record)) {
    throw new Error('历史会话的 managed worktree identity 与 registry 不一致')
  }
  const identity = inspectManagedWorktreeIdentity(lookup.record)
  if ('error' in identity) {
    throw new Error(`managed worktree history identity mismatch: ${identity.error}`)
  }
  return lookup.record
}

function historyMatchesManagedWorktreeRecord(
  history: HistoryEntry,
  record: Readonly<ManagedWorktreeRecord>
): boolean {
  return history.id === record.sessionId &&
    history.isolated === true &&
    history.cwd === record.cwd &&
    history.sourceCwd === record.sourceCwd &&
    history.repoRoot === record.repoRoot &&
    history.worktreePath === record.worktreePath &&
    history.branch === record.branch &&
    history.baseBranch === record.baseBranch &&
    history.baseSha === record.baseSha &&
    history.worktreeState === record.state
}

function sessionMetaMatchesManagedWorktreeRecord(
  meta: SessionMeta,
  record: Readonly<ManagedWorktreeRecord>
): boolean {
  return meta.id === record.sessionId &&
    meta.isolated === true &&
    meta.cwd === record.cwd &&
    meta.sourceCwd === record.sourceCwd &&
    meta.repoRoot === record.repoRoot &&
    meta.worktreePath === record.worktreePath &&
    meta.branch === record.branch &&
    meta.baseBranch === record.baseBranch &&
    meta.baseSha === record.baseSha &&
    meta.worktreeState === record.state
}

export function assertUsableSessionCwd(rawCwd: string): string {
  const raw = typeof rawCwd === 'string' ? rawCwd.trim() : ''
  if (!raw) throw new Error('项目路径不能为空')
  const cwd = resolve(raw)
  let stat
  try {
    stat = statSync(cwd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`项目路径不存在:${cwd}`)
    throw new Error(`项目路径不可访问:${cwd}`)
  }
  if (!stat.isDirectory()) throw new Error(`项目路径不是目录:${cwd}`)
  return cwd
}

function sessionConversationHistory(
  opts: CreateSessionOptions
): { history: HistoryEntry; mode: 'resume' | 'fork' } | undefined {
  const source = parseSessionConversationSource(opts)
  if (!source) return undefined
  const { mode, sdkSessionId } = source
  const history = listHistory().find((entry) => entry.sdkSessionId === sdkSessionId)
  if (!history) throw new Error(`未找到 sdkSessionId 对应的历史会话:${sdkSessionId}`)
  return { history: reconcileTaskExecutionAuthorityMarker(history, app.getPath('userData')), mode }
}

function sessionRoutingScope(
  opts: CreateSessionOptions,
  resumeHistory: HistoryEntry | undefined,
  parentMeta: SessionMeta | undefined,
  selectedModel: string
): SessionRoutingScope {
  return opts.routingScope ?? resumeHistory?.routingScope ?? parentMeta?.routingScope ??
    (opts.providerId === AUTO_PROVIDER_ID ? 'global' : selectedModel === AUTO_MODEL ? 'provider' : 'fixed')
}

function normalizedOptionalId(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

function normalizeExperienceModeOverride(
  value: CreateSessionOptions['experienceModeOverride']
): CreateSessionOptions['experienceModeOverride'] {
  if (value === undefined || value === 'assistant' || value === 'studio') return value
  throw new Error('experienceModeOverride must be assistant or studio')
}

function initialProviderId(opts: CreateSessionOptions, settings: AppSettings): string {
  if (opts.providerId === undefined) return settings.defaultProviderId.trim()
  return opts.providerId.trim() === AUTO_PROVIDER_ID ? '' : opts.providerId.trim()
}

function explicitSessionProvider(providerIdInput: string, model: string) {
  if (!model) throw new Error('请选择模型或显式选择自动调度')
  const providerId = providerIdInput.trim()
  if (!providerId) throw new Error('请选择可用 Provider')
  const provider = getProvider(providerId)
  if (!provider) throw new Error(`Provider 不存在:${providerId}`)
  if (!providerIsReady(provider)) throw new Error(`请先在设置里完成 ${provider.name} 的鉴权配置`)
  return provider
}

function sessionProjectId(
  opts: CreateSessionOptions,
  resumeHistory: HistoryEntry | undefined,
  parentMeta: SessionMeta | undefined,
  unassigned: boolean,
  canonicalWorkspaceOwned = false
): string | undefined {
  const projectId = resumeHistory?.projectId ?? opts.projectId ?? parentMeta?.projectId
  if (projectId && !getProject(projectId)) throw new Error('关联项目不存在，请重新选择项目')
  if (projectId || unassigned || canonicalWorkspaceOwned) return projectId
  return touchProject(opts.cwd).id
}

function sessionCreateEffectError(result: {
  error: string
  operationId?: string
  snapshotId?: string
  recoverySnapshot?: TaskSnapshotRecord
  effectStatus?: string
}): Error {
  const requiresReconciliation = result.effectStatus === 'waiting_reconciliation' || Boolean(result.snapshotId)
  const message = requiresReconciliation && result.snapshotId
    ? `${result.error} [requires reconciliation: ${result.snapshotId}]`
    : result.error
  return Object.assign(new Error(message), {
    ...(requiresReconciliation ? { nonRetryable: true, requiresReconciliation: true } : {}),
    ...(result.operationId ? { operationId: result.operationId } : {}),
    ...(result.snapshotId ? { snapshotId: result.snapshotId } : {}),
    ...(result.recoverySnapshot ? { recoverySnapshot: result.recoverySnapshot } : {})
  })
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
