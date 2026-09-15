import { preparationPermissionSystemPrompt } from './permission/preparation-tool-scope'
import { taskExecutionAuthoritySystemPrompt } from './permission/task-execution-authority-prompt'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { assertPersistedSessionExecutionAllowed } from './session-execution-ownership'
import {
  documentAttachmentsToPrompt,
  imageAttachmentRefToContentBlock,
  sessionImageAttachmentsRoot
} from './attachmentOps'
import {
  aggregateAnthropicUsage,
  appendMissingSuffix,
  anthropicErrorText,
  anthropicToolResultBlock,
  assistantEventBlocks,
  assistantHistoryContent,
  buildAnthropicUserContent,
  durableImageReferences,
  finalStopFailure,
  type AnthropicImageResolver
} from './anthropic-history'
import { rebuildSessionAnthropicHistory } from './session-anthropic-history'
import { nativeRequestBudgetInput } from './model/native-request-budget'
import { boundedCouncilBody, claimCouncilPhysicalRequest } from './council/council-request-guard'
import {
  type AnthropicMessagesContentBlock,
  type AnthropicMessagesMessage,
  type AnthropicMessagesResult,
  type AnthropicMessagesTool,
  type AnthropicMessagesToolInputSchema,
  type AnthropicMessagesToolUseBlock
} from './anthropicMessagesAdapter'
import {
  createAnthropicEngineDependencies,
  type AnthropicEngineDependencies
} from './anthropic-engine-dependencies'
import { anthropicAdditionalContextItems } from './anthropic-outbound-context'
import { NativeToolRuntime, type NativeToolExecutionResult } from './native-tool-runtime'
import { augmentNativePayloadWithLayeredMemory } from './native-layered-prompt'
import { OPENAI_CODING_TOOLS } from './openaiTools'
import { buildProjectContextSystemAppendSync } from './agent/context-loader'
import type { AnthropicMessagesTarget } from './provider/anthropicMessagesTarget'
import { getSettings } from './settings'
import { resolveNativeSessionTarget, nativeModelProtocol, nativeModelErrorSubtype } from './model/native-session-target'
import { nativeSessionRecoveryContext, assertNativeSessionRecoveryTarget } from './model/native-recovery-session'
import { nativeHttpRefusalEvidence } from './model/native-http-refusal'
import { emitNativeUserMessage } from './native-user-message'
import { listHistory } from './history'
import { normalizeStableMessagePayload, type StableMessagePayload } from './stable-message-payload'
import {
  isModelAttemptOperationError, isModelAttemptPersistenceError, unwrapModelAttemptOperationError
} from './task/model-attempt-runtime'
import { runHasUnresolvedEffects } from './task/effect-runtime'
import { taskStrategySystemAppend, updateTaskStrategyMeta } from './task/task-strategy'
import { buildWorkflowStageHandoffPrompt } from './task/workflow-stage-handoff'
import { buildUserRulesSystemAppendSync } from './user-rules'
import {
  assertOutboundContextAllowed,
  OutboundContextPolicyError,
  prepareOutboundContext
} from './project-workspace/outbound-context-policy'
import { effectiveSessionModel } from './provider/engine-provider-utils'
import { estimateModelAttemptCostUsd } from './provider/modelAttemptCost'
import { buildProviderNeutralContextDigest } from './task/provider-neutral-context'
import { redactProviderCredentials } from './providerCredentialRuntime'
import {
  fetchWithProviderCredentialLease,
  providerCredentialScopeForSession
} from './providerRuntimeAuth'
import {
  assertDigitalWorkerProviderDispatchAllowed,
  isDigitalWorkerProviderDispatchDeniedError
} from './digital-worker/session-action-policy'
import { TranscriptWriter } from './transcript'
import {
  providerChatCheckpointId,
  restoreProviderChatCheckpoint
} from './provider-chat-checkpoint'
import {
  createAnthropicRecoveryState,
  isAnthropicRecoveryEnabled,
  recoverAnthropicTarget,
  rememberAnthropicRecoveryTarget
} from './provider/anthropicRecovery'
import { AUTO_MODEL } from '../shared/types'
import type { Engine, EngineEmit } from './engine'
import type {
  AgentEvent,
  CheckpointRestoreMode,
  CheckpointRestoreResult,
  OutboundContextManifest,
  PermissionModeId,
  PermissionRequestInfo,
  SendMessagePayload,
  SessionMeta,
  TranscriptEntry,
  UserMessageAttachmentView,
  UsageTotals
} from '../shared/types'
const DEFAULT_MAX_TOKENS = 8192
const MAX_MESSAGES_REQUESTS_PER_TURN = 40
/** Anthropic tool declarations derive from the shared native coding-tool source. */
export const ANTHROPIC_CODING_TOOLS: AnthropicMessagesTool[] = OPENAI_CODING_TOOLS.map((tool) => ({
  name: tool.function.name,
  description: tool.function.description,
  input_schema: tool.function.parameters as AnthropicMessagesToolInputSchema
}))
interface AnthropicAttemptLineage {
  requestId: string
  failoverFromAttemptId: string
  routeReason: string
}
interface AnthropicMessageResponse {
  result: AnthropicMessagesResult
  target: AnthropicMessagesTarget
}

