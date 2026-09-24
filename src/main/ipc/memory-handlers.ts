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
import { withDataLifecycleMutation } from '../data-lifecycle/data-lifecycle-mutation-lock'
import { previewMemoryRetention, readMemoryRetention, saveMemoryRetention } from '../memory/memory-retention'
import type { MemoryRetentionInput, MemoryRetentionSaveInput } from '../../shared/memory-retention-types'
import type { SessionMeta } from '../../shared/types'
import { withTaskMemoryPreferences } from '../memory/memory-preferences'
import {
  addMemory, archiveStaleMemories, deleteMemory, exportMemories, listMemories, searchMemories, updateMemory,
  type MemoryScope, type MemorySearchInput, type MemoryUpdateInput
} from '../memory/memory-manager'

export interface ProjectMemoryIpcOptions {
  memoryRoot: () => string
  targetForSession: (sessionId: string) => ProjectMemoryTarget | null
  taskScopeForSession: (sessionId: string) => Promise<MemoryScope>
  metaForSession: (sessionId: string) => SessionMeta | undefined
}

export function registerProjectMemoryIpc(options: ProjectMemoryIpcOptions): void {
  ipcMain.handle('memory:retentionRead', async (event, sessionId: string) => {
    assertTrustedWorkflowLedgerSender(event)
    requiredTarget(options, sessionId)
    return readMemoryRetention(options.memoryRoot(), await options.taskScopeForSession(sessionId))
  })
  ipcMain.handle('memory:retentionPreview', (event, sessionId: string, input: MemoryRetentionInput) => {
    assertTrustedWorkflowLedgerSender(event)
    requiredTarget(options, sessionId)
    return withLayeredMemoryScope(options, sessionId, (scope, root) => previewMemoryRetention(root, scope, input))
  })
  ipcMain.handle('memory:retentionSave', (event, sessionId: string, input: MemoryRetentionSaveInput) => {
    assertTrustedWorkflowLedgerSender(event)
    requiredTarget(options, sessionId)
    return withLayeredMemoryScope(options, sessionId, (scope, root) => saveMemoryRetention(root, scope, input))
  })
  const scopeFor = async (sessionId?: string): Promise<MemoryScope> => sessionId === undefined
    ? {}
    : options.taskScopeForSession(sessionId)
  ipcMain.handle('memory:taskAdd', async (event, sessionId: string, input: { title: string; body: string }) => {
    assertTrustedWorkflowLedgerSender(event)
    return withLayeredMemoryScope(options, sessionId, (scope, root) => {
      requiredTarget(options, sessionId)
      if (!scope.sessionId) throw new Error('必须指定当前任务')
      return addMemory(root, { ...scope, layer: 'working', title: input?.title, body: input?.body, source: 'user' })
    })
  })
  ipcMain.handle('memory:layeredList', async (event, sessionId?: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return listMemories(options.memoryRoot(), await scopeFor(sessionId))
  })
  ipcMain.handle('memory:layeredSearch', async (event, sessionId: string | undefined, input: MemorySearchInput) => {
    assertTrustedWorkflowLedgerSender(event)
    const scope = await scopeFor(sessionId)
    return searchMemories(options.memoryRoot(), {
      query: input?.query, layers: input?.layers, limit: input?.limit, includeArchived: input?.includeArchived,
      ...scope
    })
  })
  ipcMain.handle('memory:layeredArchive', (event, olderThanDays?: number) => {
    assertTrustedWorkflowLedgerSender(event)
    return archiveStaleMemories(options.memoryRoot(), olderThanDays)
  })
  ipcMain.handle('memory:layeredExport', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return exportMemories(options.memoryRoot())
  })
  ipcMain.handle('memory:layeredUpdate', async (event, entryId: string, input: MemoryUpdateInput, sessionId?: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return withLayeredMemoryScope(options, sessionId, (scope, root) => updateMemory(root, entryId, input ?? {}, scope))
  })
  ipcMain.handle('memory:layeredDelete', async (event, entryId: string, sessionId?: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return withLayeredMemoryScope(options, sessionId, (scope, root) => deleteMemory(root, entryId, scope))
  })
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

function withLayeredMemoryScope<T>(
  options: ProjectMemoryIpcOptions,
  sessionId: string | undefined,
  operation: (scope: MemoryScope, root: string) => Promise<T>
): Promise<T> {
  const root = options.memoryRoot()
  // Resolve the current writer after acquiring the deletion lock. Completed
  // deletion receipts may compact, but a closed/removed caller cannot survive this read.
  return withTaskMemoryPreferences(() => sessionId === undefined ? {} : requiredMeta(options, sessionId), () =>
    withDataLifecycleMutation(dirname(root), async () =>
      operation(sessionId === undefined ? {} : await options.taskScopeForSession(sessionId), root)))
}

async function verifiedMemoryMutation<T>(
  options: ProjectMemoryIpcOptions,
  sessionId: string,
  mutation: (target: ProjectMemoryTarget, root: string) => Promise<T>
): Promise<T> {
  const target = requiredTarget(options, sessionId)
  const root = options.memoryRoot()
  const result = await withTaskMemoryPreferences(() => requiredMeta(options, sessionId), () => mutation(target, root))
  if (target.projectId) await verifyProductionProjectMutation(dirname(root), target.projectId)
  return result
}

function requiredMeta(options: ProjectMemoryIpcOptions, id: string): SessionMeta {
  const meta = options.metaForSession(id)
  if (!meta || meta.status === 'closed') throw new Error('当前任务不存在或已关闭')
  return meta
}

function requiredTarget(options: ProjectMemoryIpcOptions, sessionId: string): ProjectMemoryTarget {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('必须指定当前任务')
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
