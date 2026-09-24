import { assertTaskExecutionEnvironment } from './wsl/binding'
import { getTaskHostExecutionGate, taskHostSubject } from './task-handoff/execution-gate'
import { describeOfficeRevisionReplay } from './office-revision/replay'
import { officeRevisionToolGate } from './office-revision/intent'
import { finalizeOfficeRevisionToolResult } from './office-revision/producer'
import { randomUUID } from 'node:crypto'
import { beginGuiPreviewTool, finishGuiPreviewTool, guiPreviewBinding, type GuiPreviewInvocation } from './gui-preview/gui-preview-events'
import { app } from 'electron'
import { assertSideChatBinding } from './side-chat/side-chat-policy'
import { assertPreparationToolScope, isPreparationWriteTool, resolvePreparationToolScope, type PreparationToolScope } from './permission/preparation-tool-scope'
import { settingsForCaoGenDrive } from './model/drive'
import { getSettings } from './settings'
import { EDIT_TOOLS, executeCodingTool, type ToolExecResult } from './openaiTools'
import {
  GUI_TEMPORARY_GRANT_MESSAGE,
  TOOL_TEMPORARY_GRANT_MESSAGE,
  decideGuiPermission,
  decideToolCapabilityPermission,
  grantTemporaryGuiAutomation,
  grantTemporaryToolCapability,
  permissionEffectScope,
  temporaryGuiGrantScopeLabel,
  temporaryToolGrantScopeLabel,
  type ToolCapabilityDecision,
  type GuiPermissionDecision
} from './permission/permission-manager'
import { writeSessionAuditLog } from './permission/audit-log'
import { evaluateToolPermission, type ToolPermissionDecision } from './permission/tool-permission'
import { limitedFileExecutionError } from './permission/limited-file-execution'
import { TaskExecutionAuthorityStore, taskExecutionAuthorityBindingDigest } from './permission/task-execution-authority-store'
import { externalBrowserRegistry } from './external-browser-registry'
import { classifyToolCapabilities } from './permission/tool-capabilities'
import { taskRuntimeRegistry, type ToolIdempotencyDecision } from './task/task-runtime-registry'
import { registerSessionProducedArtifacts } from './task/session-artifact-producer'
import { isDisabledModeInspectionToolCall, isReadOnlyToolCall, isSideEffectingToolCall, stableValueDigest } from './task/tool-idempotency'
import { buildEffectDescriptor, effectReplayTargetDigest } from './task/effect-reconciler'
import { describeOfficeArtifactReplayTarget, isOfficeArtifactTool } from './agent/tools/office-artifact'
import { decideTaskStrategyTool } from './task/task-strategy'
import { digitalWorkerToolPolicyError } from './digital-worker/tool-action-policy'
import {
  cancelEffectExecution,
  confirmedEffectFromArtifactProjectionError,
  completeEffectExecution,
  markEffectExecutionStarted,
  prepareEffectExecution,
  type PrepareEffectExecutionInput
} from './task/effect-runtime'
import type {
  AgentEvent,
  EffectStatus,
  PermissionEffectScopeView,
  PermissionRequestInfo,
  SessionMeta,
  ToolRiskLevel
} from '../shared/types'

export type NativeToolExecutionResult = ToolExecResult & { effectStatus?: EffectStatus }
export type NativeToolPermissionDecision = { allow: boolean; message?: string; authorizationSource?: 'policy' | 'capability' | 'permission-mode' }

type EffectExecutionHandle = Awaited<ReturnType<typeof prepareEffectExecution>>

type PreparedEffect =
  | { kind: 'ready'; handle: EffectExecutionHandle }
  | { kind: 'failed'; result: NativeToolExecutionResult }

type NativeToolPreflightDecision =
  | { allow: false; message: string }
  | {
      allow: true
      policy: ToolPermissionDecision
      readOnlyCall: boolean
      guiDecision: GuiPermissionDecision
      toolCapabilityDecision: ToolCapabilityDecision
      idempotency: ToolIdempotencyDecision
      executionScope: PreparationToolScope
      taskExecutionAuthorityRevision: number
    }

interface PendingPermission {
  resolve: (result: NativeToolPermissionDecision) => void
  info: PermissionRequestInfo
}