interface AnthropicRecoveryTarget {
  target: AnthropicMessagesTarget
  routeReason: string
}

/** Native Anthropic Messages engine registered under the distinct `anthropic` kind. */
export class AnthropicEngine implements Engine {
  readonly meta: SessionMeta
  private readonly transcript: TranscriptWriter
  private readonly emitRaw: (event: AgentEvent) => void
  private readonly dependencies: AnthropicEngineDependencies
  private readonly nativeToolRuntime: NativeToolRuntime
  private readonly historyImageResolver: AnthropicImageResolver
  private abort: AbortController | null = null
  private activeTurn: Promise<void> | null = null
  private activeOutboundContext?: OutboundContextManifest
  private disposePromise: Promise<void> | null = null
  private disposed = false
  private turnStartedAt = 0
  private activeMessageId?: string
  private turnRevisionEligible = false
  private turnHadToolEvents = false
  private assistantText = ''
  private thinkingText = ''
  private turnUsage: UsageTotals | undefined
  private history: AnthropicMessagesMessage[] = []
  private resolvedModel?: string
  private recoveryState = createAnthropicRecoveryState()
  private recoveryExhaustedEmitted = false
  private forkBoundaryPending = false

  constructor(
    meta: SessionMeta,
    emit: EngineEmit,
    resumeSdkSessionId?: string,
    initialEventSeq = 0,
    dependencies: Partial<AnthropicEngineDependencies> = {}
  ) {
    this.meta = meta
    this.resolvedModel = meta.modelRoutingDecision?.providerId === meta.providerId ? meta.modelRoutingDecision.model : undefined
    this.transcript = new TranscriptWriter(resumeSdkSessionId, initialEventSeq)
    if (!resumeSdkSessionId && meta.conversationForkSourceSdkSessionId) {
      this.transcript.seedFrom(meta.conversationForkSourceSdkSessionId, meta.conversationForkCheckpointId)
      this.forkBoundaryPending = true
    }
    this.emitRaw = (event) => {
      const entry = this.transcript.nextEntry(event)
      emit(entry.event, entry.seq, entry)
    }
    this.dependencies = createAnthropicEngineDependencies(meta, dependencies)
    this.nativeToolRuntime = new NativeToolRuntime(this.meta, (event) => this.emit(event))
    const sourceSessionId = meta.conversationForkSourceSdkSessionId
      ? listHistory().find((entry) => entry.sdkSessionId === meta.conversationForkSourceSdkSessionId)?.id
      : undefined
    this.historyImageResolver = dependencies.resolveImageAttachment ?? ((reference: UserMessageAttachmentView) =>
      imageAttachmentRefToContentBlock(
        reference,
        sessionImageAttachmentsRoot(app.getPath('userData'), sourceSessionId ?? meta.id)
      ) as AnthropicMessagesContentBlock
    )
    this.history = rebuildSessionAnthropicHistory(meta, this.transcript.readAll(), this.historyImageResolver)
    if (resumeSdkSessionId && meta.runtimeContinuation?.state !== 'prepared') {
      this.meta.sdkSessionId = resumeSdkSessionId
      this.emit({ kind: 'init', sdkSessionId: resumeSdkSessionId, model: effectiveSessionModel(this.meta, this.resolvedModel) })
    }
  }

