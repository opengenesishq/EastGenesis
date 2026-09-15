import { ipcMain } from 'electron'
import { dirname } from 'node:path'
import {
  acceptMemoryDraft,
  deleteMemoryEntry,
  proposeMemoryDraft,
  readProjectMemory,
  type ProjectMemoryDraftInput,
  type ProjectMemoryTarget
} from '../memoryStore'
import { createTrustedUserLearningDecision } from '../learning/learning-security'
import { verifyProductionProjectMutation } from '../project-aggregate/project-mutation-ingress'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { importLegacyProjectMemory, previewLegacyProjectMemory } from '../memory/legacy-memory-import'
import type { LegacyMemoryImportInput } from '../../shared/legacy-memory-import-types'

export interface ProjectMemoryIpcOptions {
  memoryRoot: () => string
  targetForSession: (sessionId: string) => ProjectMemoryTarget | null
}

export function registerProjectMemoryIpc(options: ProjectMemoryIpcOptions): void {
  ipcMain.handle('memory:legacyPreview', async (event, sessionId: string) => {
    assertTrustedWorkflowLedgerSender(event)
    const target = requiredTarget(options, sessionId)
    const preview = await previewLegacyProjectMemory(target, options.memoryRoot())
    assertTargetUnchanged(options, sessionId, target)
    return preview
  })
  ipcMain.handle('memory:legacyImport', (event, sessionId: string, input: LegacyMemoryImportInput) => {
    assertTrustedWorkflowLedgerSender(event)
    return verifiedMemoryMutation(options, sessionId, (target, root) => importLegacyProjectMemory(target, root, input,
      () => assertTargetUnchanged(options, sessionId, target)))
  })
  ipcMain.handle('memory:read', (event, sessionId: string) => {
    assertTrustedWorkflowLedgerSender(event)
    const target = options.targetForSession(sessionId)
    return target
      ? readProjectMemory(target, options.memoryRoot())
      : { projectHash: '', markdown: '', entries: [], drafts: [] }
  })
  ipcMain.handle('memory:propose', (event, sessionId: string, input: ProjectMemoryDraftInput) => {
    assertTrustedWorkflowLedgerSender(event)
    return verifiedMemoryMutation(options, sessionId, (target, root) => proposeMemoryDraft(target, root, input))
  })
  ipcMain.handle('memory:accept', (event, sessionId: string, draftId: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return verifiedMemoryMutation(options, sessionId, (target, root) => acceptMemoryDraft(
      target, root, draftId, createTrustedUserLearningDecision('ipc:memory:accept')
    ))
  })
  ipcMain.handle('memory:delete', (event, sessionId: string, entryId: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return verifiedMemoryMutation(options, sessionId, (target, root) => deleteMemoryEntry(
      target, root, entryId, createTrustedUserLearningDecision('ipc:memory:delete')
    ))
  })
}

async function verifiedMemoryMutation<T>(
  options: ProjectMemoryIpcOptions,
  sessionId: string,
  mutation: (target: ProjectMemoryTarget, root: string) => Promise<T>
): Promise<T> {
  const target = requiredTarget(options, sessionId)
  const root = options.memoryRoot()
  const result = await mutation(target, root)
  if (target.projectId) await verifyProductionProjectMutation(dirname(root), target.projectId)
  return result
}

function requiredTarget(options: ProjectMemoryIpcOptions, sessionId: string): ProjectMemoryTarget {
  const target = options.targetForSession(sessionId)
  if (!target) throw new Error('会话不存在')
  return target
}

function assertTargetUnchanged(options: ProjectMemoryIpcOptions, sessionId: string, target: ProjectMemoryTarget): void {
  const current = requiredTarget(options, sessionId)
  if (current.projectId !== target.projectId || current.projectRoot !== target.projectRoot) {
    throw new Error('当前任务的项目或目录已变化，请重新预览旧记忆。')
  }
}
