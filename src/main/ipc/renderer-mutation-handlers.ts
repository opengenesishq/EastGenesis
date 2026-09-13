import type { GitCommitResult, SessionMeta, WorkspaceHunkResult, WriteTextFileResult } from '../../shared/types'
import { isAbsolute, resolve } from 'node:path'
import {
  prepareImageAttachmentBytes,
  prepareDocumentAttachmentFile,
  prepareImageAttachmentFile,
  type ImageAttachmentBytesInput
} from '../attachmentOps'
import { executePreparedDocumentAttachmentEffect, executePreparedImageAttachmentEffect } from '../attachmentEffect'
import { writeTextFile } from '../fileOps'
import { gitCommit } from '../git/git-helper'
import { applyHunk } from '../gitDiff'
import {
  executeGitIndexEffectTarget,
  gitIndexEffectToolNameForIpcChannel,
  type GitIndexEffectInput,
  type GitIndexEffectIpcChannel
} from '../git/git-index-effect'
import { sessionManager } from '../sessionManager'
import { projectTestCommitReadiness } from '../projectTestReviewGate'
import {
  executeInteractiveOperationEffect,
  type InteractiveOperationEffectOutcome
} from '../task/operation-effect-gateway'

type OperationGateway = typeof executeInteractiveOperationEffect
type CompletedOutcome<T> = Extract<InteractiveOperationEffectOutcome<T>, { status: 'completed' }>
type IncompleteOutcome<T> = Exclude<InteractiveOperationEffectOutcome<T>, { status: 'completed' }>

interface RendererOperationContext {
  cwd: string
  projectId?: string
  workspaceId?: string
  goalId?: string
  workItemId?: string
}

export async function executeInteractiveOperationEffectWriteFile(
  id: string,
  relPath: unknown,
  content: unknown,
  runOperation: OperationGateway,
  rootDir?: string
) {
  const context = rendererOperationContext(id)
  if (!context) return { ok: false, error: '会话不存在' }
  const safePath = typeof relPath === 'string' ? relPath : ''
  const safeContent = typeof content === 'string' ? content : ''
  const outcome = await runOperation({
    kind: 'file_write',
    rootDir,
    title: '保存项目文件',
    sourceSessionId: id,
    ...rendererOperationOwnership(context),
    cwd: context.cwd,
    toolName: 'write_file',
    toolInput: { path: safePath, content: safeContent },
    execute: (effect) => {
      if (effect.target.kind !== 'file_content') throw new Error('文件写入 EffectTarget 类型不匹配')
      return writeTextFile(context.cwd, safePath, safeContent)
    },
    isSuccess: (result) => result.ok,
    resultSummary: (result) => JSON.stringify(result)
  })
  return outcome.status === 'completed'
    ? completedFileWriteResult(outcome)
    : incompleteOperationResult(outcome)
}

export async function executeInteractiveOperationEffectGitCommit(
  id: string,
  message: unknown,
  runOperation: OperationGateway,
  rootDir?: string
) {
  const context = rendererOperationContext(id)
  if (!context) return { ok: false, error: '会话不存在' }
  const safeMessage = typeof message === 'string' ? message : ''
  const review = await projectTestCommitReadiness(context.cwd, id)
  if (!review.ok) return review
  const outcome = await runOperation({
    kind: 'git_commit',
    rootDir,
    title: '提交 Git 改动',
    sourceSessionId: id,
    ...rendererOperationOwnership(context),
    cwd: context.cwd,
    toolName: 'git_commit',
    toolInput: { message: safeMessage, projectTestRunId: review.runId },
    execute: (effect) => {
      if (effect.target.kind !== 'git_commit') throw new Error('Git commit EffectTarget 类型不匹配')
      return safeGitCommit(context.cwd, safeMessage)
    },
    isSuccess: (result) => result.ok,
    resultSummary: (result) => JSON.stringify(result)
  })
  return outcome.status === 'completed'
    ? completedGitCommitResult(outcome)
    : incompleteOperationResult(outcome)
}