  async start(): Promise<void> {
    if (this.disposed) return
    this.setStatus('starting')
    try {
      const target = resolveNativeSessionTarget({ meta: this.meta, dependencies: this.dependencies, emit: (event) => this.emit(event) })
      this.resolvedModel = target.model
      if (!this.meta.sdkSessionId) {
        this.meta.sdkSessionId = `${this.dependencies.sessionIdPrefix}-${randomUUID()}`
        this.emit({ kind: 'init', sdkSessionId: this.meta.sdkSessionId, model: target.model })
      }
      if (this.forkBoundaryPending) {
        this.forkBoundaryPending = false
        this.emit({
          kind: 'hook-event',
          event: 'conversation-forked',
          detail: '已从本地会话账本创建独立会话；未复用来源 Provider 的服务端上下文。'
        })
      }
      this.setStatus('idle')
    } catch (error) {
      this.setStatus('error', anthropicErrorText(error))
    }
  }

  send(input: string | SendMessagePayload): void {
    if (this.disposed) return
    if (this.abort) {
      this.rejectSend('上一轮仍在运行,请等待完成或中断后再发送。')
      return
    }
    const payload = normalizeStableMessagePayload(input)
    if (!payload.text && payload.images.length === 0 && payload.documents.length === 0) return
    const messageId = payload.messageId || randomUUID()
    this.activeMessageId = messageId
    this.turnRevisionEligible = payload.images.length === 0 && payload.documents.length === 0
    this.turnHadToolEvents = false
    this.dependencies.modelAttempts.startTurn(messageId)
    let attachments: UserMessageAttachmentView[]
    try {
      attachments = durableImageReferences(payload.images)
    } catch (error) {
      this.rejectSend(anthropicErrorText(error))
      return
    }
    emitNativeUserMessage({ meta: this.meta, payload, messageId, attachments, emit: (event) => this.emit(event) })

    this.assistantText = ''
    this.thinkingText = ''
    this.turnUsage = undefined
    this.turnStartedAt = Date.now()
    this.recoveryExhaustedEmitted = false
    this.recoveryState = createAnthropicRecoveryState(this.meta.providerId)
    const controller = new AbortController()
    this.abort = controller
    this.setStatus('running')
    const turn = this.runTurn(payload, controller)
    this.activeTurn = turn
    void turn.finally(() => {
      if (this.activeTurn === turn) this.activeTurn = null
    })
  }

  rejectSend(message: string): void {
    this.setStatus(this.abort ? 'running' : 'error', message)
  }

  async interrupt(): Promise<void> {
    this.nativeToolRuntime.rejectAllPending('已中断')
    const activeTurn = this.activeTurn
    if (!activeTurn) return
    this.abort?.abort()
    await activeTurn.catch(() => undefined)
  }

  respondPermission(requestId: string, allow: boolean, message?: string): void {
    this.nativeToolRuntime.respondPermission(requestId, allow, message)
  }

  pendingPermissions(): PermissionRequestInfo[] {
    return this.nativeToolRuntime.pendingPermissions()
  }

  getTranscript(): TranscriptEntry[] {
    return this.transcript.read()
  }

  async restoreCheckpoint(
    messageId: string,
    mode: CheckpointRestoreMode,
    dryRun: boolean
  ): Promise<CheckpointRestoreResult> {
    if (this.abort) {
      return { mode, checkpointId: messageId, canRewind: false, applied: false, error: '会话仍在运行' }
    }
    const result = restoreProviderChatCheckpoint(this.transcript, messageId, mode, dryRun, (entries) => {
      this.history = rebuildSessionAnthropicHistory(this.meta, entries, this.historyImageResolver)
    })
    if (result.applied) {
      this.emit({
        kind: 'checkpoint-restore',
        messageId,
        mode: 'chat',
        filesChanged: [],
        chatRemovedEntries: result.chatRemovedEntries,
        note: '已恢复到所选消息之前的聊天状态'
      })
    }
    return result
  }

  emitSyntheticEvent(event: AgentEvent): void {
    if (!this.disposed) this.emit(event)
  }

  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    this.meta.permissionMode = mode
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  async setTaskStrategy(strategy: SessionMeta['taskStrategy']): Promise<void> {
    this.nativeToolRuntime.rejectAllPending('任务策略已切换，原审批已作废')
    updateTaskStrategyMeta(this.meta, strategy, (meta) => this.emit({ kind: 'meta', meta }))
  }

