import { workspaceHandoffView } from '../workspace-handoff'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { WorktreePullRequestDraftSubmitInput } from '../../shared/worktree-pr-draft-types'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { desktopWindowRole } from '../desktop-window-registry'
import { taskSessionForWindow } from '../task-window'
import type { CheckpointRestoreMode } from '../../shared/types'
import { sessionManager } from '../sessionManager'
import { assertTaskExecutionEnvironment } from '../wsl/binding'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'
import { registerExportedWorktreePatch } from '../task/worktree-patch-artifact'
import { createManagedWorktreeMergePatch, exportManagedWorktreePatch } from '../worktrees'
import {
  executeInteractiveOperationEffectDiscardHunk,
  executeInteractiveOperationEffectGitCommit,
  executeInteractiveOperationEffectGitIndex,
  executeInteractiveOperationEffectWriteFile
} from './renderer-mutation-handlers'
import {
  executeInteractiveOperationEffectApplyPatch,
  executeInteractiveOperationEffectCreatePr,
  executeInteractiveOperationEffectRemoveWorktree
} from './worktree-operation-handlers'

export function registerInteractiveMutationIpc(): void {
  registerCheckpointMutationIpc()
  registerGitMutationIpc()
  registerWorktreeMutationIpc()
  registerFileMutationIpc()
}

function registerCheckpointMutationIpc(): void {
  ipcMain.handle('sessions:rewindFiles', async (_event, id: string, messageId: string, dryRun: boolean) => {
    const session = sessionManager.get(id)
    if (!session?.rewindFiles) return { canRewind: false, error: '会话不存在或引擎不支持' }
    assertTaskExecutionEnvironment(session.meta)
    if (dryRun !== true) await authorize(id, '回溯文件')
    return sessionManager.rewindFiles(id, messageId, dryRun === true)
  })
  ipcMain.handle(
    'sessions:restoreCheckpoint',
    async (_event, id: string, messageId: string, mode: CheckpointRestoreMode, dryRun: boolean) => {
      const session = sessionManager.get(id)
      const safeMode = checkpointMode(mode)
      if (!session?.restoreCheckpoint) return unavailableCheckpoint(messageId, safeMode)
      assertTaskExecutionEnvironment(session.meta)
      if (session.meta.status === 'running' || session.meta.status === 'starting') {
        return runningCheckpoint(messageId, safeMode)
      }
      if (dryRun !== true && safeMode !== 'chat') await authorize(id, '恢复代码检查点')
      return sessionManager.restoreCheckpoint(id, messageId, safeMode, dryRun === true)
    }
  )
}

function registerGitMutationIpc(): void {
  ipcMain.handle('git:stage', (_event, id: string, paths: string[]) =>
    runGitIndex(id, 'git:stage', { paths }, '暂存 Git 文件'))
  ipcMain.handle('git:stageAll', (_event, id: string) =>
    runGitIndex(id, 'git:stageAll', {}, '暂存全部 Git 改动'))
  ipcMain.handle('git:unstage', (_event, id: string, paths: string[]) =>
    runGitIndex(id, 'git:unstage', { paths }, '取消暂存 Git 文件'))
  ipcMain.handle('git:commit', async (_event, id: string, message: string) => {
    await authorize(id, '提交 Git 改动')
    return executeInteractiveOperationEffectGitCommit(
      id, message, executeInteractiveOperationEffect, app.getPath('userData')
    )
  })
  ipcMain.handle('workspace:applyHunk', (_event, id: string, filePath: string, hunkPatch: string) =>
    runGitIndex(id, 'workspace:applyHunk', { filePath, hunkPatch }, '暂存工作区 hunk'))
  ipcMain.handle('workspace:discardHunk', async (_event, id: string, filePath: string, hunkPatch: string) => {
    await authorize(id, '丢弃工作区 hunk')
    return executeInteractiveOperationEffectDiscardHunk(
      id, filePath, hunkPatch, executeInteractiveOperationEffect, app.getPath('userData')
    )
  })
}