export async function executeInteractiveOperationEffectDiscardHunk(
  id: string,
  filePath: unknown,
  hunkPatch: unknown,
  runOperation: OperationGateway,
  rootDir?: string
) {
  const context = rendererOperationContext(id)
  if (!context) return { ok: false, error: '会话不存在' }
  const safePath = typeof filePath === 'string' ? filePath : ''
  const safePatch = typeof hunkPatch === 'string' ? hunkPatch : ''
  const outcome = await runOperation({
    kind: 'workspace_hunk_discard',
    rootDir,
    title: '丢弃工作区 hunk',
    sourceSessionId: id,
    ...rendererOperationOwnership(context),
    cwd: context.cwd,
    toolName: 'workspace_discard_hunk',
    toolInput: { filePath: safePath, hunkPatch: safePatch },
    execute: (effect) => {
      if (effect.target.kind !== 'file_content') throw new Error('discard hunk EffectTarget 类型不匹配')
      return applyHunk(context.cwd, safePath, safePatch, { reverse: true })
    },
    isSuccess: (result) => result.ok,
    resultSummary: (result) => JSON.stringify(result)
  })
  return outcome.status === 'completed'
    ? completedWorkspaceHunkResult(outcome)
    : incompleteOperationResult(outcome)
}

export async function executeInteractiveOperationEffectGitIndex(
  id: string,
  channel: GitIndexEffectIpcChannel,
  toolInput: Record<string, unknown>,
  runOperation: OperationGateway,
  rootDir?: string
) {
  const context = rendererOperationContext(id)
  if (!context) return { ok: false, error: '会话不存在' }
  const toolName = gitIndexEffectToolNameForIpcChannel(channel)
  const effectInput: GitIndexEffectInput = { toolName, cwd: context.cwd, toolInput }
  const outcome = await runOperation({
    kind: 'git_index_update',
    rootDir,
    title: gitIndexOperationTitle(channel),
    sourceSessionId: id,
    ...rendererOperationOwnership(context),
    cwd: context.cwd,
    toolName,
    toolInput,
    execute: (effect) => {
      if (effect.target.kind !== 'git_index_update') throw new Error('Git index EffectTarget 类型不匹配')
      return executeGitIndexEffectTarget(effect.target, effectInput)
    },
    isSuccess: (result) => result.ok,
    resultSummary: (result) => JSON.stringify(result)
  })
  return outcome.status === 'completed'
    ? completedGitIndexResult(outcome)
    : incompleteOperationResult(outcome)
}

export async function executeInteractiveOperationEffectCopyImage(
  id: string,
  sourcePath: unknown,
  attachmentsRoot: string,
  runOperation: OperationGateway,
  rootDir?: string
) {
  const context = rendererOperationContext(id)
  if (!context) return { ok: false, error: '会话不存在' }
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) return { ok: false, error: '图片路径不能为空' }
  try {
    const prepared = await prepareImageAttachmentFile(
      isAbsolute(sourcePath) ? sourcePath : resolve(context.cwd, sourcePath)
    )
    return executePreparedImageAttachmentEffect(
      {
        sourceSessionId: id,
        ...rendererOperationOwnership(context),
        cwd: context.cwd,
        attachmentsRoot,
        rootDir
      },
      prepared,
      'user_file',
      runOperation
    )
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}

export async function executeInteractiveOperationEffectCopyDocument(
  id: string,
  sourcePath: unknown,
  attachmentsRoot: string,
  runOperation: OperationGateway,
  rootDir?: string
) {
  const context = rendererOperationContext(id)
  if (!context) return { ok: false, error: '会话不存在' }
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) return { ok: false, error: '文档路径不能为空' }
  try {
    const prepared = await prepareDocumentAttachmentFile(
      isAbsolute(sourcePath) ? sourcePath : resolve(context.cwd, sourcePath),
      context.cwd
    )
    return executePreparedDocumentAttachmentEffect(
      {
        sourceSessionId: id,
        ...rendererOperationOwnership(context),
        cwd: context.cwd,
        attachmentsRoot,
        rootDir
      },
      prepared,
      runOperation
    )
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}

