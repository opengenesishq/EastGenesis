import { attachmentRoot, isInsideAttachmentRoot, normalizeSendPayload } from './ipc/session-message-input'
﻿import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { sessionManager } from './sessionManager'
import { getTaskSnapshot } from './task/task-snapshot'
import type { EffectResolution } from '../shared/effect-recovery-types'
import { sessionReadyHandler } from './ipc/session-ready-handler'
import { previewOutboundContext } from './project-workspace/outbound-context-policy'
import { applySessionModelSwitch } from './ipc/session-model-switch-handler'
import { createUnassignedSession } from './ipc/unassigned-session'
import { resolveWorkspaceSessionCwd } from './project-workspace/workspace-session-cwd'
import { activateLocalCompute } from './provider/localCompute'
import { queryProviderUsage } from './provider/providerUsage'
import { removeProviderAuthorizations } from './provider/providerAuthorizationService'
import { registerProviderAuthorizationIpc } from './ipc/provider-authorization-handlers'
import { registerProviderBillingIpc } from './ipc/provider-billing-handlers'
import { registerProviderGatewayIpc } from './ipc/provider-gateway-handlers'
import { inspectProviderBalance, queryProviderBalance } from './provider/providerBalanceService'
import { fetchProviderPricingCatalog } from './provider/providerPricingCatalog'
import { registerInteractiveMutationIpc } from './ipc/interactive-mutation-handlers'
import { registerAppFeatureIpc } from './ipc/app-feature-handlers'
import { registerSettingsDomainIpc } from './ipc/settings-domain-handlers'
import {
  revokeGuiAutomationGrantsForSession,
  revokeToolCapabilityGrantsForSession
} from './permission/permission-manager'
import {
  createNotificationConnector,
  deleteNotificationConnector,
  listNotificationConnectors,
  setDefaultNotificationConnector
} from './notification/notification-connector-store'
import { listHistory, renameHistory, setHistoryArchived, setHistoryPinned } from './history'
import { searchTranscripts } from './transcriptSearch'
import {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  fetchModels,
  probeProviderGeneration
} from './providers'
import { listHealth } from './scheduler'
import { listEngines } from './engine'
import { scanMigration } from './migration'
import {
  executeMigrationApplyEffect,
  executeMigrationImportEffect,
  executeMigrationRollbackEffect
} from './migrationEffect'
import { configureMigrationOperationBackupRoot } from './migration-operation-effect'
import { listProjects, updateProject, deleteProject } from './projects'
import {
  generateProjectContextTemplate,
  readProjectContext
} from './agent/context-loader'
import { registerProjectMemoryIpc } from './ipc/memory-handlers'
import { readProjectMemory } from './memoryStore'
import {
  archiveStaleMemories,
  deleteMemory as deleteLayeredMemoryEntry,
  exportMemories,
  listMemories,
  searchMemories,
  updateMemory as updateLayeredMemoryEntry,
  type MemorySearchInput,
  type MemoryUpdateInput
} from './memory/memory-manager'
import { writeExtractedMemory } from './memory/memory-writer'
import { shouldProposeMemory } from './memoryInject'
import { suggestFiles } from './fileSuggest'
import { registerFileIntelligenceIpc } from './ipc/file-intelligence-handlers'
import { registerPermissionGrantIpc } from './ipc/permission-grant-handlers'
import { preparePreview } from './previewOps'
import { prepareOfficeVisualPreview } from './previewVisual'
import { listPreviewAnnotations, savePreviewAnnotation } from './previewAnnotations'
import { gitStatus } from './gitOps'
import { getWorkspaceDiff } from './gitDiff'
import { getStartSuggestions, type StartSuggestionSignal } from './startSuggestions'
import {
  checkManagedWorktreeApply, getManagedWorktreeSummary,
  getWorktreeConflictFiles, inspectManagedWorktreeMerge,
  listWorktreeMergeReceipts
} from './worktrees'
import { fallbackEffectIntentDescription, fallbackEffectTargetDescription } from './ipc/effect-descriptions'
import { resolveTaskSnapshotEffect } from './ipc/effect-resolution'
import { registerTaskRecoveryIpc } from './ipc/task-recovery-handlers'
import { assertTrustedWorkflowLedgerSender, registerWorkflowLedgerIpc } from './ipc/workflow-ledger-handlers'
import { registerProjectWorkspaceIpc } from './ipc/project-workspace-handlers'
import { registerDataRetentionIpc } from './ipc/data-retention-handlers'
import { registerDigitalWorkerIpc } from './ipc/digital-worker-handlers'
import { registerSupervisorIpc } from './ipc/supervisor-handlers'
import { registerLearningIpc } from './ipc/learning-handlers'
import { registerAttachmentMutationIpc } from './ipc/attachment-mutation-ipc'
import { registerProjectContextMutationIpc } from './ipc/project-context-mutation-ipc'
import { registerMcpProbeIpc } from './ipc/mcp-probe-ipc'
import { registerPluginInstallIpc } from './ipc/plugin-install-ipc'
import { registerTerminalMutationIpc } from './ipc/terminal-mutation-ipc'
import { registerBrowserMutationIpc } from './ipc/browser-mutation-ipc'
import { registerAssistantSearchIpc } from './ipc/assistant-search-handlers'
import { executeInteractiveOperationEffect } from './task/operation-effect-gateway'
import { executeProviderOperationEffect } from './provider/providerOperationEffect'
import { terminalManager } from './terminal'
import { browserViewManager } from './browserView'
import { ocrImage } from './imageOcr'
import {
  approvePluginRegistryItem,
  pluginRegistryItemKey,
  readPluginRegistryState,
  scanPluginRegistry,
  setPluginRegistryItemEnabled,
  writePluginRegistryState
} from './pluginRegistry'
import {
  caogenExtensionRegistryRoots,
  caogenManagedPluginsRoot
} from './plugin/caogen-extension-roots'
import { listRoutines, markRun, updateRoutine, createRoutine, deleteRoutine } from './routineStore'
import { runRoutineNow } from './routines/routine-executor'
import { listRoutineRuns } from './routines/routine-runner'
import { reviewRoutineRun } from './routines/routine-review'
import { listRoutineTemplates } from './routines/routine-templates'
import { registerQuickbarIpc } from './quickbar'
import { registerPalaceSceneBuilderIpc } from './ipc/palace-scene-builder-handlers'
import { registerSessionInputIpc } from './ipc/session-input-handlers'
import { registerPreparationPermissionIpc } from './ipc/preparation-permission-handlers'
import { registerTaskExecutionAuthorityIpc } from './ipc/task-execution-authority-handlers'
import { registerCouncilIpc } from './ipc/council-handlers'
import type {
  BrowserBounds,
  BrowserPickResult,
  CreateRoutineInput,
  CreateSessionOptions,
  NotificationConnectorInput,
  DispatchSubagentsInput,
  DocumentAttachmentView,
  EffectRecord,
  ImageAttachmentView,
  RoutineRunReviewInput,
  MarkRunOptions,
  PermissionModeId,
  PreviewAnnotationInput,
  PluginRegistryItem,
  PluginRegistryScanOptions,
  MigrationApplyInput,
  ProviderInput,
  ProviderGenerationProbeInput,
  ProviderModelFetchInput,
  SendMessagePayload,
  TaskDagDispatchInput,
  TaskDecomposeInput,
  TaskSnapshotRecord,
  UpdateRoutineInput
} from '../shared/types'

