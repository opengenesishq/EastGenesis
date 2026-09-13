import { describeOfficeRevisionReplay } from './office-revision/replay'
import { officeRevisionToolGate } from './office-revision/intent'
import { finalizeOfficeRevisionToolResult } from './office-revision/producer'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
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
import { classifyToolCapabilities } from './permission/tool-capabilities'
import { taskRuntimeRegistry, type ToolIdempotencyDecision } from './task/task-runtime-registry'
import { registerSessionProducedArtifacts } from './task/session-artifact-producer'
import { isDisabledModeInspectionToolCall, isReadOnlyToolCall, isSideEffectingToolCall } from './task/tool-idempotency'
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
export type NativeToolPermissionDecision = { allow: boolean; message?: string }

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
    }

interface PendingPermission {
  resolve: (result: NativeToolPermissionDecision) => void
  info: PermissionRequestInfo
}

const LOCAL_EXECUTION_DISABLED_MESSAGE =
  'Agent 本地执行能力已禁用:旧严格 Docker 设置不会自动降级为宿主机执行。当前仅保留最小项目检查能力，请先在设置 > 权限中确认启用。'

/** Shared permission, durable Effect, execution, and audit runtime for CaoGen native tools. */
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
      const target = await describeOfficeArtifactReplayTarget(input, this.meta.cwd)
      return { targetDigest: effectReplayTargetDigest(target) }
    }
    const descriptor = await buildEffectDescriptor({
      sessionId: this.meta.id,
      toolName: name,
      toolInput: input,
      cwd: this.meta.cwd
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
    effectHandle?: EffectExecutionHandle | null
  ): Promise<NativeToolPermissionDecision> {
    const effectScope = effectHandle?.target && effectHandle.targetDigest
      ? permissionEffectScope(effectHandle.target, effectHandle.targetDigest)
      : undefined
    const preflight = this.preflightToolGate(name, input, toolUseId, effectHandle?.targetDigest)
    if (!preflight.allow) return preflight
    const { policy, readOnlyCall, guiDecision, toolCapabilityDecision, idempotency } = preflight

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
      return { allow: true, message: toolCapabilityDecision.reason }
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
      return { allow: true, message: policy.reason }
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
      return { allow: true }
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
    effectTargetDigest?: string
  ): NativeToolPreflightDecision {
    const workerPolicyError = officeRevisionToolGate(this.meta.id, name, input) ?? digitalWorkerToolPolicyError(this.meta, name, input, app.getPath('userData'))
    if (workerPolicyError) return { allow: false, message: workerPolicyError }
    const settings = settingsForCaoGenDrive(getSettings(), this.meta.driveMode)
    const policy = evaluateToolPermission(settings, { toolName: name, input, cwd: this.meta.cwd })
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
    if (!strategyDecision.allow) {
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
      cwd: this.meta.cwd
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
      cwd: this.meta.cwd,
      effectTargetDigest
    })
    const idempotency = taskRuntimeRegistry.evaluateTool({
      sessionId: this.meta.id,
      cwd: this.meta.cwd,
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
    return { allow: true, policy, readOnlyCall, guiDecision, toolCapabilityDecision, idempotency }
  }

  async executeToolWithPermission(
    name: string,
    input: Record<string, unknown>,
    toolUseId: string,
    signal?: AbortSignal
  ): Promise<NativeToolExecutionResult> {
    if (signal?.aborted) return { ok: false, output: '操作已中断，未进入权限判断' }
    const preflight = this.preflightToolGate(name, input, toolUseId)
    if (preflight.allow === false) {
      return { ok: false, output: `操作已被权限策略拒绝${preflight.message ? `:${preflight.message}` : ''}` }
    }
    const effectInput: PrepareEffectExecutionInput = {
      sessionId: this.meta.id,
      cwd: this.meta.cwd,
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

    const gate = await this.awaitToolPermission(name, input, toolUseId, effectHandle)
    if (!gate.allow) {
      return this.settlePermissionDenial(effectHandle, gate)
    }
    const interruptedAfterGate = await this.cancelIfAborted(
      signal,
      effectHandle,
      '操作在审批后、外部执行前已中断'
    )
    if (interruptedAfterGate) return interruptedAfterGate
    return this.executeAllowedTool(name, input, effectHandle, effectInput, signal)
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
    effectHandle: EffectExecutionHandle
  ): Promise<NativeToolPermissionDecision> {
    try {
      return await this.gateTool(name, input, toolUseId, effectHandle)
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
    source: 'policy' | 'permission-mode' | 'task-strategy' | 'idempotency',
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
    signal?: AbortSignal
  ): Promise<NativeToolExecutionResult> {
    const settings = settingsForCaoGenDrive(getSettings(), this.meta.driveMode)
    const interruptedBeforeStart = await this.cancelIfAborted(
      signal,
      effectHandle,
      '操作在外部执行前已中断'
    )
    if (interruptedBeforeStart) return interruptedBeforeStart
    const startFailure = await this.markEffectStarted(effectHandle, effectInput)
    if (startFailure) return startFailure
    const interruptedAfterStart = await this.cancelIfAborted(
      signal,
      effectHandle,
      '操作在外部执行前已中断'
    )
    if (interruptedAfterStart) return interruptedAfterStart
    let exec: ToolExecResult
    try {
      exec = await executeCodingTool(name, input, this.meta.cwd, {
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
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        output: `外部工具执行异常，结果未知:${message}`,
        effectStatus: effectHandle ? 'waiting_reconciliation' : undefined
      }
    }
    const executionPolicy = evaluateToolPermission(settings, {
      toolName: name,
      input,
      cwd: this.meta.cwd
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
