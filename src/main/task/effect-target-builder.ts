import { buildOfficeRevisionEffectTarget } from '../office-revision/effect'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { EffectTarget } from '../../shared/types'
import {
  type CodeForgeDeliveryInput,
  type CodeForgeWorktreeContext
} from '../code-forge/delivery'
import { buildCodeForgePatchEffectTarget } from '../code-forge/patch-effect'
import { buildGitIndexEffectTarget, isGitIndexEffectToolName } from '../git/git-index-effect'
import { buildIssueEffectTarget, buildPullRequestEffectTarget } from '../git/pull-request-effect'
import { buildMcpEffectTarget } from '../mcp/mcp-effect'
import { buildWebhookMessageEffectTarget } from '../notification/notification-effect'
import {
  buildOfficeArtifactEffectTarget,
  isOfficeArtifactTool
} from '../agent/tools/office-artifact'
import { buildDiscardWorkspaceHunkEffectTarget } from '../git/worktree-hunk-effect'
import {
  buildManagedWorktreeCreateTarget,
  buildManagedWorktreeRemoveTarget
} from '../git/managed-worktree-effect'
import {
  buildWorktreePatchApplyTarget,
  type OperationEffectReconcilerContext
} from './operation-effect-reconciler'
import {
  inspectManagedWorktreeIdentity,
  inspectManagedWorktreeRegistryRecord
} from '../managed-worktree-lifecycle'
import {
  buildManagedPluginEffectTarget,
  isManagedPluginEffectToolName
} from '../plugin/plugin-directory-effect'
import { normalizeToolName } from './tool-idempotency'
import { buildGuiPostconditionEffectTarget } from '../gui/gui-effect'
import {
  buildMigrationOperationEffectTarget,
  isMigrationOperationEffectToolName
} from '../migration-operation-effect'
import { buildProjectPortableExportEffectTarget } from '../project-export-effect-target'
import { buildProjectPortableImportEffectTarget } from '../project-import-effect-target'
import { buildProjectPermanentDeletionEffectTarget } from '../project-deletion-effect-target'
import { buildProviderProfileOperationTarget } from '../provider/provider-profile-operation-target'
import { buildMediaJobOperationTarget } from '../media/media-job-effect-target'

export interface EffectTargetObservationOptions {
  beforeRead?: (filePath: string) => Promise<void> | void
}

export interface EffectTargetBuilderContext {
  fileWriteTarget(
    cwd: string,
    toolInput: Record<string, unknown>,
    observationOptions: EffectTargetObservationOptions
  ): Promise<EffectTarget>
  searchReplaceTarget(cwd: string, toolInput: Record<string, unknown>): Promise<EffectTarget>
  exactFileEditTarget(cwd: string, toolInput: Record<string, unknown>): Promise<EffectTarget>
  gitCommitTarget(cwd: string, toolInput: Record<string, unknown>): Promise<EffectTarget>
  gitMergeTarget(cwd: string, toolInput: Record<string, unknown>): Promise<EffectTarget>
  gitPushTarget(cwd: string, toolInput: Record<string, unknown>): Promise<EffectTarget>
}

interface EffectTargetInput {
  sessionId?: string
  toolName: string
  toolInput: Record<string, unknown>
  cwd: string
}

interface BuiltEffectTarget {
  toolName: string
  target: EffectTarget
}

export async function buildEffectTarget(
  input: EffectTargetInput,
  observationOptions: EffectTargetObservationOptions,
  context: EffectTargetBuilderContext,
  operationContext: OperationEffectReconcilerContext
): Promise<BuiltEffectTarget> {
  const toolName = normalizeToolName(input.toolName)
  const fileTarget = await buildFileEffectTarget(input, toolName, observationOptions, context)
  if (fileTarget) return { toolName, target: persistedEffectTarget(fileTarget) }
  const target = await buildRepositoryEffectTarget(input, toolName, context, operationContext)
  return { toolName, target: persistedEffectTarget(target) }
}

function persistedEffectTarget(target: EffectTarget): EffectTarget {
  return JSON.parse(JSON.stringify(target)) as EffectTarget
}

async function buildFileEffectTarget(
  input: EffectTargetInput,
  toolName: string,
  observationOptions: EffectTargetObservationOptions,
  context: EffectTargetBuilderContext
): Promise<EffectTarget | undefined> {
  if (toolName === 'revise_office_artifact') return buildOfficeRevisionEffectTarget(input)
  if (isOfficeArtifactTool(toolName)) {
    return buildOfficeArtifactEffectTarget(toolName, input.toolInput, input.cwd)
  }
  if (toolName === 'write_file') {
    return context.fileWriteTarget(input.cwd, input.toolInput, observationOptions)
  }
  if (toolName === 'search_replace' && input.toolInput.dry_run !== true) {
    return context.searchReplaceTarget(input.cwd, input.toolInput)
  }
  if (toolName === 'workspace_discard_hunk') {
    return buildDiscardWorkspaceHunkEffectTarget(
      input.cwd,
      input.toolInput.filePath,
      input.toolInput.hunkPatch
    )
  }
  if (toolName !== 'edit_file') return undefined
  return buildEditFileTarget(input, toolName, context)
}