let terminalEventsRegistered = false
let browserEventsRegistered = false
const MEMORY_SUGGESTION_COOLDOWN_MS = 30_000
const MEMORY_SUGGESTION_MAX_RECENT = 500

const recentMemorySuggestions = new Map<string, number>()

function shouldEmitMemorySuggestion(sessionId: string, text: string, now = Date.now()): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().slice(0, 500)
  if (!normalized) return false
  if (recentMemorySuggestions.size > MEMORY_SUGGESTION_MAX_RECENT) {
    for (const [key, at] of recentMemorySuggestions) {
      if (now - at > MEMORY_SUGGESTION_COOLDOWN_MS) recentMemorySuggestions.delete(key)
    }
  }
  const key = `${sessionId}\n${normalized}`
  const lastAt = recentMemorySuggestions.get(key)
  if (lastAt !== undefined && now - lastAt < MEMORY_SUGGESTION_COOLDOWN_MS) return false
  recentMemorySuggestions.set(key, now)
  return true
}

function isPluginRegistryItem(value: unknown): value is PluginRegistryItem {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    (record.kind === 'plugin' || record.kind === 'skill' || record.kind === 'agent' || record.kind === 'mcp') &&
    typeof record.name === 'string' &&
    typeof record.sourceRoot === 'string' &&
    typeof record.path === 'string'
  )
}

function pluginRegistryRoots(sessionId?: string): string[] {
  const session = typeof sessionId === 'string' ? sessionManager.get(sessionId) : undefined
  const projectCwds = [session?.meta.sourceCwd, session?.meta.cwd].filter(
    (cwd): cwd is string => typeof cwd === 'string' && cwd.trim().length > 0
  )
  return caogenExtensionRegistryRoots(projectCwds)
}

function normalizePluginScanOptions(options?: PluginRegistryScanOptions): PluginRegistryScanOptions {
  return {
    maxFiles: clampPositiveInt(options?.maxFiles, 3000, 5000),
    maxDepth: clampPositiveInt(options?.maxDepth, 6, 12),
    maxReadBytes: clampPositiveInt(options?.maxReadBytes, 256 * 1024, 1024 * 1024),
    managedRoot: caogenPluginsRoot()
  }
}

/** CaoGen 托管插件目录:本地安装/卸载的唯一操作区 */
function caogenPluginsRoot(): string {
  return caogenManagedPluginsRoot()
}

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback
  return Math.min(max, Math.max(1, Math.floor(value)))
}

function routineStoreRoot(): string {
  return join(app.getPath('userData'), 'routines')
}

function previewAnnotationRoot(): string {
  return join(app.getPath('userData'), 'preview-annotations')
}

function pluginRegistryStateFile(): string {
  return join(app.getPath('userData'), 'plugin-registry-state.json')
}

function migrationBackupRoot(): string {
  return join(app.getPath('userData'), 'private', 'migration-backups')
}

function canRevealPluginPath(targetPath: string, sessionId?: string): boolean {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) return false
  const target = resolve(targetPath)
  for (const root of pluginRegistryRoots(sessionId)) {
    const resolvedRoot = resolve(root)
    if (isInsidePath(resolvedRoot, target)) return true
  }
  return false
}