const LOCAL_EXECUTION_DISABLED_MESSAGE =
  'Agent 本地执行能力已禁用:旧严格 Docker 设置不会自动降级为宿主机执行。当前仅保留最小项目检查能力，请先在设置 > 权限中确认启用。'

/** Shared permission, durable Effect, execution, and audit runtime for EastGenesis native tools. */
export class NativeToolRuntime {
  private readonly pendingPerms = new Map<string, PendingPermission>()

  constructor(
    private readonly meta: SessionMeta,
    private readonly emit: (event: AgentEvent) => void
  ) {}

  respondPermission(requestId: string, allow: boolean, message?: string): void {
    const pending = this.pendingPerms.get(requestId)
    if (!pending) return
    let resolvedAllow = allow
    let resolvedMessage = message
    if (allow && message === GUI_TEMPORARY_GRANT_MESSAGE && pending.info.toolName.startsWith('gui_')) {
      try {
        grantTemporaryGuiAutomation(
          this.meta.id,
          this.meta.cwd,
          pending.info.toolName,
          pending.info.input as Record<string, unknown>
        )
      } catch (error) {
        resolvedAllow = false
        resolvedMessage = error instanceof Error ? error.message : String(error)
      }
    }
    if (allow && message === TOOL_TEMPORARY_GRANT_MESSAGE && !pending.info.toolName.startsWith('gui_')) {
      try {
        grantTemporaryToolCapability(
          this.meta.id,
          this.meta.cwd,
          pending.info.toolName,
          pending.info.input as Record<string, unknown>,
          pending.info.riskLevel,
          pending.info.effectScope
        )
      } catch (error) {
        resolvedAllow = false
        resolvedMessage = error instanceof Error ? error.message : String(error)
      }
    }
    this.pendingPerms.delete(requestId)
    writeSessionAuditLog(this.meta, {
      action: resolvedAllow ? 'allow' : 'deny',
      source: 'user',
      toolName: pending.info.toolName,
      input: pending.info.input,
      capabilities: pending.info.capabilities,
      message: resolvedMessage
    })
    this.emit({ kind: 'permission-resolved', requestId, behavior: resolvedAllow ? 'allow' : 'deny' })
    pending.resolve({ allow: resolvedAllow, message: resolvedMessage })
  }

  pendingPermissions(): PermissionRequestInfo[] {
    return [...this.pendingPerms.values()].map((pending) => pending.info)
  }

  async describeSideEffectTarget(
    name: string,
    input: Record<string, unknown>
  ): Promise<{ targetDigest: string } | null> {
    if (!isSideEffectingToolCall(name, input)) return null
    if (name === 'revise_office_artifact') return describeOfficeRevisionReplay(this.meta.id, input)
    if (isOfficeArtifactTool(name)) {
      const target = await describeOfficeArtifactReplayTarget(input, resolvePreparationToolScope(this.meta, name, input, app.getPath('userData')).cwd)
      return { targetDigest: effectReplayTargetDigest(target) }
    }
    const descriptor = await buildEffectDescriptor({
      sessionId: this.meta.id,
      toolName: name,
      toolInput: input,
      cwd: resolvePreparationToolScope(this.meta, name, input, app.getPath('userData')).cwd
    })
    return { targetDigest: effectReplayTargetDigest(descriptor.target) }
  }

  rejectAllPending(message: string): void {
    for (const [requestId, pending] of this.pendingPerms) {
      this.emit({ kind: 'permission-resolved', requestId, behavior: 'deny' })
      pending.resolve({ allow: false, message })
    }
    this.pendingPerms.clear()
  }