export async function executeInteractiveOperationEffectSaveImageBytes(
  id: string,
  data: ImageAttachmentBytesInput,
  mime: string | undefined,
  attachmentsRoot: string,
  runOperation: OperationGateway,
  rootDir?: string
) {
  const context = rendererOperationContext(id)
  if (!context) return { ok: false, error: '会话不存在' }
  try {
    const prepared = prepareImageAttachmentBytes(data, { mime })
    return executePreparedImageAttachmentEffect(
      {
        sourceSessionId: id,
        ...rendererOperationOwnership(context),
        cwd: context.cwd,
        attachmentsRoot,
        rootDir
      },
      prepared,
      'renderer_bytes',
      runOperation
    )
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}

function rendererOperationContext(id: string): RendererOperationContext | undefined {
  const session = sessionManager.get(id)
  if (!session?.meta.cwd) return undefined
  return {
    cwd: session.meta.cwd,
    ...canonicalRendererOperationOwnership(session.meta)
  }
}

export function canonicalRendererOperationOwnership(
  meta: Pick<SessionMeta, 'workspaceId' | 'goalId' | 'workItemId'>
): Omit<RendererOperationContext, 'cwd'> {
  const workspaceId = meta.workspaceId?.trim()
  const goalId = meta.goalId?.trim()
  const workItemId = meta.workItemId?.trim()
  return {
    ...(workspaceId ? { projectId: workspaceId, workspaceId } : {}),
    ...(goalId ? { goalId } : {}),
    ...(workItemId ? { workItemId } : {})
  }
}

function rendererOperationOwnership(
  context: RendererOperationContext
): Omit<RendererOperationContext, 'cwd'> {
  return {
    ...(context.projectId ? { projectId: context.projectId } : {}),
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    ...(context.goalId ? { goalId: context.goalId } : {}),
    ...(context.workItemId ? { workItemId: context.workItemId } : {})
  }
}

function safeGitCommit(cwd: string, message: string): GitCommitResult {
  const result = gitCommit(cwd, message)
  return result.ok ? { ok: true, sha: result.sha } : { ok: false, error: result.error }
}

function completedFileWriteResult(outcome: CompletedOutcome<WriteTextFileResult>) {
  if (outcome.value?.ok) {
    return { ...outcome.value, effectStatus: outcome.effectStatus, operationId: outcome.operationId }
  }
  const target = outcome.effect.target
  if (target.kind !== 'file_content') {
    return { ok: false, error: '文件写入已确认，但 EffectTarget 类型不匹配' }
  }
  return {
    ok: true,
    path: target.relativePath,
    bytes: target.expectedBytes,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function completedGitCommitResult(outcome: CompletedOutcome<GitCommitResult>) {
  if (outcome.value?.ok) {
    return { ...outcome.value, effectStatus: outcome.effectStatus, operationId: outcome.operationId }
  }
  return {
    ok: false,
    error: 'Git commit 已通过 Effect 对账确认，但执行结果未返回 commit SHA；请刷新 Git 状态核对',
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function completedGitIndexResult(
  outcome: CompletedOutcome<ReturnType<typeof executeGitIndexEffectTarget>>
) {
  return {
    ok: true,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function completedWorkspaceHunkResult(outcome: CompletedOutcome<WorkspaceHunkResult>) {
  return {
    ok: true,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId
  }
}

function gitIndexOperationTitle(channel: GitIndexEffectIpcChannel): string {
  if (channel === 'git:stage') return '暂存所选 Git 文件'
  if (channel === 'git:stageAll') return '暂存全部 Git 改动'
  if (channel === 'git:unstage') return '取消暂存所选 Git 文件'
  return '暂存所选 Git hunk'
}

function incompleteOperationResult<T>(outcome: IncompleteOutcome<T>) {
  return {
    ok: false,
    error: outcome.error,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId,
    ...(outcome.status === 'waiting_reconciliation' ? { snapshotId: outcome.snapshotId } : {})
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