async function buildEditFileTarget(
  input: EffectTargetInput,
  toolName: string,
  context: EffectTargetBuilderContext
): Promise<EffectTarget> {
  const rawToolName = input.toolName.trim()
  if (rawToolName === 'MultiEdit' || rawToolName === 'NotebookEdit') {
    return { kind: 'unsupported', toolName }
  }
  if (
    typeof input.toolInput.old_string !== 'string' ||
    typeof input.toolInput.new_string !== 'string'
  ) {
    throw new Error('edit_file 效果描述要求 old_string 与 new_string 为字符串')
  }
  if (
    input.toolInput.replace_all !== undefined &&
    typeof input.toolInput.replace_all !== 'boolean'
  ) {
    throw new Error('edit_file 效果描述要求 replace_all 为布尔值')
  }
  return context.exactFileEditTarget(input.cwd, input.toolInput)
}

async function buildRepositoryEffectTarget(
  input: EffectTargetInput,
  toolName: string,
  context: EffectTargetBuilderContext,
  operationContext: OperationEffectReconcilerContext
): Promise<EffectTarget> {
  const guiTarget = await buildGuiPostconditionEffectTarget(toolName, input.toolInput)
  if (guiTarget) return guiTarget
  if (isGitIndexEffectToolName(toolName)) return buildGitIndexEffectTarget({ ...input, toolName })
  if (toolName === 'git_commit') return context.gitCommitTarget(input.cwd, input.toolInput)
  if (toolName === 'git_merge') return context.gitMergeTarget(input.cwd, input.toolInput)
  if (toolName === 'git_push') return context.gitPushTarget(input.cwd, input.toolInput)
  if (toolName === 'git_create_pr') return buildPullRequestTarget(input)
  if (toolName === 'git_create_issue') return buildIssueTarget(input)
  if (toolName === 'mcp_call_tool') {
    return buildMcpEffectTarget(input.toolInput, input.cwd) ?? { kind: 'unsupported', toolName }
  }
  if (toolName === 'send_notification') return buildWebhookMessageEffectTarget(input.toolInput)
  if (toolName === 'code_forge_delivery') {
    assertCodeForgeEffectInput(input.toolInput)
    return buildCodeForgeTarget(input)
  }
  if (toolName === 'worktree_patch_apply') {
    return buildWorktreePatchApplyTarget(input.cwd, input.toolInput, operationContext)
  }
  if (toolName === 'managed_worktree_create') {
    return buildManagedWorktreeCreateTarget(input.cwd, input.toolInput)
  }
  if (toolName === 'managed_worktree_remove') {
    return buildManagedWorktreeRemoveTarget(input.cwd, input.toolInput)
  }
  if (isManagedPluginEffectToolName(toolName)) {
    return buildManagedPluginEffectTarget(input.cwd, toolName, input.toolInput)
  }
  if (isMigrationOperationEffectToolName(toolName)) {
    return buildMigrationOperationEffectTarget(toolName, input.toolInput)
  }
  if (toolName === 'project_portable_export') {
    return buildProjectPortableExportEffectTarget(input.toolInput)
  }
  if (toolName === 'project_portable_import') {
    return buildProjectPortableImportEffectTarget(input.toolInput)
  }
  if (toolName === 'project_permanent_deletion') {
    return buildProjectPermanentDeletionEffectTarget(input.toolInput)
  }
  if (toolName === 'provider_profile_operation') {
    return buildProviderProfileOperationTarget(input.toolInput)
  }
  if (toolName === 'media_job_operation') {
    return buildMediaJobOperationTarget(input.toolInput)
  }
  return { kind: 'unsupported', toolName }
}

