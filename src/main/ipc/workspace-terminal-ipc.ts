import { resolveTaskExecutionEnvironment } from '../wsl/binding'
import { getSettings } from '../settings'
import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import { createHash } from 'node:crypto'
import type { TerminalStartResult } from '../../shared/terminal-operation-types'
import { terminalManager } from '../terminal'
import { startTerminalWithEffect } from '../terminalEffect'
import { getProject, listProjects } from '../projects'
import { resolveWorkspaceSessionCwd } from '../project-workspace/workspace-session-cwd'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { canonicalTerminalDirectory, normalizeWorkspaceTerminalInput } from '../terminal-workspace-policy'

const allowedDirectories = new WeakMap<WebContents, Set<string>>()
const observedOwners = new WeakSet<WebContents>()
const ownerRevisions = new WeakMap<WebContents, number>()
const pendingStarts = new Map<string, Promise<TerminalStartResult>>()

/** Called only after a trusted renderer's native directory chooser succeeds. */
export function rememberWorkspaceTerminalDirectory(sender: WebContents, directory: string): string {
  observeOwner(sender)
  const canonical = canonicalTerminalDirectory(directory)
  const allowed = allowedDirectories.get(sender) ?? new Set<string>()
  allowed.add(canonical)
  allowedDirectories.set(sender, allowed)
  return canonical
}

export function registerWorkspaceTerminalIpc(): void {
  ipcMain.handle('terminals:start-workspace', async (event, rawInput: unknown): Promise<TerminalStartResult> => {
    assertTrustedWorkflowLedgerSender(event)
    const input = normalizeWorkspaceTerminalInput(rawInput)
    const sender = event.sender
    const owner = BrowserWindow.fromWebContents(sender)
    if (!owner) return { ok: false, error: '终端宿主窗口不存在。' }
    observeOwner(sender)
    const ownerRevision = ownerRevisions.get(sender) ?? 0
    const active = (): boolean => !sender.isDestroyed() && ownerRevisions.get(sender) === ownerRevision
    const requested = input.cwd ? canonicalTerminalDirectory(input.cwd) : undefined
    let cwd: string | undefined
    if (input.projectId) {
      const project = getProject(input.projectId)
      if (!project || project.archived) throw new Error('所选项目不存在或已归档。')
      cwd = canonicalTerminalDirectory(project.path)
      if (requested && requested !== cwd) throw new Error('项目目录已变化，请重新选择项目后打开终端。')
    } else if (input.workspaceId) {
      cwd = canonicalTerminalDirectory(await resolveWorkspaceSessionCwd(input.workspaceId, app.getPath('userData')))
      if (requested && requested !== cwd) throw new Error('工作区目录不一致，请重新选择。')
    } else if (requested && (allowedDirectories.get(sender)?.has(requested) || isSavedProjectDirectory(requested))) {
      cwd = requested
    }
    if (!cwd) {
      const picked = await dialog.showOpenDialog(owner, { title: '选择终端工作目录', properties: ['openDirectory', 'createDirectory'], ...(requested ? { defaultPath: requested } : {}) })
      if (picked.canceled || !picked.filePaths.length) return { ok: false, cancelled: true, error: '已取消选择终端目录。' }
      if (!active()) return { ok: false, error: '终端窗口已关闭或刷新。' }
      cwd = rememberWorkspaceTerminalDirectory(sender, picked.filePaths[0])
    }
    if (!active()) return { ok: false, error: '终端窗口已关闭或刷新。' }
    const executionEnvironment = resolveTaskExecutionEnvironment({ cwd, preferences: getSettings().wsl })
    const startKey = `${sender.id}\0${ownerRevision}\0${cwd}\0${JSON.stringify(executionEnvironment)}`
    const pending = pendingStarts.get(startKey)
    if (pending) return pending
    const operation = startTerminalWithEffect({
      sourceSessionId: `workspace-terminal:${sender.id}:${createHash('sha256').update(cwd).digest('hex').slice(0, 24)}`,
      projectId: input.projectId, workspaceId: input.workspaceId, cwd, executionEnvironment, standalone: true, ownerWebContentsId: sender.id,
      assertActive: () => { if (!active()) throw new Error('终端窗口已关闭或刷新。') }
    }, terminalManager, { cols: input.cols, rows: input.rows, reuse: input.reuse }).then((result) => {
      if (!active() && result.ok) { terminalManager.close(result.terminal.id); return { ok: false as const, error: '终端窗口已关闭或刷新。' } }
      return result
    }).finally(() => pendingStarts.delete(startKey))
    pendingStarts.set(startKey, operation)
    return operation
  })
}
function isSavedProjectDirectory(cwd: string): boolean {
  return listProjects().some((project) => {
    try { return !project.archived && canonicalTerminalDirectory(project.path) === cwd } catch { return false }
  })
}
function observeOwner(sender: WebContents): void {
  if (observedOwners.has(sender)) return
  observedOwners.add(sender)
  ownerRevisions.set(sender, 0)
  const ownerId = sender.id
  const dispose = (): void => {
    ownerRevisions.set(sender, (ownerRevisions.get(sender) ?? 0) + 1)
    allowedDirectories.delete(sender)
    for (const terminal of terminalManager.list()) if (terminal.ownerWebContentsId === ownerId) terminalManager.close(terminal.id)
  }
  sender.once('destroyed', dispose)
  sender.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) dispose() })
}