function registerWorktreeMutationIpc(): void {
  ipcMain.handle('worktrees:handoff-state', (_event, id: string) => {
    const session = sessionManager.get(id)
    if (!session) throw new Error('任务不存在或已关闭。')
    return workspaceHandoffView(session.meta)
  })
  ipcMain.handle('worktrees:handoff', async (_event, id: string) => {
    await authorize(id, '交接工作目录')
    return sessionManager.handoffWorkspace(id)
  })
  ipcMain.handle('worktrees:exportPatch', async (_event, id: string) => {
    await authorize(id, '导出 worktree patch')
    const session = sessionManager.get(id)
    const projectId = session?.meta.workspaceId ?? session?.meta.projectId
    const creatingRun = sessionManager.getTaskRun(id)
    if (!projectId || !creatingRun) {
      return { ok: false, error: '导出 Patch 需要当前会话的规范任务与运行归属' }
    }
    const exported = exportManagedWorktreePatch(id)
    if (!exported.ok) return exported
    return registerExportedWorktreePatch({
      sessionId: id,
      projectId,
      creatingRunId: creatingRun.id,
      rootInput: { workflowRoot: app.getPath('userData'), workspaceRoot: app.getPath('userData') }
    }, exported)
  })
  ipcMain.handle('worktrees:mergePatch', async (_event, id: string) => {
    await authorize(id, '生成 worktree 合并 patch')
    return createManagedWorktreeMergePatch(id)
  })
  ipcMain.handle('worktrees:applyPatch', async (_event, id: string) => {
    await authorize(id, '应用 worktree patch')
    return executeInteractiveOperationEffectApplyPatch(id, executeInteractiveOperationEffect)
  })
  ipcMain.handle('worktrees:createPr', async (event, id: string, input?: WorktreePullRequestDraftSubmitInput) => {
    const trusted = (): void => {
      assertTrustedWorkflowLedgerSender(event)
      const window = BrowserWindow.fromWebContents(event.sender), role = window && desktopWindowRole(window)
      if (!window || window.isDestroyed() || (role !== 'main' && role !== 'task') || role === 'task' && taskSessionForWindow(window) !== id) throw new Error('请从主工作台或原任务窗口提交 PR。')
    }
    trusted()
    await authorize(id, '创建 Pull Request')
    trusted()
    return executeInteractiveOperationEffectCreatePr(id, executeInteractiveOperationEffect, input)
  })
  ipcMain.handle('worktrees:remove', async (_event, id: string, options?: { deleteBranch?: boolean; force?: boolean }) => {
    await authorize(id, '移除 worktree')
    return executeInteractiveOperationEffectRemoveWorktree(id, options ?? {}, executeInteractiveOperationEffect)
  })
}

function registerFileMutationIpc(): void {
  ipcMain.handle('files:write', async (_event, id: string, relativePath: string, content: string) => {
    await authorize(id, '保存项目文件')
    return executeInteractiveOperationEffectWriteFile(
      id, relativePath, content, executeInteractiveOperationEffect, app.getPath('userData')
    )
  })
}

async function runGitIndex(
  id: string,
  channel: 'git:stage' | 'git:stageAll' | 'git:unstage' | 'workspace:applyHunk',
  input: Record<string, unknown>,
  title: string
) {
  await authorize(id, title)
  return executeInteractiveOperationEffectGitIndex(
    id, channel, input, executeInteractiveOperationEffect, app.getPath('userData')
  )
}

async function authorize(sessionId: string, title: string): Promise<void> {
  const original = sessionManager.get(sessionId)?.meta
  if (original) assertTaskExecutionEnvironment(original)
  await sessionManager.assertInteractiveExecutionAuthorized(sessionId, title)
  const current = sessionManager.get(sessionId)?.meta
  if (current) assertTaskExecutionEnvironment(current)
}

function checkpointMode(mode: CheckpointRestoreMode): CheckpointRestoreMode {
  return mode === 'chat' || mode === 'both' || mode === 'code' ? mode : 'code'
}

function unavailableCheckpoint(checkpointId: string, mode: CheckpointRestoreMode) {
  return { mode, checkpointId, canRewind: false, applied: false, error: '会话不存在或引擎不支持' }
}

function runningCheckpoint(checkpointId: string, mode: CheckpointRestoreMode) {
  return { mode, checkpointId, canRewind: false, applied: false, error: '会话仍在运行,请停止后再回溯' }
}