function assertCodeForgeEffectInput(toolInput: Record<string, unknown>): void {
  const mode = toolInput.mode
  if (mode === 'commit' || mode === 'pr') {
    throw new Error(
      `code_forge_delivery mode=${mode} 已停用，已在 Effect descriptor 创建前阻止；请先生成 report/patch，再使用独立 Git 工具完成持久交付`
    )
  }
  if (toolInput.verificationCommand !== undefined || toolInput.verificationCommands !== undefined) {
    throw new Error(
      'code_forge_delivery 不再接受 verificationCommand/verificationCommands，已在 Effect descriptor 创建前阻止；请先显式调用 bash 完成验证'
    )
  }
  if (toolInput.createPatch === true) {
    throw new Error(
      'code_forge_delivery createPatch=true 已停用，已在 Effect descriptor 创建前阻止；请显式使用 mode=patch'
    )
  }
  if (mode !== 'patch') {
    throw new Error('只有 code_forge_delivery mode=patch 会建立 Effect descriptor')
  }
}

function buildCodeForgeTarget(input: EffectTargetInput): EffectTarget {
  const worktreeContext = codeForgeWorktreeContext(input)
  return buildCodeForgePatchEffectTarget({
    cwd: input.cwd,
    mode: input.toolInput.mode as CodeForgeDeliveryInput['mode'],
    verificationCommand: input.toolInput.verificationCommand as string | undefined,
    verificationCommands: input.toolInput.verificationCommands as string[] | undefined,
    createPatch: input.toolInput.createPatch as boolean | undefined,
    worktreeContext
  })
}

function codeForgeWorktreeContext(input: EffectTargetInput): CodeForgeWorktreeContext {
  const sessionId = input.sessionId?.trim()
  if (!sessionId) return rejectUnregisteredWorktreeSelectors(input.toolInput)
  const lookup = inspectManagedWorktreeRegistryRecord(sessionId)
  if ('error' in lookup) throw new Error(`managed worktree registry 无法查询:${lookup.error}`)
  const record = lookup.record
  if (!record) return rejectUnregisteredWorktreeSelectors(input.toolInput, sessionId)
  if (record.state !== 'active') throw new Error('Code Forge patch 只接受 active managed worktree record')
  const identity = inspectManagedWorktreeIdentity(record)
  if ('error' in identity) throw new Error(`Code Forge managed worktree 身份校验失败:${identity.error}`)
  const cwd = realpathSync(resolve(input.cwd))
  const worktreePath = realpathSync(resolve(record.worktreePath))
  const relativePath = relative(worktreePath, cwd)
  if (relativePathEscapesRoot(relativePath)) {
    throw new Error('Code Forge patch cwd 不属于当前 session 的 active managed worktree')
  }
  assertManagedSelectorDoesNotOverride(input.toolInput, record)
  return {
    sessionId: record.sessionId,
    repoRoot: record.repoRoot,
    sourceCwd: record.sourceCwd,
    worktreePath: record.worktreePath,
    branch: record.branch,
    baseBranch: record.baseBranch,
    baseSha: record.baseSha
  }
}

export function relativePathEscapesRoot(relativePath: string, separator = sep): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${separator}`) || isAbsolute(relativePath)
}

function rejectUnregisteredWorktreeSelectors(
  toolInput: Record<string, unknown>,
  sessionId?: string
): CodeForgeWorktreeContext {
  for (const field of ['repoRoot', 'worktreePath', 'baseSha'] as const) {
    if (toolInput[field] !== undefined) {
      throw new Error(`没有 active managed worktree record，已拒绝模型提供的 ${field}`)
    }
  }
  return sessionId ? { sessionId } : {}
}

function assertManagedSelectorDoesNotOverride(
  toolInput: Record<string, unknown>,
  record: {
    repoRoot: string
    worktreePath: string
    baseSha: string
    branch: string
    baseBranch: string | null
  }
): void {
  const expected: Record<string, string | null> = {
    repoRoot: record.repoRoot,
    worktreePath: record.worktreePath,
    baseSha: record.baseSha,
    branch: record.branch,
    baseBranch: record.baseBranch
  }
  for (const [field, value] of Object.entries(expected)) {
    if (toolInput[field] !== undefined && toolInput[field] !== value) {
      throw new Error(`模型参数不得覆盖 active managed worktree 的 ${field}`)
    }
  }
}

function buildPullRequestTarget(input: EffectTargetInput): Promise<EffectTarget> {
  return buildPullRequestEffectTarget({
    cwd: input.cwd,
    title: requiredString(input.toolInput.title),
    body: typeof input.toolInput.body === 'string' ? input.toolInput.body : '',
    base: optionalString(input.toolInput.base)
  })
}

function buildIssueTarget(input: EffectTargetInput): Promise<EffectTarget> {
  return buildIssueEffectTarget({
    cwd: input.cwd,
    title: requiredString(input.toolInput.title),
    body: typeof input.toolInput.body === 'string' ? input.toolInput.body : '',
    labels: stringArray(input.toolInput.labels)
  })
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('效果描述缺少必需字符串参数')
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('效果描述要求 labels 为字符串数组')
  }
  return value as string[]
}