  async gateTool(
    name: string,
    input: Record<string, unknown>,
    toolUseId: string,
    effectHandle?: EffectExecutionHandle | null,
    executionScope?: PreparationToolScope
  ): Promise<NativeToolPermissionDecision> {
    const effectScope = effectHandle?.target && effectHandle.targetDigest
      ? permissionEffectScope(effectHandle.target, effectHandle.targetDigest)
      : undefined
    const preflight = this.preflightToolGate(name, input, toolUseId, effectHandle?.targetDigest, executionScope)
    if (!preflight.allow) return preflight
    const { policy, readOnlyCall, guiDecision, toolCapabilityDecision, idempotency } = preflight

    if (name === 'browser_debug_evaluate') {
      const reason = '高级调试脚本可访问页面主框架状态并产生副作用。请核对完整脚本；本次审批只绑定当前文档和调试授权。'
      this.auditGateDecision('ask', 'policy', name, input, reason, policy.risk.level, policy.risk.reasons)
      return this.requestToolPermission(name, input, toolUseId, reason,
        idempotency.kind === 'ask' ? idempotency.duplicateExecutionId : undefined, false, policy.risk.level, effectScope)
    }

    if (idempotency.kind === 'ask') {
      this.auditGateDecision(
        'ask',
        'idempotency',
        name,
        input,
        idempotency.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return this.requestToolPermission(
        name,
        input,
        toolUseId,
        idempotency.reason,
        idempotency.duplicateExecutionId,
        false,
        policy.risk.level,
        effectScope
      )
    }
    if (preflight.executionScope.preparation && isPreparationWriteTool(name)) {
      this.auditGateDecision('allow', 'user', name, input, '用户已授权当前隔离准备区写入。', policy.risk.level, policy.risk.reasons)
      return { allow: true }
    }
    if (guiDecision.kind === 'allow') {
      this.auditGateDecision('allow', 'policy', name, input, guiDecision.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: true }
    }
    if (guiDecision.kind === 'ask') {
      this.auditGateDecision('ask', 'policy', name, input, guiDecision.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return this.requestToolPermission(name, input, toolUseId, guiDecision.reason, undefined, true, policy.risk.level, effectScope)
    }
    if (toolCapabilityDecision.kind === 'allow') {
      this.auditGateDecision('allow', 'policy', name, input, toolCapabilityDecision.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: true, message: toolCapabilityDecision.reason, authorizationSource: 'capability' }
    }
    if (policy.kind === 'allow') {
      writeSessionAuditLog(this.meta, {
        action: 'allow',
        source: 'policy',
        toolName: name,
        input,
        message: policy.reason,
        riskLevel: policy.risk.level,
        riskReasons: policy.risk.reasons,
        capabilities: policy.risk.capabilities
      })
      return { allow: true, message: policy.reason, authorizationSource: 'policy' }
    }

    const mode = this.meta.permissionMode
    if (mode === 'bypassPermissions' && requiresExplicitApprovalDespiteBypass(name, policy.risk.level)) {
      const reason = `该 ${policy.risk.level} 风险操作不可被 Full Access 静默放行；${policy.reason}`
      this.auditGateDecision(
        'ask',
        'permission-mode',
        name,
        input,
        reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return this.requestToolPermission(name, input, toolUseId, reason, undefined, true, policy.risk.level, effectScope)
    }
    if (mode === 'bypassPermissions') {
      this.auditGateDecision(
        'allow',
        'permission-mode',
        name,
        input,
        policy.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: true, authorizationSource: 'permission-mode' }
    }
    if (readOnlyCall) {
      this.auditGateDecision(
        'allow',
        'permission-mode',
        name,
        input,
        policy.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: true }
    }
    if (mode === 'acceptEdits' && EDIT_TOOLS.has(name)) {
      this.auditGateDecision(
        'allow',
        'permission-mode',
        name,
        input,
        policy.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: true }
    }
    this.auditGateDecision(
      'ask',
      'permission-mode',
      name,
      input,
      policy.reason,
      policy.risk.level,
      policy.risk.reasons
    )
    return this.requestToolPermission(name, input, toolUseId, policy.reason, undefined, true, policy.risk.level, effectScope)
  }

  preflightToolGate(
    name: string,
    input: Record<string, unknown>,
    toolUseId: string,
    effectTargetDigest?: string,
    capturedScope?: PreparationToolScope
  ): NativeToolPreflightDecision {
    if (isCouncilSession(this.meta)) return { allow: false, message: '议事参与者仅可形成一轮意见，禁止调用工具或递归委派' }
    try {
      if (assertSideChatBinding(this.meta, app.getPath('userData'))) {
        return { allow: false, message: '侧聊是只读上下文讨论，不能调用工具；请回到原任务执行操作。' }
      }
    } catch (error) { return { allow: false, message: error instanceof Error ? error.message : String(error) } }
    let executionScope: PreparationToolScope
    let taskExecutionAuthorityRevision: number
    try {
      assertTaskExecutionEnvironment(this.meta)
      executionScope = capturedScope ?? resolvePreparationToolScope(this.meta, name, input, app.getPath('userData'))
      assertPreparationToolScope(this.meta, executionScope, app.getPath('userData'), name)
      taskExecutionAuthorityRevision = executionScope.preparation ? 0 : new TaskExecutionAuthorityStore(app.getPath('userData')).get(this.meta).revision
    } catch (error) { return { allow: false, message: error instanceof Error ? error.message : String(error) } }
    const workerPolicyError = officeRevisionToolGate(this.meta.id, name, input) ?? digitalWorkerToolPolicyError(this.meta, name, input, app.getPath('userData'))
    if (workerPolicyError) return { allow: false, message: workerPolicyError }
    const settings = settingsForCaoGenDrive(getSettings(), this.meta.driveMode)
    const policy = evaluateToolPermission(settings, { toolName: name, input, cwd: executionScope.cwd })
    const fileScopeError = limitedFileExecutionError(settings, name, input, executionScope.cwd, {
      preparation: Boolean(executionScope.preparation), sessionId: this.meta.id, sessionMeta: this.meta,
      rootDir: app.getPath('userData'), taskExecutionAuthorityRevision
    })
    if (fileScopeError) {
      this.auditGateDecision('deny', 'policy', name, input, fileScopeError, policy.risk.level, policy.risk.reasons)
      return { allow: false, message: fileScopeError }
    }
    if (policy.kind === 'deny') {
      writeSessionAuditLog(this.meta, {
        action: 'deny',
        source: 'policy',
        toolName: name,
        input,
        message: policy.reason,
        riskLevel: policy.risk.level,
        riskReasons: policy.risk.reasons,
        capabilities: policy.risk.capabilities
      })
      return { allow: false, message: policy.reason }
    }

    const readOnlyCall = isReadOnlyToolCall(name, input)
    const strategyDecision = decideTaskStrategyTool(this.meta.taskStrategy, name, input)
    if (!strategyDecision.allow && !(executionScope.preparation && isPreparationWriteTool(name) && this.meta.taskStrategy !== 'view')) {
      this.auditGateDecision(
        'deny',
        'task-strategy',
        name,
        input,
        strategyDecision.message ?? '任务策略拒绝执行',
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: false, message: strategyDecision.message ?? '任务策略拒绝执行' }
    }
    const disabledModeInspectionCall = isDisabledModeInspectionToolCall(name)
    if (settings.sandboxMode === 'disabled' && !disabledModeInspectionCall) {
      this.auditGateDecision(
        'deny',
        'policy',
        name,
        input,
        LOCAL_EXECUTION_DISABLED_MESSAGE,
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: false, message: LOCAL_EXECUTION_DISABLED_MESSAGE }
    }
    const guiDecision = decideGuiPermission(name, input, settings, {
      sessionId: this.meta.id,
      cwd: executionScope.cwd
    })
    if (guiDecision.kind === 'deny') {
      this.auditGateDecision('deny', 'policy', name, input, guiDecision.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: false, message: guiDecision.reason }
    }
    const toolCapabilityDecision = decideToolCapabilityPermission(name, input, {
      sessionId: this.meta.id,
      cwd: executionScope.cwd,
      effectTargetDigest
    })
    const idempotency = taskRuntimeRegistry.evaluateTool({
      sessionId: this.meta.id,
      cwd: executionScope.cwd,
      toolName: name,
      toolInput: input,
      toolUseId
    })
    if (idempotency.kind === 'deny') {
      this.auditGateDecision(
        'deny',
        'idempotency',
        name,
        input,
        idempotency.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: false, message: idempotency.reason }
    }
    return { allow: true, policy, readOnlyCall, guiDecision, toolCapabilityDecision, idempotency, executionScope, taskExecutionAuthorityRevision }
  }

  async executeToolWithPermission(
    name: string,
    input: Record<string, unknown>,
    toolUseId: string,
    signal?: AbortSignal
  ): Promise<NativeToolExecutionResult> {
    const hostGate = getTaskHostExecutionGate(app.getPath('userData'))
    let hostClaim
    try { hostClaim = hostGate.claim(taskHostSubject(this.meta)) }
    catch (error) { return { ok: false, output: error instanceof Error ? error.message : String(error) } }
    if (signal?.aborted) return { ok: false, output: '操作已中断，未进入权限判断' }
    const preflight = this.preflightToolGate(name, input, toolUseId)
    if (preflight.allow === false) {
      return { ok: false, output: `操作已被权限策略拒绝${preflight.message ? `:${preflight.message}` : ''}` }
    }
    const environmentDigest = stableValueDigest(this.meta.executionEnvironment ?? { kind: 'host' })
    const commandInputDigest = name === 'bash' ? stableValueDigest(input) : undefined
    // Freeze query, task and external-tab identity before awaiting any approval.
    const searchBinding = name === 'web_search' ? {
      inputDigest: stableValueDigest(input), taskDigest: taskExecutionAuthorityBindingDigest(this.meta),
      runId: taskRuntimeRegistry.get(this.meta.id)?.id,
      browserDigest: stableValueDigest(externalBrowserRegistry.taskStatus(this.meta.id) ?? null),
      permissionMode: this.meta.permissionMode, driveMode: this.meta.driveMode
    } : undefined
    const effectInput: PrepareEffectExecutionInput = {
      sessionId: this.meta.id,
      cwd: preflight.executionScope.cwd,
      officeSourceCwd: preflight.executionScope.preparation ? this.meta.cwd : undefined,
      toolUseId,
      toolName: name,
      toolInput: input
    }
    const prepared = await this.prepareToolEffect(effectInput)
    if (prepared.kind === 'failed') return prepared.result
    const effectHandle = prepared.handle
    const interruptedBeforeGate = await this.cancelIfAborted(
      signal,
      effectHandle,
      '操作在权限判断前已中断'
    )
    if (interruptedBeforeGate) return interruptedBeforeGate

    const gate = await this.awaitToolPermission(name, input, toolUseId, effectHandle, preflight.executionScope)
    if (!gate.allow) {
      return this.settlePermissionDenial(effectHandle, gate)
    }
    if (environmentDigest !== stableValueDigest(this.meta.executionEnvironment ?? { kind: 'host' })) return this.settlePermissionDenial(effectHandle, { allow: false, message: '执行环境在审批期间变化，原审批失效。' })
    const interruptedAfterGate = await this.cancelIfAborted(
      signal,
      effectHandle,
      '操作在审批后、外部执行前已中断'
    )
    if (interruptedAfterGate) return interruptedAfterGate
    const assertSearchAuthorized = searchBinding ? (query: string) => {
      if (signal?.aborted || typeof input.query !== 'string' || query !== input.query.trim() ||
        stableValueDigest(input) !== searchBinding.inputDigest || this.meta.status === 'closed' ||
        !searchBinding.runId || taskRuntimeRegistry.get(this.meta.id)?.id !== searchBinding.runId ||
        taskExecutionAuthorityBindingDigest(this.meta) !== searchBinding.taskDigest ||
        stableValueDigest(externalBrowserRegistry.taskStatus(this.meta.id) ?? null) !== searchBinding.browserDigest ||
        this.meta.permissionMode !== searchBinding.permissionMode || this.meta.driveMode !== searchBinding.driveMode) {
        throw new Error('搜索内容、任务、浏览器目标或权限已变化，旧搜索审批失效。')
      }
      const live = this.preflightToolGate(name, input, toolUseId, undefined, preflight.executionScope)
      if (!live.allow) throw new Error(live.message)
      if (live.taskExecutionAuthorityRevision !== preflight.taskExecutionAuthorityRevision ||
        (gate.authorizationSource === 'policy' && live.policy.kind !== 'allow') ||
        (gate.authorizationSource === 'capability' && live.toolCapabilityDecision.kind !== 'allow')) {
        throw new Error('搜索授权已撤销或变更，旧搜索审批失效。')
      }
    } : undefined
    try {
      return await hostGate.withPermit(taskHostSubject(this.meta), () => this.executeAllowedTool(name, input, effectHandle, effectInput, preflight.executionScope, preflight.taskExecutionAuthorityRevision, signal, commandInputDigest, assertSearchAuthorized), hostClaim)
    } catch (error) {
      return this.settlePermissionDenial(effectHandle, { allow: false, message: error instanceof Error ? error.message : String(error) })
    }
  }

  private async prepareToolEffect(effectInput: PrepareEffectExecutionInput): Promise<PreparedEffect> {
    try {
      return { kind: 'ready', handle: await prepareEffectExecution(effectInput) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        kind: 'failed',
        result: {
          ok: false,
          output: `外部副作用账本准备失败，已阻止审批和执行:${message}`
        }
      }
    }
  }

  private async awaitToolPermission(
    name: string,
    input: Record<string, unknown>,
    toolUseId: string,
    effectHandle: EffectExecutionHandle,
    executionScope: PreparationToolScope
  ): Promise<NativeToolPermissionDecision> {
    try {
      return await this.gateTool(name, input, toolUseId, effectHandle, executionScope)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await cancelEffectExecution(effectHandle, `权限判断异常，未执行:${message}`).catch(() => undefined)
      throw error
    }
  }

  private async settlePermissionDenial(
    effectHandle: EffectExecutionHandle,
    gate: NativeToolPermissionDecision
  ): Promise<NativeToolExecutionResult> {
    const reason = `用户拒绝了此操作${gate.message ? `:${gate.message}` : ''}`
    try {
      await cancelEffectExecution(effectHandle, reason)
      return {
        ok: false,
        output: reason,
        effectStatus: effectHandle ? 'abandoned' : undefined
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        output: `${reason}\n\n拒绝结果未能写入效果账本，已保持 fail-closed:${message}`,
        effectStatus: effectHandle ? 'waiting_reconciliation' : undefined
      }
    }
  }

  private async cancelIfAborted(
    signal: AbortSignal | undefined,
    effectHandle: EffectExecutionHandle,
    reason: string
  ): Promise<NativeToolExecutionResult | undefined> {
    if (!signal?.aborted) return undefined
    await cancelEffectExecution(effectHandle, reason)
    return {
      ok: false,
      output: '操作已中断，外部执行未开始',
      effectStatus: effectHandle ? 'abandoned' : undefined
    }
  }

  private auditGateDecision(
    action: 'allow' | 'deny' | 'ask',
    source: 'policy' | 'permission-mode' | 'task-strategy' | 'idempotency' | 'user',
    toolName: string,
    input: Record<string, unknown>,
    message: string,
    riskLevel: ToolRiskLevel,
    riskReasons: string[]
  ): void {
    writeSessionAuditLog(this.meta, {
      action,
      source,
      toolName,
      input,
      message,
      riskLevel,
      riskReasons,
      capabilities: classifyToolCapabilities(toolName, input)
    })
  }

  private requestToolPermission(
    name: string,
    input: Record<string, unknown>,
    toolUseId: string,
    decisionReason?: string,
    duplicateExecutionId?: string,
    allowTemporaryGrant = true,
    riskLevel?: ToolRiskLevel,
    effectScope?: PermissionEffectScopeView
  ): Promise<NativeToolPermissionDecision> {
    const requestId = randomUUID()
    const info: PermissionRequestInfo = {
      requestId,
      toolName: name,
      input,
      toolUseId,
      decisionReason,
      duplicateExecutionId,
      riskLevel,
      capabilities: classifyToolCapabilities(name, input),
      guiGrantScope: allowTemporaryGrant ? temporaryGuiGrantScopeLabel(name, input) : undefined,
      toolGrantScope: allowTemporaryGrant ? temporaryToolGrantScopeLabel(name, input, riskLevel, effectScope) : undefined,
      effectScope
    }
    this.emit({ kind: 'permission-request', request: info })
    return new Promise((resolve) => {
      this.pendingPerms.set(requestId, { resolve, info })
    })
  }

  private async executeAllowedTool(
    name: string,
    input: Record<string, unknown>,
    effectHandle: EffectExecutionHandle,
    effectInput: PrepareEffectExecutionInput,
    executionScope: PreparationToolScope,
    taskExecutionAuthorityRevision: number,
    signal?: AbortSignal,
    commandInputDigest?: string,
    assertSearchAuthorized?: (query: string) => void
  ): Promise<NativeToolExecutionResult> {
    const settings = settingsForCaoGenDrive(getSettings(), this.meta.driveMode)
    const interruptedBeforeStart = await this.cancelIfAborted(
      signal,
      effectHandle,
      '操作在外部执行前已中断'
    )
    if (interruptedBeforeStart) return interruptedBeforeStart
    try {
      assertPreparationToolScope(this.meta, executionScope, app.getPath('userData'), name)
      const error = limitedFileExecutionError(settings, name, input, executionScope.cwd, {
        preparation: Boolean(executionScope.preparation), sessionId: this.meta.id, sessionMeta: this.meta,
        rootDir: app.getPath('userData'), effectTarget: effectHandle?.target, taskExecutionAuthorityRevision
      })
      if (error) throw new Error(error)
    }
    catch (error) { return this.settlePermissionDenial(effectHandle, { allow: false, message: error instanceof Error ? error.message : String(error) }) }
    const startFailure = await this.markEffectStarted(effectHandle, effectInput)
    if (startFailure) return startFailure
    const interruptedAfterStart = await this.cancelIfAborted(
      signal,
      effectHandle,
      '操作在外部执行前已中断'
    )
    if (interruptedAfterStart) return interruptedAfterStart
    if (commandInputDigest !== undefined && stableValueDigest(input) !== commandInputDigest) {
      return this.settlePermissionDenial(effectHandle, { allow: false, message: '执行前命令输入已变化，旧审批失效；请重新审批。' })
    }
    let exec: ToolExecResult
    let guiPreviewInvocation: GuiPreviewInvocation | undefined
    // This observer sees only the final, already-approved execution. It cannot approve or capture.
    try {
      if (name.startsWith('gui_')) guiPreviewInvocation = beginGuiPreviewTool(
        guiPreviewBinding(this.meta, taskExecutionAuthorityBindingDigest(this.meta), taskRuntimeRegistry.get(this.meta.id)?.id, taskExecutionAuthorityRevision),
        executionScope.cwd, name, input)
    } catch { /* a preview failure must not change native execution */ }
    try {
      assertTaskExecutionEnvironment(this.meta)
      exec = await executeCodingTool(name, input, executionScope.cwd, {
        preparationPermission: executionScope.preparation,
        taskExecutionAuthorityRevision,
        commandInputDigest,
        assertSearchAuthorized,
        signal,
        sandboxMode: settings.sandboxMode,
        chinaMirrorEnabled: settings.chinaEcosystemMirrorEnabled,
        npmRegistry: settings.chinaNpmRegistry,
        pipIndexUrl: settings.chinaPipIndexUrl,
        sessionId: this.meta.id,
        sessionMeta: this.meta,
        userDataRoot: app.getPath('userData'),
        toolUseId: effectInput.toolUseId,
        worktreeContext: {
          sessionId: this.meta.id,
          repoRoot: this.meta.repoRoot,
          sourceCwd: this.meta.sourceCwd,
          worktreePath: this.meta.worktreePath,
          branch: this.meta.branch,
          baseBranch: this.meta.baseBranch,
          baseSha: this.meta.baseSha
        },
        effectTarget: effectHandle?.target
      })
    } catch (error) {
      finishGuiPreviewTool(guiPreviewInvocation, { ok: false, output: '' })
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        output: `外部工具执行异常，结果未知:${message}`,
        effectStatus: effectHandle ? 'waiting_reconciliation' : undefined
      }
    }
    finishGuiPreviewTool(guiPreviewInvocation, exec)
    const executionPolicy = evaluateToolPermission(settings, {
      toolName: name,
      input,
      cwd: executionScope.cwd
    })
    writeSessionAuditLog(this.meta, {
      action: 'execute',
      source: 'local-execution',
      toolName: name,
      input,
      ok: exec.ok,
      riskLevel: executionPolicy.risk.level,
      riskReasons: executionPolicy.risk.reasons,
      capabilities: executionPolicy.risk.capabilities,
      sandboxMode: exec.sandboxMode,
      modeUsed: exec.modeUsed,
      sandboxed: exec.sandboxed,
      fallbackReason: exec.fallbackReason
    })
    let effect
    try {
      effect = await completeEffectExecution(effectHandle, exec)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const confirmedEffect = confirmedEffectFromArtifactProjectionError(error)
      if (confirmedEffect) {
        return {
          ...exec,
          ok: false,
          output: `${exec.output}\n\n外部操作已确认，但 Artifact/Evidence/Acceptance 登记失败:${message}`,
          effectStatus: confirmedEffect.status
        }
      }
      return {
        ...exec,
        ok: false,
        output: `${exec.output}\n\n外部操作结果未能写入效果账本，已进入未知结果保护:${message}`,
        effectStatus: 'waiting_reconciliation'
      }
    }
    try {
      const finalized = await this.persistProducedArtifacts(await finalizeOfficeRevisionToolResult(exec, effect, app.getPath('userData')), effectInput)
      return effect ? { ...finalized, effectStatus: effect.status } : finalized
    } catch (error) {
      const { producedArtifacts: _internal, ...publicExec } = exec
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...publicExec,
        ok: false,
        output: `${exec.output}\n\nArtifact/Evidence/Acceptance 登记失败:${message}`,
        ...(effect ? { effectStatus: effect.status } : {})
      }
    }
  }

  private async persistProducedArtifacts(
    exec: ToolExecResult,
    effectInput: PrepareEffectExecutionInput
  ): Promise<ToolExecResult> {
    const { producedArtifacts, ...publicExec } = exec
    if (!exec.ok || !producedArtifacts?.length) return publicExec
    const projectId = this.meta.workspaceId ?? this.meta.projectId
    if (!projectId) {
      if (producedArtifacts.some((artifact) => artifact.requiredCanonicalRegistration)) {
        throw new Error('artifact_register 只允许在 Project-owned Session 中使用')
      }
      return publicExec
    }
    const run = taskRuntimeRegistry.get(this.meta.id)
    if (!run) throw new Error(`Project Session 缺少当前 TaskRun:${this.meta.id}`)
    const bindings = await registerSessionProducedArtifacts({
      sessionId: this.meta.id,
      projectId,
      creatingRunId: run.id,
      producerInvocationId: effectInput.toolUseId,
      artifacts: producedArtifacts.map((artifact) => ({
        kind: artifact.kind,
        title: artifact.title,
        content: { storageKind: 'source_ref' as const, sourceRef: artifact.path },
        lineageKey: artifact.lineageKey,
        mediaType: artifact.mediaType,
        producer: artifact.producer,
        metadata: {
          toolName: effectInput.toolName,
          toolUseId: effectInput.toolUseId,
          ...artifact.metadata
        },
        evidenceKind: artifact.evidenceKind,
        evidenceSummary: artifact.evidenceSummary,
        evidenceVerifier: artifact.evidenceVerifier,
        acceptanceStatus: artifact.acceptanceStatus,
        acceptanceCriterion: artifact.acceptanceCriterion
      })),
      rootInput: {
        workflowRoot: app.getPath('userData'),
        workspaceRoot: app.getPath('userData')
      }
    })
    const summary = bindings.map((binding) =>
      `${binding.artifactId} v${binding.version} / ${binding.evidenceId} / ${binding.acceptanceId}`)
    return {
      ...publicExec,
      output: `${publicExec.output}\n\nCanonical delivery:\n${summary.join('\n')}`
    }
  }

  private async markEffectStarted(
    effectHandle: EffectExecutionHandle,
    effectInput: PrepareEffectExecutionInput
  ): Promise<NativeToolExecutionResult | undefined> {
    try {
      await markEffectExecutionStarted(effectHandle, effectInput)
      return undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const reason = `外部副作用账本启动标记失败，已阻止执行:${message}`
      try {
        await cancelEffectExecution(effectHandle, reason)
        return {
          ok: false,
          output: reason,
          effectStatus: effectHandle ? 'abandoned' : undefined
        }
      } catch (cancelError) {
        const cancelMessage = cancelError instanceof Error ? cancelError.message : String(cancelError)
        return {
          ok: false,
          output: `${reason}\n\n取消结果未能写入效果账本，已进入未知结果保护:${cancelMessage}`,
          effectStatus: 'waiting_reconciliation'
        }
      }
    }
  }
}

const NON_BYPASSABLE_TOOLS = new Set([
  'mcp_call_tool',
  'git_push',
  'git_create_issue',
  'send_notification'
])

function requiresExplicitApprovalDespiteBypass(name: string, riskLevel: ToolRiskLevel): boolean {
  return riskLevel === 'critical' || riskLevel === 'high' || NON_BYPASSABLE_TOOLS.has(name) ||
    name.toLowerCase().startsWith('mcp__')
}
import { isCouncilSession } from './council/council-request-guard'