function findScannedPluginRegistryItem(item: PluginRegistryItem, sessionId?: string): PluginRegistryItem | undefined {
  const state = readPluginRegistryState(pluginRegistryStateFile())
  const view = scanPluginRegistry(pluginRegistryRoots(sessionId), normalizePluginScanOptions(), state)
  const key = pluginRegistryItemKey(item)
  return view.items.find((candidate) => pluginRegistryItemKey(candidate) === key)
}

function mcpProbeOperationContext(sessionId?: string): {
  sourceSessionId: string
  projectId?: string
  cwd: string
} {
  const session = typeof sessionId === 'string' ? sessionManager.get(sessionId) : undefined
  return {
    sourceSessionId: session?.meta.id ?? 'mcp-probe:settings',
    projectId: session?.meta.projectId,
    cwd: session?.meta.cwd ?? homedir()
  }
}

function isInsidePath(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function effectTargetDescription(effect: EffectRecord): string {
  if (effect.target.kind === 'file_content') return effect.target.relativePath
  if (effect.target.kind === 'git_commit') {
    return `${effect.target.branch} @ ${effect.target.preHead.slice(0, 12)}`
  }
  if (effect.target.kind === 'git_merge') {
    return `${effect.target.destinationRef} <- ${effect.target.sourceRef} @ ${effect.target.sourceSha.slice(0, 12)}`
  }
  if (effect.target.kind === 'git_push') {
    return `${effect.target.remote}/${effect.target.branch} -> ${effect.target.intendedSha.slice(0, 12)}`
  }
  return fallbackEffectTargetDescription(effect)
}

function effectIntentDescription(snapshot: TaskSnapshotRecord, effect: EffectRecord): string {
  if (effect.target.kind === 'file_content') {
    return `write ${effect.target.expectedBytes} bytes · sha256 ${effect.target.expectedSha256.slice(0, 16)}`
  }
  if (effect.target.kind === 'git_commit') {
    return `staged ${effect.target.stagedDiffDigest.slice(0, 16)} · message ${effect.target.messageDigest.slice(0, 16)}`
  }
  if (effect.target.kind === 'git_merge') {
    return `${effect.target.mode} · parents ${effect.target.preHead.slice(0, 12)} + ${effect.target.sourceSha.slice(0, 12)}`
  }
  if (effect.target.kind === 'git_push') return `push ${effect.target.intendedSha.slice(0, 12)}`
  return fallbackEffectIntentDescription(snapshot, effect)
}

export function registerIpc(): void {
  registerPreparationPermissionIpc()
  registerTaskExecutionAuthorityIpc()
  registerSessionInputIpc()
  registerCouncilIpc()
  configureMigrationOperationBackupRoot(migrationBackupRoot())
  for (const register of [registerQuickbarIpc, registerTaskRecoveryIpc, registerWorkflowLedgerIpc, registerProjectWorkspaceIpc, registerDataRetentionIpc, registerDigitalWorkerIpc, registerSupervisorIpc, registerInteractiveMutationIpc, registerAppFeatureIpc, registerProviderGatewayIpc, registerFileIntelligenceIpc, registerPermissionGrantIpc, registerPalaceSceneBuilderIpc]) register()
  // Search adapters are resolved only by an explicit main-process factory. The
  // default production wiring therefore fails closed with no_credentials until
  // a provider-aware factory is intentionally supplied.
  registerAssistantSearchIpc()
  registerAttachmentMutationIpc(attachmentRoot)
  registerProjectContextMutationIpc()
  registerMcpProbeIpc({
    findScannedItem: findScannedPluginRegistryItem,
    operationContext: mcpProbeOperationContext
  })
  registerPluginInstallIpc({ pluginsRoot: caogenPluginsRoot })
  registerTerminalMutationIpc({
    assertExecutionAuthorized: (id, action) => sessionManager.assertInteractiveExecutionAuthorized(id, action),
    getSessionMeta: (id) => sessionManager.get(id)?.meta,
    manager: terminalManager
  })
  registerBrowserMutationIpc({
    getSessionMeta: (id) => sessionManager.get(id)?.meta,
    manager: browserViewManager
  })

  ipcMain.handle('sessions:list', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return sessionManager.list()
  })

  ipcMain.handle('sessions:pendingPermissions', (_e, id: string) =>
    sessionManager.get(id)?.pendingPermissions() ?? []
  )

  ipcMain.handle('sessions:transcript', (_e, id: string) => sessionManager.getTranscript(id))

  ipcMain.handle(
    'taskSnapshots:resolveEffect',
    async (
      event,
      snapshotId: string,
      effectId: string,
      expectedRevision: number,
      resolution: EffectResolution,
      note?: string
    ) => {
      return resolveTaskSnapshotEffect(event.sender, snapshotId, effectId, expectedRevision, resolution, {
        listTaskSnapshots: () => sessionManager.listTaskSnapshots(),
        getTaskSnapshot: id => getTaskSnapshot(id),
        resolveTaskEffect: (...args) => sessionManager.resolveTaskEffect(...args),
        updateWorktreeState: (sessionId, state) => sessionManager.updateWorktreeState(sessionId, state),
        describeTarget: effectTargetDescription,
        describeIntent: effectIntentDescription
      }, note)
    }
  )

  ipcMain.handle('sessions:suggestFiles', (_e, id: string, query: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    return cwd ? suggestFiles(cwd, typeof query === 'string' ? query : '') : []
  })

  ipcMain.handle('git:status', (_e, id: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) {
      return {
        ok: false,
        cwd: '',
        branch: '',
        files: [],
        staged: 0,
        unstaged: 0,
        untracked: 0,
        error: '会话不存在'
      }
    }
    return gitStatus(cwd)
  })

  ipcMain.handle('workspace:diff', (_e, id: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) {
      return { ok: false, cwd: '', files: [], rawBytes: 0, error: '会话不存在' }
    }
    return getWorkspaceDiff(cwd)
  })

  ipcMain.handle('worktrees:summary', (_e, id: string) => getManagedWorktreeSummary(id))

  ipcMain.handle('worktrees:mergeInspect', (_e, id: string) => inspectManagedWorktreeMerge(id))

  ipcMain.handle('worktrees:applyCheck', (_e, id: string) => checkManagedWorktreeApply(id))

  // 冲突三栏:apply-check 被拒时,取冲突文件的 基线/worktree/主工作区 三份内容。
  ipcMain.handle('worktrees:conflictFiles', (_e, id: string) => getWorktreeConflictFiles(id))

  // 合并回执列表(最新在前),验收"上次到底合了什么"。
  ipcMain.handle('worktrees:mergeReceipts', () => listWorktreeMergeReceipts())

  ipcMain.handle('preview:prepare', (_e, id: string, relPath: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) return { ok: false, error: '会话不存在' }
    return preparePreview(cwd, typeof relPath === 'string' ? relPath : '')
  })

  ipcMain.handle('preview:prepareVisual', (_e, id: string, relPath: string) => {
    const cwd = sessionManager.get(id)?.meta.cwd
    if (!cwd) return { ok: false, source: 'quick-look', fidelity: 'first-page-thumbnail', error: '会话不存在' }
    return prepareOfficeVisualPreview(cwd, typeof relPath === 'string' ? relPath : '')
  })

  ipcMain.handle('preview:saveAnnotation', (_e, id: string, input: PreviewAnnotationInput) => {
    if (!sessionManager.get(id)) throw new Error('会话不存在')
    return savePreviewAnnotation(previewAnnotationRoot(), id, input)
  })

  ipcMain.handle('preview:listAnnotations', (_e, id: string, relPath?: string) => {
    if (!sessionManager.get(id)) return []
    return listPreviewAnnotations(
      previewAnnotationRoot(),
      id,
      typeof relPath === 'string' && relPath.trim() ? relPath : undefined
    )
  })

  if (!browserEventsRegistered) {
    browserEventsRegistered = true
    browserViewManager.subscribe((event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('browser:event', event)
      }
    })
  }

  ipcMain.handle('browser:captureAnnotation', (_e, id: string, note: string) =>
    browserViewManager.captureAnnotation(id, typeof note === 'string' ? note : '')
  )

  ipcMain.handle('browser:listAnnotations', (_e, id: string) =>
    browserViewManager.listAnnotations(id)
  )

  // DOM 圈选:注入拾取器等用户点选;随后按结果截图落批注
  ipcMain.handle('browser:pickElement', (_e, id: string) => browserViewManager.pickElement(id))

  ipcMain.handle(
    'browser:captureElementAnnotation',
    (_e, id: string, pick: BrowserPickResult, note: string) =>
      browserViewManager.captureElementAnnotation(id, pick, typeof note === 'string' ? note : '')
  )

  // Agent 只读观测:页面快照 + 控制台错误 + 网络失败(不注入不点击)
  ipcMain.handle('browser:observe', (_e, id: string) => browserViewManager.observe(id))

  if (!terminalEventsRegistered) {
    terminalEventsRegistered = true
    terminalManager.subscribe((event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('terminal:event', event)
      }
    })
  }

  ipcMain.handle('terminals:list', () => terminalManager.list())
  ipcMain.handle('sessions:create', sessionReadyHandler(async (_e, opts: CreateSessionOptions) => {
    if (!opts || typeof opts.cwd !== 'string') {
      throw new Error('创建会话参数无效')
    }
    if (opts.cwd.trim().length === 0) {
      if (!opts.workspaceId?.trim()) return createUnassignedSession(opts)
      const cwd = await resolveWorkspaceSessionCwd(opts.workspaceId, app.getPath('userData'))
      return sessionManager.createManaged({ ...opts, cwd })
    }
    return sessionManager.createManaged(opts)
  }))

  ipcMain.handle('sessions:dispatchSubagents', sessionReadyHandler((_e, parentSessionId: string, input: DispatchSubagentsInput) => {
    if (typeof parentSessionId !== 'string' || parentSessionId.trim().length === 0) {
      throw new Error('必须指定父会话')
    }
    if (!input || !Array.isArray(input.tasks)) throw new Error('必须提供子代理任务列表')
    return sessionManager.dispatchSubagents(parentSessionId, input)
  }))

  ipcMain.handle('sessions:decomposeTask', sessionReadyHandler((_e, parentSessionId: string, input: TaskDecomposeInput) => {
    if (typeof parentSessionId !== 'string' || parentSessionId.trim().length === 0) {
      throw new Error('必须指定父会话')
    }
    if (!input || typeof input.request !== 'string' || input.request.trim().length === 0) {
      throw new Error('必须提供需求文本')
    }
    return sessionManager.decomposeTask(parentSessionId, input)
  }))

  ipcMain.handle('sessions:dispatchTaskDag', sessionReadyHandler((_e, parentSessionId: string, input: TaskDagDispatchInput) => {
    if (typeof parentSessionId !== 'string' || parentSessionId.trim().length === 0) {
      throw new Error('必须指定父会话')
    }
    if (!input?.dag || !Array.isArray(input.dag.tasks)) throw new Error('必须提供 DAG 任务')
    return sessionManager.dispatchTaskDag(parentSessionId, input)
  }))

  // OCR:提取附件图片文字(Vision/tesseract 逐级降级;路径必须在会话附件区内)
  ipcMain.handle('attachments:ocr', async (_e, id: string, imagePath: string) => {
    if (!sessionManager.get(id)) return { ok: false, error: '会话不存在' }
    if (typeof imagePath !== 'string' || !isInsideAttachmentRoot(id, imagePath)) {
      return { ok: false, error: '仅允许识别当前会话附件区内的图片' }
    }
    return ocrImage(imagePath)
  })

  ipcMain.handle('sessions:send', sessionReadyHandler(async (_e, id: string, raw: unknown) => {
    const payload = normalizeSendPayload(id, raw)
    if (!payload) return false
    const accepted = await sessionManager.send(id, payload)
    if (!accepted) return false
    const sessionMeta = sessionManager.get(id)?.meta
    if (
      payload.text && sessionMeta?.taskStrategy === 'execute' &&
      shouldProposeMemory(payload.text) && shouldEmitMemorySuggestion(id, payload.text)
    ) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('memory:suggestion', { sessionId: id, text: payload.text })
      }
    }
    if (payload.text && sessionMeta?.taskStrategy === 'execute') {
      const projectRoot = sessionMeta ? (sessionMeta.sourceCwd ?? sessionMeta.cwd) : undefined
      void writeExtractedMemory({
        rootDir: memoryRoot(),
        text: payload.text,
        projectRoot,
        projectId: sessionMeta.workspaceId,
        source: 'session:auto-extract',
        defaultLayer: projectRoot ? 'project' : 'user'
      }).catch((error) => {
        console.error('[caogen] memory draft auto-extract failed:', error)
      })
    }
    return true
  }))

  ipcMain.handle('sessions:outboundContextPreview', sessionReadyHandler(async (_e, id: string, raw: unknown) => {
    const meta = sessionManager.get(id)?.meta
    if (!meta) throw new Error('会话不存在')
    const payload = normalizeSendPayload(id, raw) ?? { text: '' }
    return previewOutboundContext(meta, app.getPath('userData'), payload)
  }))

  ipcMain.handle('sessions:interrupt', sessionReadyHandler(async (_e, id: string) => {
    await sessionManager.interrupt(id)
  }))

  ipcMain.handle('sessions:close', sessionReadyHandler(async (_e, id: string) => {
    revokeGuiAutomationGrantsForSession(id)
    revokeToolCapabilityGrantsForSession(id)
    await sessionManager.close(id)
  }))

  ipcMain.handle(
    'sessions:permission',
    (_e, id: string, requestId: string, allow: boolean, message?: string) => {
      sessionManager.get(id)?.respondPermission(requestId, allow === true, message)
    }
  )

  ipcMain.handle('sessions:setPermissionMode', sessionReadyHandler(async (_e, id: string, mode: PermissionModeId) => {
    await sessionManager.get(id)?.setPermissionMode(mode)
  }))

  ipcMain.handle('sessions:setModel', (_e, id: string, model: string) =>
    applySessionModelSwitch(sessionManager.get(id), model))

  ipcMain.handle('sessions:rename', (_e, id: string, title: string) => {
    if (typeof title === 'string') sessionManager.get(id)?.rename(title)
  })

  ipcMain.handle('history:list', () => listHistory())
  ipcMain.handle('history:setArchived', (_e, id: string, archived: boolean) =>
    setHistoryArchived(id, archived === true)
  )
  ipcMain.handle('history:setPinned', (_e, id: string, pinned: boolean) =>
    setHistoryPinned(id, pinned === true)
  )
  ipcMain.handle('history:rename', (_e, id: string, title: string) => {
    if (typeof title === 'string') renameHistory(id, title)
  })
  ipcMain.handle('history:delete', (event, id: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return sessionManager.deleteHistorySession(id)
  })

  // 会话全文搜索:按历史列表顺序(最近优先)扫描转录文件;防抖在渲染进程做
  ipcMain.handle('transcripts:search', (_e, query: string) => {
    if (typeof query !== 'string' || query.trim().length === 0) return []
    return searchTranscripts(
      join(app.getPath('userData'), 'transcripts'),
      listHistory().map((entry) => ({
        sdkSessionId: entry.sdkSessionId,
        title: entry.title,
        cwd: entry.sourceCwd ?? entry.cwd
      })),
      query
    )
  })

  registerSettingsDomainIpc(ipcMain)

  ipcMain.handle('notificationConnectors:list', () => listNotificationConnectors())
  ipcMain.handle('notificationConnectors:create', (_e, input: NotificationConnectorInput) =>
    createNotificationConnector(input)
  )
  ipcMain.handle('notificationConnectors:delete', (_e, id: string) =>
    deleteNotificationConnector(typeof id === 'string' ? id : '')
  )
  ipcMain.handle('notificationConnectors:setDefault', (_e, id: string) =>
    setDefaultNotificationConnector(typeof id === 'string' ? id : '')
  )

  ipcMain.handle('providers:list', () => listProviders())
  ipcMain.handle('providers:usage', (_e, query) => queryProviderUsage(query ?? {}))
  registerProviderAuthorizationIpc()
  registerProviderBillingIpc()
  ipcMain.handle('providers:balance:capability', (_e, providerId: string) =>
    inspectProviderBalance(typeof providerId === 'string' ? providerId : ''))
  ipcMain.handle('providers:balance:query', (_e, providerId: string) => {
    const normalizedProviderId = typeof providerId === 'string' ? providerId : ''
    return executeProviderOperationEffect(
      'provider_balance_query',
      'Query Provider balance',
      { providerId: normalizedProviderId },
      () => queryProviderBalance(normalizedProviderId)
    )
  })
  ipcMain.handle('providers:activateLocalCompute', (_event, options) => activateLocalCompute(options))

  ipcMain.handle('providers:create', (_e, input: ProviderInput) => {
    if (!input || typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new Error('Provider 名称不能为空')
    }
    return createProvider(input)
  })

  ipcMain.handle('providers:update', (_e, id: string, patch: Partial<ProviderInput>) =>
    updateProvider(id, patch ?? {})
  )

  ipcMain.handle('providers:delete', (_e, id: string) => {
    deleteProvider(id)
    removeProviderAuthorizations(id)
  })

  ipcMain.handle('providers:health', () => listHealth())
  ipcMain.handle('engines:list', () => listEngines())

  ipcMain.handle(
    'plugins:scan',
    (_e, sessionId?: string, options?: PluginRegistryScanOptions) =>
      scanPluginRegistry(
        pluginRegistryRoots(sessionId),
        normalizePluginScanOptions(options),
        readPluginRegistryState(pluginRegistryStateFile())
      )
  )

  ipcMain.handle('plugins:reveal', (_e, targetPath: string, sessionId?: string) => {
    if (!canRevealPluginPath(targetPath, sessionId)) {
      return { ok: false, error: '插件路径不在允许的扫描范围内' }
    }
    shell.showItemInFolder(resolve(targetPath))
    return { ok: true, path: resolve(targetPath) }
  })

  ipcMain.handle('plugins:setEnabled', (_e, item: unknown, enabled: unknown, sessionId?: string) => {
    if (!isPluginRegistryItem(item)) return { ok: false, error: '插件条目无效' }
    if (typeof enabled !== 'boolean') return { ok: false, error: '插件状态无效' }

    const scannedItem = findScannedPluginRegistryItem(item, sessionId)
    if (!scannedItem) return { ok: false, error: '插件条目不在当前允许的扫描范围内' }
    if (enabled && scannedItem.trust.status !== 'approved') {
      return { ok: false, error: pluginTrustError(scannedItem) }
    }

    const state = setPluginRegistryItemEnabled(
      readPluginRegistryState(pluginRegistryStateFile()),
      scannedItem,
      enabled
    )
    writePluginRegistryState(pluginRegistryStateFile(), state)

    const refreshed = scanPluginRegistry(
      pluginRegistryRoots(sessionId),
      normalizePluginScanOptions(),
      state
    )
    return {
      ok: true,
      item: refreshed.items.find((candidate) => pluginRegistryItemKey(candidate) === pluginRegistryItemKey(scannedItem)) ?? {
        ...scannedItem,
        enabled
      }
    }
  })

  ipcMain.handle('plugins:approve', (_e, item: unknown, sessionId?: string) => {
    if (!isPluginRegistryItem(item)) return { ok: false, error: '插件条目无效' }
    const scannedItem = findScannedPluginRegistryItem(item, sessionId)
    if (!scannedItem) return { ok: false, error: '插件条目不在当前允许的扫描范围内' }
    try {
      const state = approvePluginRegistryItem(readPluginRegistryState(pluginRegistryStateFile()), scannedItem)
      writePluginRegistryState(pluginRegistryStateFile(), state)
      const refreshed = scanPluginRegistry(
        pluginRegistryRoots(sessionId),
        normalizePluginScanOptions(),
        state
      )
      return {
        ok: true,
        item: refreshed.items.find((candidate) => pluginRegistryItemKey(candidate) === pluginRegistryItemKey(scannedItem))
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('plugins:authorize', (_e, item: unknown, sessionId?: string) => {
    if (!isPluginRegistryItem(item)) return { ok: false, error: '插件条目无效' }
    const scannedItem = findScannedPluginRegistryItem(item, sessionId)
    if (!scannedItem) return { ok: false, error: '插件条目不在当前允许的扫描范围内' }
    if (scannedItem.trust.status !== 'approved') return { ok: false, error: pluginTrustError(scannedItem) }
    if (!scannedItem.enabled) return { ok: false, error: '该插件条目已停用' }
    return { ok: true, item: scannedItem }
  })

  ipcMain.handle('routines:list', () => listRoutines(routineStoreRoot()))

  ipcMain.handle('routines:create', (_e, input: CreateRoutineInput) =>
    createRoutine(routineStoreRoot(), input)
  )

  ipcMain.handle('routines:delete', (_e, id: string) => {
    if (typeof id !== 'string' || id.trim().length === 0) return false
    return deleteRoutine(routineStoreRoot(), id)
  })

  ipcMain.handle('routines:update', (_e, id: string, patch: UpdateRoutineInput) => {
    if (typeof id !== 'string' || id.trim().length === 0) return null
    return updateRoutine(routineStoreRoot(), id, patch ?? {})
  })

  ipcMain.handle('routines:markRun', (_e, id: string, options?: MarkRunOptions) => {
    if (typeof id !== 'string' || id.trim().length === 0) return null
    return markRun(routineStoreRoot(), id, options ?? {})
  })

  ipcMain.handle('routines:runNow', (_e, id: string) => {
    if (typeof id !== 'string' || id.trim().length === 0) return null
    return runRoutineNow(routineStoreRoot(), id)
  })

  ipcMain.handle('routines:listRuns', (_e, id?: string) =>
    listRoutineRuns(routineStoreRoot(), typeof id === 'string' && id.trim() ? id : undefined)
  )

  ipcMain.handle('routines:reviewRun', (_e, id: string, input: RoutineRunReviewInput) => {
    if (typeof id !== 'string' || !id.trim()) return null
    return reviewRoutineRun(routineStoreRoot(), app.getPath('userData'), id, input)
  })

  ipcMain.handle('routines:listTemplates', () => listRoutineTemplates())

  ipcMain.handle('startSuggestions:get', async (_e, id: string) => {
    const session = sessionManager.get(id)
    if (!session) return []
    const projectRoot = session.meta.sourceCwd ?? session.meta.cwd
    const resolvedProjectRoot = resolve(projectRoot)
    const belongsToCurrentProject = (cwd: unknown): cwd is string =>
      typeof cwd === 'string' && cwd.trim().length > 0 && resolve(cwd) === resolvedProjectRoot
    const memory = await readProjectMemory({
      projectRoot,
      projectId: session.meta.workspaceId
    }, memoryRoot()).catch(() => ({ entries: [] }))
    const worktree = getManagedWorktreeSummary(id)
    const historySignals: StartSuggestionSignal[] = listHistory()
      .filter((entry) => belongsToCurrentProject(entry.sourceCwd ?? entry.cwd))
      .slice(0, 8)
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        body: entry.sourceCwd ?? entry.cwd,
        source: 'history',
        updatedAt: entry.updatedAt,
        ok: true
      }))
    const routines = (await listRoutines(routineStoreRoot())).filter((routine) =>
      (session.meta.workspaceId && routine.projectId === session.meta.workspaceId) ||
      belongsToCurrentProject(routine.projectCwd)
    )
    const routineSignals: StartSuggestionSignal[] = routines.map((routine) => ({
      id: routine.id,
      title: routine.name,
      body: routine.prompt,
      source: 'routine',
      status: routine.enabled ? 'enabled' : 'disabled',
      updatedAt: routine.updatedAt,
      ok: true
    }))
    const routineIds = new Set(routines.map((routine) => routine.id))
    const routineRunSignals: StartSuggestionSignal[] = (await listRoutineRuns(routineStoreRoot()))
      .filter((run) => routineIds.has(run.routineId))
      .slice(0, 16)
      .map((run) => ({
        id: run.id,
        title: run.routineName,
        body: run.resultText ?? run.error ?? run.projectCwd,
        source: 'routine-run',
        status: run.inboxStatus,
        updatedAt: run.finishedAt ?? run.startedAt,
        ok: run.status === 'succeeded' ? true : run.status === 'failed' ? false : undefined
      }))
    // recentFailures:用 Provider 健康度作为唯一可靠的失败来源。
    // 成功恢复会清掉 lastError,历史失败仍保留在 recentFailures 供控制中心审计。
    const activeProviderId = session.meta.providerId || 'local-login'
    const recentFailureSignals: StartSuggestionSignal[] = listHealth()
      .filter((health) => health.providerId === activeProviderId)
      .filter((h) => !h.healthy || (typeof h.lastError === 'string' && h.lastError.trim() !== ''))
      .map((h) => {
        const latest = h.recentFailures[0]
        return {
          id: `provider-health:${h.providerId}`,
          title: `Provider ${h.providerId}`,
          body: latest ? `${latest.label}: ${latest.message}` : h.lastError ?? `${h.consecutiveFailures} consecutive failures`,
          source: 'provider-health',
          error: latest?.message ?? h.lastError,
          updatedAt: h.lastFailureAt ?? h.lastUsedAt,
          failed: true,
          ok: false
        }
      })
    return getStartSuggestions(projectRoot, {
      memoryEntries: memory.entries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        body: entry.body,
        source: entry.source || 'memory',
        status: entry.kind,
        updatedAt: entry.updatedAt,
        failed: /失败|报错|阻塞|failed|error|blocked/i.test(`${entry.title}\n${entry.body}\n${entry.reason}`)
      })),
      worktreeSummaries: [
        {
          id,
          title: worktree.record?.branch ?? session.meta.title,
          body: worktree.error ?? `${worktree.changedFiles} changed files`,
          source: 'worktree',
          status: worktree.dirty ? 'dirty' : 'clean',
          failed: worktree.ok === false,
          ok: worktree.ok
        }
      ],
      historySummaries: historySignals,
      routineSummaries: routineSignals,
      routineRuns: routineRunSignals,
      recentFailures: recentFailureSignals
    })
  })

  ipcMain.handle('migration:scan', (_e, cwd?: string) => {
    if (cwd !== undefined && typeof cwd !== 'string') throw new Error('项目目录格式无效')
    const testHome = !app.isPackaged && process.env.CAOGEN_MIGRATION_TEST_MODE === '1'
      ? process.env.CAOGEN_MIGRATION_TEST_HOME
      : undefined
    return scanMigration(cwd, testHome, app.getPath('userData'))
  })

  ipcMain.handle('migration:import', (_e, cwd: string, paths: string[]) => {
    if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('必须指定项目目录')
    return executeMigrationImportEffect(cwd, paths, executeInteractiveOperationEffect)
  })

  ipcMain.handle('migration:apply', (_e, input: MigrationApplyInput) => {
    if (!input || typeof input !== 'object') throw new Error('迁移决策格式无效')
    return executeMigrationApplyEffect(input, {
      rootDir: app.getPath('userData'),
      backupRoot: migrationBackupRoot()
    })
  })

  ipcMain.handle('migration:rollback', (_e, backupId: string) => {
    if (typeof backupId !== 'string' || backupId.length === 0) throw new Error('必须指定迁移备份')
    return executeMigrationRollbackEffect(backupId, {
      rootDir: app.getPath('userData'),
      backupRoot: migrationBackupRoot()
    })
  })

  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:update', (_e, id: string, patch: { name?: string; archived?: boolean }) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('必须指定项目')
    return updateProject(id, {
      ...(typeof patch?.name === 'string' ? { name: patch.name } : {}),
      ...(typeof patch?.archived === 'boolean' ? { archived: patch.archived } : {})
    })
  })
  ipcMain.handle('projects:delete', (_e, id: string) => {
    deleteProject(id)
  })
  ipcMain.handle('projectContext:read', (_e, projectPath: string) => {
    if (typeof projectPath !== 'string' || projectPath.length === 0) throw new Error('必须指定项目目录')
    return readProjectContext(projectPath)
  })
  ipcMain.handle('projectContext:template', (_e, projectPath: string) => {
    if (typeof projectPath !== 'string' || projectPath.length === 0) throw new Error('必须指定项目目录')
    return generateProjectContextTemplate(projectPath)
  })

  const memoryRoot = (): string => join(app.getPath('userData'), 'memory')
  const projectRootFor = (sessionId: string): string | null => {
    const meta = sessionManager.get(sessionId)?.meta
    return meta ? (meta.sourceCwd ?? meta.cwd) : null
  }
  const memoryTargetFor = (sessionId: string) => {
    const meta = sessionManager.get(sessionId)?.meta
    return meta ? { projectRoot: meta.sourceCwd ?? meta.cwd, projectId: meta.workspaceId } : null
  }
  const memoryScopeFor = (sessionId?: string): { projectRoot?: string; projectId?: string } => {
    if (sessionId === undefined) return {}
    const scope = memoryTargetFor(sessionId)
    if (!scope) throw new Error('会话不存在，请先打开原始任务。')
    return scope
  }
  registerProjectMemoryIpc({
    memoryRoot,
    targetForSession: memoryTargetFor
  })

  registerLearningIpc({ projectRootFor, targetForSession: memoryTargetFor, userDataRoot: () => app.getPath('userData') })

  ipcMain.handle('memory:layeredList', (event, sessionId?: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return listMemories(memoryRoot(), memoryScopeFor(sessionId))
  })
  ipcMain.handle('memory:layeredSearch', (event, sessionId: string | undefined, input: MemorySearchInput) => {
    assertTrustedWorkflowLedgerSender(event)
    const scope = memoryScopeFor(sessionId)
    return searchMemories(memoryRoot(), {
      ...(input ?? {}),
      projectRoot: scope.projectRoot,
      projectId: scope.projectId
    })
  })
  ipcMain.handle('memory:layeredArchive', (event, olderThanDays?: number) => {
    assertTrustedWorkflowLedgerSender(event)
    return archiveStaleMemories(memoryRoot(), olderThanDays)
  })
  ipcMain.handle('memory:layeredExport', (event) => {
    assertTrustedWorkflowLedgerSender(event)
    return exportMemories(memoryRoot())
  })
  ipcMain.handle('memory:layeredUpdate', (event, entryId: string, input: MemoryUpdateInput, sessionId?: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return updateLayeredMemoryEntry(memoryRoot(), entryId, input ?? {}, memoryScopeFor(sessionId))
  })
  ipcMain.handle('memory:layeredDelete', (event, entryId: string, sessionId?: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return deleteLayeredMemoryEntry(memoryRoot(), entryId, memoryScopeFor(sessionId))
  })

  ipcMain.handle(
    'providers:fetchModels',
    (_e, opts: ProviderModelFetchInput) => fetchModels(opts ?? {})
  )
  ipcMain.handle(
    'providers:probeGeneration',
    (_e, opts: ProviderGenerationProbeInput) => {
      const input = opts ?? { baseUrl: '', model: '' }
      return executeProviderOperationEffect(
        'provider_generation_probe',
        'Test Provider generation request',
        { providerId: input.providerId ?? '', baseUrl: input.baseUrl, model: input.model },
        () => probeProviderGeneration(input)
      )
    }
  )
  ipcMain.handle(
    'providers:fetchPricingCatalog',
    (_e, models: string[]) => fetchProviderPricingCatalog(Array.isArray(models) ? models : [])
  )
  ipcMain.handle('dialog:pickDirectory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
}

function pluginTrustError(item: PluginRegistryItem): string {
  if (item.trust.status === 'invalid') return `无法验证 ${item.name} 的内容摘要，已阻止使用`
  if (item.trust.status === 'changed') return `${item.name} 的内容或能力已变更，需要重新批准`
  return `${item.name} 尚未批准，已阻止使用`
}