  async setModel(model: string): Promise<void> {
    this.meta.routingScope = model === AUTO_MODEL ? (this.meta.routingScope === 'global' ? 'global' : 'provider') : 'fixed'
    this.meta.model = model
    this.resolvedModel = model && model !== AUTO_MODEL ? model : undefined
    this.meta.modelRoutingDecision = undefined
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  rename(title: string): void {
    const value = title.trim()
    if (!value) return
    this.meta.title = value.slice(0, 60)
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposePromise = this.disposeAndWait()
    return this.disposePromise
  }

  async retireForContinuation(): Promise<void> {
    if (this.abort || this.pendingPermissions().length) throw new Error('执行中引擎不能交接')
    await this.activeTurn
    this.disposed = true
  }

  private async runTurn(payload: StableMessagePayload, controller: AbortController): Promise<void> {
    try {
      const target = resolveNativeSessionTarget({ meta: this.meta, dependencies: this.dependencies, emit: (event) => this.emit(event), payload })
      rememberAnthropicRecoveryTarget(this.recoveryState, target)
      this.resolvedModel = target.model
      const layered = await augmentNativePayloadWithLayeredMemory(payload, this.meta, app.getPath('userData'))
      const layeredPayload = layered.payload
      const handoff = await buildWorkflowStageHandoffPrompt(this.meta, app.getPath('userData'))
        .catch((error) => {
          console.error('[caogen] workflow stage handoff retrieval failed:', error)
          return ''
        })
      const outbound = await prepareOutboundContext({
        meta: this.meta,
        rootDir: app.getPath('userData'),
        payload: layeredPayload,
        providerId: target.providerId,
        model: target.model,
        additionalItems: anthropicAdditionalContextItems(
          handoff,
          this.history.length > 0,
          layered.hasMemoryContext
        )
      })
      this.activeOutboundContext = outbound.manifest
      const projectResources = outbound.resourceContext.prompt
      const documentPrompt = documentAttachmentsToPrompt(
        payload.documents,
        sessionImageAttachmentsRoot(app.getPath('userData'), this.meta.id)
      )
      const enrichedPayload = handoff || projectResources || documentPrompt
        ? {
            ...payload,
            text: [projectResources, handoff, documentPrompt, '## Current User Request', layeredPayload.text]
              .filter(Boolean)
              .join('\n\n')
          }
        : layeredPayload
      const userContent = buildAnthropicUserContent(enrichedPayload, this.dependencies.resolveImageAttachment)
      await this.runMessagesLoop(target, userContent, controller)
    } catch (error) {
      this.finishTurnError(error, controller)
    } finally {
      if (this.abort === controller) this.abort = null
    }
  }

  private async runMessagesLoop(
    target: AnthropicMessagesTarget,
    userContent: AnthropicMessagesContentBlock[],
    controller: AbortController
  ): Promise<void> {
    const turnMessages: AnthropicMessagesMessage[] = [{ role: 'user', content: userContent }]
    let activeTarget = target
    for (let requestIndex = 0; requestIndex < MAX_MESSAGES_REQUESTS_PER_TURN; requestIndex += 1) {
      if (controller.signal.aborted) throw new Error('已中断')
      const response = await this.requestMessage(activeTarget, turnMessages, controller)
      activeTarget = response.target
      const finished = await this.handleMessageResult(
        response.result,
        response.target,
        requestIndex,
        turnMessages,
        controller
      )
      if (finished) return
    }
    this.finishTurn(true, 'Anthropic Messages 工具循环异常退出', 'tool-loop-limit')
  }

  private async requestMessage(
    target: AnthropicMessagesTarget,
    turnMessages: AnthropicMessagesMessage[],
    controller: AbortController
  ): Promise<AnthropicMessageResponse> {
    const textOffset = this.assistantText.length
    const thinkingOffset = this.thinkingText.length
    let activeTarget = target
    let lineage: AnthropicAttemptLineage | undefined
    while (true) {
      if (!this.dependencies.acquireProviderRequest(activeTarget.providerId)) {
        const recovery = this.recoverTarget(activeTarget, 'Provider circuit is open')
        if (!recovery) throw new Error('Provider circuit is open')
        activeTarget = recovery.target
        lineage = undefined
        continue
      }
      const attemptStartedAt = Date.now()
      try {
        const result = await this.executeMessageAttempt(
          activeTarget,
          turnMessages,
          controller,
          lineage
        )
        this.recordAttemptSuccess(activeTarget, Date.now() - attemptStartedAt)
        this.appendUnstreamedResult(result, textOffset, thinkingOffset)
        this.recordUsage(result)
        return { result, target: activeTarget }
      } catch (error) {
        if (!isModelAttemptOperationError(error)) {
          this.dependencies.releaseProviderRequest(activeTarget.providerId)
          throw error
        }
        const operationError = error.operationError
        const failureText = anthropicErrorText(operationError)
        this.dependencies.recordFailure(
          activeTarget.providerId,
          redactProviderCredentials(failureText)
        )
        if (!this.logicalRequestCanReplay(controller, textOffset, thinkingOffset)) throw error
        const recovery = this.recoverTarget(activeTarget, failureText, nativeHttpRefusalEvidence(operationError)?.outcome)
        if (!recovery) throw error
        lineage = {
          requestId: error.requestId,
          failoverFromAttemptId: error.attemptId,
          routeReason: recovery.routeReason
        }
        activeTarget = recovery.target
      }
    }
  }

  private executeMessageAttempt(
    target: AnthropicMessagesTarget,
    turnMessages: AnthropicMessagesMessage[],
    controller: AbortController,
    lineage?: AnthropicAttemptLineage
  ): Promise<AnthropicMessagesResult> {
    const projectContext = [buildUserRulesSystemAppendSync(), buildProjectContextSystemAppendSync(this.meta.sourceCwd ?? this.meta.cwd)].filter(Boolean).join('\n\n')
    const request = this.dependencies.applyRuntimeToRequest({
      model: target.model,
      maxTokens: DEFAULT_MAX_TOKENS,
      system: taskStrategySystemAppend(this.meta.taskStrategy, projectContext, preparationPermissionSystemPrompt(this.meta, app.getPath('userData')), taskExecutionAuthoritySystemPrompt(this.meta, app.getPath('userData'))),
      messages: [...this.history, ...turnMessages],
      tools: ANTHROPIC_CODING_TOOLS,
      extraBody: target.credentialProvider.advancedConfig?.request?.body
    }, target.credentialProvider.advancedConfig?.runtime)
    rememberAnthropicRecoveryTarget(this.recoveryState, target)
    if (target.keyId) this.dependencies.markProviderKeyUsed(target.providerId, target.keyId)
    const body = boundedCouncilBody(this.meta, this.dependencies.buildWireBody(request), target.providerId, target.model, 'anthropic.messages') as Record<string, unknown>
    const assertPhysicalRequestAllowed = async (): Promise<void> => {
      await assertPersistedSessionExecutionAllowed(this.meta, app.getPath('userData'))
      // The SDK may issue more than one physical request during a single
      // Messages attempt. Re-run the canonical route and outbound policy gate
      // for every such request, rather than relying only on the outer attempt
      // preflight.
      assertNativeSessionRecoveryTarget(this.meta, target, this.dependencies.listProviders(), this.dependencies.getSettings())
      await assertDigitalWorkerProviderDispatchAllowed(this.meta, app.getPath('userData'), {
        providerId: target.providerId,
        model: target.model,
        protocol: nativeModelProtocol(this.dependencies.recoveryEngineKind)
      })
      const manifest = this.activeOutboundContext
      if (!manifest) {
        throw new OutboundContextPolicyError(
          'OUTBOUND_CONTEXT_STALE',
          '模型请求缺少外发上下文清单，已阻止发送'
        )
      }
      await assertOutboundContextAllowed({
        manifest,
        rootDir: app.getPath('userData'),
        providerId: target.providerId,
        model: target.model,
        engine: this.meta.engine
      })
    }
    return this.dependencies.modelAttempts.execute({
      run: this.dependencies.getRun(this.meta.id),
      providerId: target.providerId,
      model: target.model,
      routeReason: this.meta.modelRoutingDecision?.selectionReason,
      endpoint: target.endpoint,
      method: 'POST',
      body, budgetScope: nativeRequestBudgetInput({ meta: this.meta, providerId: target.providerId, model: target.model, body }),
      canonicalContextDigest: buildProviderNeutralContextDigest({
        entries: this.transcript.readAll(),
        outboundContext: this.activeOutboundContext
      }),
      signal: controller.signal,
      auth: { keyId: target.keyId, keyLabel: target.keyLabel },
      estimateCost: (usage) => estimateModelAttemptCostUsd({
        providerId: target.providerId,
        model: target.model,
        protocol: nativeModelProtocol(this.dependencies.recoveryEngineKind)
      }, usage),
      preflight: async () => {
        await assertPhysicalRequestAllowed()
      },
      ...(lineage ?? {}),
      operation: (operationId) => this.dependencies.streamMessage({
        endpoint: target.endpoint,
        headers: target.headers,
        timeouts: target.timeouts,
        request,
        signal: controller.signal,
        onText: (text) => this.appendText(text),
        onThinking: (text) => this.appendThinking(text),
        fetch: async (url, init = {}) => {
          await assertPhysicalRequestAllowed()
          const wire = boundedCouncilBody(this.meta, init.body, target.providerId, target.model, 'anthropic.messages')
          await claimCouncilPhysicalRequest(this.meta, typeof url === 'string' ? url : url.toString())
          const scope = providerCredentialScopeForSession(this.meta, target.providerId, operationId)
          const selection = target.issueCredentialLease(scope)
          if (target.credentialProvider.authMode !== 'none' && (!selection.available || !selection.lease)) {
            throw new Error('Provider credential lease is unavailable')
          }
          return fetchWithProviderCredentialLease({
            provider: target.credentialProvider,
            lease: selection.lease,
            scope,
            url: typeof url === 'string' ? url : url.toString(),
            init: { ...init, body: wire as RequestInit['body'], headers: target.headers }
          })
        }
      })
    })
  }

  private logicalRequestCanReplay(
    controller: AbortController,
    textOffset: number,
    thinkingOffset: number
  ): boolean {
    return !this.disposed &&
      !controller.signal.aborted &&
      this.assistantText.length === textOffset &&
      this.thinkingText.length === thinkingOffset &&
      !runHasUnresolvedEffects(this.dependencies.getRun(this.meta.id))
  }

  private recoverTarget(
    current: AnthropicMessagesTarget,
    failureText: string,
    nativeRetryReason?: 'rate_limited' | 'auth_failed'
  ): AnthropicRecoveryTarget | undefined {
    const failure = this.dependencies.classifyFailure(failureText)
    const settings = this.dependencies.getSettings()
    const providers = this.dependencies.listProviders()
    const recovery = recoverAnthropicTarget({
      recovery: nativeSessionRecoveryContext(this.meta, settings),
      current,
      failure,
      settings,
      providers,
      meta: this.meta,
      outboundContext: this.activeOutboundContext,
      state: this.recoveryState,
      resolveTarget: this.dependencies.resolveTarget,
      canRotateProviderKey: this.dependencies.canRotateProviderKey,
      rotateProviderKey: this.dependencies.rotateProviderKey,
      pickFailoverTarget: this.dependencies.pickFailoverTarget,
      pickProviderModelFailoverTarget: this.dependencies.pickProviderModelFailoverTarget,
      engineKind: this.dependencies.recoveryEngineKind
      ,nativeRetryReason
    })
    if (!recovery) {
      if (!this.recoveryExhaustedEmitted
        && isAnthropicRecoveryEnabled(current.providerId, settings.failoverEnabled, providers) && failure.switchable) {
        this.recoveryExhaustedEmitted = true
        this.emit({
          kind: 'provider-recovery-exhausted',
          engine: this.dependencies.recoveryEngineKind,
          providerId: current.providerId,
          providerName: current.providerName,
          model: current.model,
          reason: failure.label
        })
      }
      return undefined
    }
    this.resolvedModel = recovery.target.model
    this.emit(recovery.event)
    if (recovery.metaChanged) this.emit({ kind: 'meta', meta: { ...this.meta } })
    return { target: recovery.target, routeReason: recovery.routeReason }
  }

  private recordAttemptSuccess(target: AnthropicMessagesTarget, latencyMs: number): void {
    if (target.keyId) this.dependencies.recordProviderKeySuccess(target.providerId, target.keyId)
    this.dependencies.recordSuccess(target.providerId, latencyMs)
  }

  private async handleMessageResult(
    result: AnthropicMessagesResult,
    target: AnthropicMessagesTarget,
    requestIndex: number,
    turnMessages: AnthropicMessagesMessage[],
    controller: AbortController
  ): Promise<boolean> {
    const assistantContent = assistantHistoryContent(result, this.dependencies.requiresThinkingSignature(target))
    const toolUses = assistantContent.filter(
      (block): block is AnthropicMessagesToolUseBlock => block.type === 'tool_use'
    )
    if (assistantContent.length > 0) turnMessages.push({ role: 'assistant', content: assistantContent })
    if (toolUses.length === 0) return this.completeFinalResponse(result, turnMessages)
    if (result.stopReason !== 'tool_use') return this.rejectInvalidToolResponse(result, toolUses)
    if (requestIndex === MAX_MESSAGES_REQUESTS_PER_TURN - 1) {
      return this.rejectToolLoopLimit(result, toolUses)
    }
    const toolResults = await this.executeToolBatch(result, toolUses, controller)
    if (!toolResults) return true
    turnMessages.push({ role: 'user', content: toolResults })
    return false
  }

  private completeFinalResponse(
    result: AnthropicMessagesResult,
    turnMessages: AnthropicMessagesMessage[]
  ): true {
    this.emitAssistantResult(result)
    const stopFailure = finalStopFailure(result.stopReason)
    if (stopFailure) {
      this.finishTurn(true, stopFailure.message, stopFailure.subtype)
      return true
    }
    this.history.push(...turnMessages)
    this.finishTurn(false, result.text || undefined, result.stopReason)
    return true
  }

  private rejectInvalidToolResponse(
    result: AnthropicMessagesResult,
    toolUses: AnthropicMessagesToolUseBlock[]
  ): true {
    this.emitAssistantResult(result)
    this.emitSkippedToolResults(toolUses, 0, `未执行:异常 stop_reason ${result.stopReason || 'missing'}`)
    this.finishTurn(true, 'Anthropic 工具响应的 stop_reason 无效', 'protocol-stop')
    return true
  }

  private rejectToolLoopLimit(
    result: AnthropicMessagesResult,
    toolUses: AnthropicMessagesToolUseBlock[]
  ): true {
    this.emitAssistantResult(result)
    this.emitSkippedToolResults(toolUses, 0, '未执行:单轮 Messages 请求已达上限')
    this.finishTurn(
      true,
      `已达单轮 Messages 请求上限 ${MAX_MESSAGES_REQUESTS_PER_TURN} 次,未执行无法回灌结果的工具调用`,
      'tool-loop-limit'
    )
    return true
  }

  private async executeToolBatch(
    result: AnthropicMessagesResult,
    toolUses: AnthropicMessagesToolUseBlock[],
    controller: AbortController
  ): Promise<AnthropicMessagesContentBlock[] | undefined> {
    const toolResults: AnthropicMessagesContentBlock[] = []
    let emittedAssistantResult = false
    for (let toolIndex = 0; toolIndex < toolUses.length; toolIndex += 1) {
      const toolUse = toolUses[toolIndex]
      if (controller.signal.aborted) {
        if (!emittedAssistantResult) this.emitAssistantResult(result)
        this.emitSkippedToolResults(toolUses, toolIndex, '未执行:本轮已中断')
        throw new Error('已中断')
      }
      this.emit({ kind: 'tool-start', toolUseId: toolUse.id, name: toolUse.name })
      if (!emittedAssistantResult) {
        this.emitAssistantResult(result)
        emittedAssistantResult = true
      }
      const execution = await this.executeNativeTool(toolUse, toolUses, toolIndex, controller)
      if (this.effectIsUnresolved(execution)) {
        this.emitSkippedToolResults(toolUses, toolIndex + 1, '未执行:前序工具效果状态未知')
        this.finishTurn(
          true,
          `工具效果状态未知,需先完成对账:${toolUse.name}(${toolUse.id})`,
          'effect-unknown'
        )
        return undefined
      }
      if (controller.signal.aborted) {
        this.emitSkippedToolResults(toolUses, toolIndex + 1, '未执行:本轮已中断')
        throw new Error('已中断')
      }
      toolResults.push(anthropicToolResultBlock(toolUse, execution))
    }
    return toolResults
  }

  private async executeNativeTool(
    toolUse: AnthropicMessagesToolUseBlock,
    toolUses: AnthropicMessagesToolUseBlock[],
    toolIndex: number,
    controller: AbortController
  ): Promise<NativeToolExecutionResult> {
    try {
      const execution = await this.nativeToolRuntime.executeToolWithPermission(
        toolUse.name,
        toolUse.input,
        toolUse.id,
        controller.signal
      )
      this.emitToolResult(toolUse.id, execution)
      return execution
    } catch (error) {
      this.emit({
        kind: 'tool-result',
        toolUseId: toolUse.id,
        content: `工具运行时异常:${anthropicErrorText(error)}`,
        isError: true
      })
      this.emitSkippedToolResults(toolUses, toolIndex + 1, '未执行:前序工具运行时异常')
      throw error
    }
  }
  private emitToolResult(toolUseId: string, execution: NativeToolExecutionResult): void {
    this.emit({
      kind: 'tool-result',
      toolUseId,
      content: execution.output,
      isError: !execution.ok,
      ...(execution.exitCode === undefined ? {} : { exitCode: execution.exitCode }),
      ...(execution.commandTermination ? { commandTermination: execution.commandTermination } : {}),
      effectStatus: execution.effectStatus
    })
  }
  private effectIsUnresolved(execution: NativeToolExecutionResult): boolean {
    return execution.effectStatus === 'waiting_reconciliation' ||
      runHasUnresolvedEffects(this.dependencies.getRun(this.meta.id))
  }

  private finishTurnError(error: unknown, controller: AbortController): void {
    if (isDigitalWorkerProviderDispatchDeniedError(error)) {
      this.finishTurn(true, error.message, 'policy-denied')
      return
    }
    if (error instanceof OutboundContextPolicyError) {
      this.finishTurn(true, error.message, 'outbound-policy-denied')
      return
    }
    if (isModelAttemptPersistenceError(error)) {
      const phase = error.phase === 'start' ? '启动' : '完成'
      this.finishTurn(
        true,
        redactProviderCredentials(`模型请求账本${phase}落盘失败:${error.message}`),
        'ledger-error'
      )
      return
    }
    if (controller.signal.aborted) {
      this.finishTurn(true, '已中断', 'interrupted')
      return
    }
    this.finishTurn(
      true,
      redactProviderCredentials(anthropicErrorText(unwrapModelAttemptOperationError(error))),
      nativeModelErrorSubtype(error)
    )
  }

  private appendText(text: string): void {
    if (!text) return
    this.assistantText += text
    this.emit({ kind: 'text-delta', text })
  }

  private appendThinking(text: string): void {
    if (!text) return
    this.thinkingText += text
    this.emit({ kind: 'thinking-delta', text })
  }

  private appendUnstreamedResult(
    result: AnthropicMessagesResult,
    textOffset: number,
    thinkingOffset: number
  ): void {
    appendMissingSuffix(result.text, this.assistantText.slice(textOffset), (text) => this.appendText(text))
    appendMissingSuffix(
      result.thinking,
      this.thinkingText.slice(thinkingOffset),
      (text) => this.appendThinking(text)
    )
  }

  private recordUsage(result: AnthropicMessagesResult): void {
    this.turnUsage = aggregateAnthropicUsage(this.turnUsage, result)
    this.meta.usage = this.turnUsage
    this.meta.contextTokens = result.usage.input + result.usage.cacheRead + result.usage.cacheCreation
  }

  private emitSkippedToolResults(
    toolUses: AnthropicMessagesToolUseBlock[],
    startIndex: number,
    reason: string
  ): void {
    for (const toolUse of toolUses.slice(startIndex)) {
      this.emit({
        kind: 'tool-result',
        toolUseId: toolUse.id,
        content: reason,
        isError: true
      })
    }
  }

  private emitAssistantResult(result: AnthropicMessagesResult): void {
    const blocks = assistantEventBlocks(result)
    if (blocks.length > 0) this.emit({ kind: 'assistant-message', blocks })
  }

  private finishTurn(isError: boolean, resultText?: string, subtype = 'success'): void {
    if (this.disposed) return
    this.emit({
      kind: 'turn-result',
      subtype: isError ? subtype : 'success',
      isError,
      durationMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : undefined,
      resultText: isError ? resultText : this.assistantText.trim() || resultText,
      usage: this.turnUsage
    })
    if (this.activeMessageId && this.turnRevisionEligible && !this.turnHadToolEvents) {
      this.emit({
        kind: 'checkpoint',
        messageId: providerChatCheckpointId(this.activeMessageId),
        userMessageId: this.activeMessageId,
        scope: 'chat'
      })
    }
    this.activeMessageId = undefined
    this.turnRevisionEligible = false
    this.turnHadToolEvents = false
    if (isError) this.setStatus('error', resultText)
    else this.setStatus('idle')
  }
  private emit(event: AgentEvent): void {
    if (event.kind === 'tool-start' || event.kind === 'tool-result' ||
        event.kind === 'permission-request' || event.kind === 'permission-resolved') {
      this.turnHadToolEvents = true
    }
    this.emitRaw(event)
  }

  private setStatus(status: SessionMeta['status'], error?: string): void {
    this.meta.status = status
    if (error) this.meta.lastError = error
    this.emit({ kind: 'status', status, error })
  }

  private async disposeAndWait(): Promise<void> {
    this.disposed = true
    this.nativeToolRuntime.rejectAllPending('会话已关闭')
    this.abort?.abort()
    const activeTurn = this.activeTurn
    if (activeTurn) await activeTurn.catch(() => undefined)
    this.abort = null
    this.setStatus('closed')
  }
}
