import { preparationPermissionSystemPrompt } from './permission/preparation-tool-scope'
import { taskExecutionAuthoritySystemPrompt } from './permission/task-execution-authority-prompt'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { assertPersistedSessionExecutionAllowed } from './session-execution-ownership'
import { isUnroutedLocalPlan } from './session-local-plan'
import { documentAttachmentsToPrompt, sessionImageAttachmentsRoot } from './attachmentOps'
import { TranscriptWriter } from './transcript'
import {
  getProvider,
  listProviders,
  markProviderKeyUsed,
  recordProviderKeySuccess,
  issueDirectProviderCredentialLease,
  issueProviderCredentialLease,
  rotateProviderKey
} from './providers'
import {
  fetchWithProviderCredentialLease,
  providerCredentialScopeForSession
} from './providerRuntimeAuth'
import {
  ensureProviderAuthorizationFresh,
  issueProviderAuthorizationAccountLease,
  recordProviderAuthorizationAccountFailure,
} from './provider/providerAuthorizationService'
import { resolveOpenAiAuthConfig, type OpenAIAuthConfig } from './provider/openAiAuthorizationRouting'
import {
  acquireProviderRequest,
  classifyFailure,
  recordFailure,
  releaseProviderRequest,
  recordSuccess
} from './scheduler'
import { recordModelFailure, recordModelSuccess } from './modelStats'
import { getSettings } from './settings'
import { sessionRouteEvent } from './model/session-runtime-routing'
import { withNativeRecoveryBoundary } from './model/native-recovery-boundary'
import { resolveOpenAiSessionTurnRoute, nativeSessionRecoveryContext, assertNativeSessionRecoveryTarget } from './model/native-recovery-session'
import { frozenRetryAllows, frozenSameTargetRetryAllows } from './model/native-recovery-session'
import { runHasUnresolvedEffects } from './task/effect-runtime'
import { nativeHttpRefusalEvidence } from './model/native-http-refusal'
import { runtimeConversationReplay, validateRuntimeContinuationContext } from './session-runtime-continuation-context'
import { rebuildOpenAiTextHistory } from './openai-text-history'
import { persistContextPack, restoreContextPack } from './agent/context-pack-persistence'
import { nativeRequestBudgetInput } from './model/native-request-budget'
import { boundedCouncilBody, claimCouncilPhysicalRequest } from './council/council-request-guard'
import { nativeTurnRejection } from './model/native-turn-rejection'
import { boundedOpenAiRequestBody } from './model/native-output-limit'
import { emitNativeUserMessage } from './native-user-message'
import { canRotateProviderKey } from './providerKeyRouting'
import { OPENAI_CODING_TOOLS, RESPONSES_CODING_TOOLS } from './openaiTools'
import { NativeToolRuntime, type NativeToolExecutionResult } from './native-tool-runtime'
import { buildProjectContextSystemAppendSync } from './agent/context-loader'
import { augmentNativePayloadWithLayeredMemory } from './native-layered-prompt'
import { nativeAdditionalContextItems } from './anthropic-outbound-context'
import {
  adaptChatCompletionRequest, buildChinaProviderPromptAppend, type ProviderAdapterContext
} from './model/llm-providers/china-provider-adapter'
import {
  DEFAULT_KEEP_RECENT_MESSAGES, estimateContextTokens, evaluateContextUsage,
  planCompressionBoundary, type ContextUsageState
} from './agent/context-compressor'
import { isGuiToolName } from './agent/tools/gui-tools'
import { taskRuntimeRegistry } from './task/task-runtime-registry'
import { effectReplayTargetDigest } from './task/effect-reconciler'
import { taskStrategySystemPrompt, updateTaskStrategyMeta } from './task/task-strategy'
import { buildWorkflowStageHandoffPrompt } from './task/workflow-stage-handoff'
import { nativeRecoveryHandoffPrompt } from './task/native-recovery-handoff'
import { sessionModelHandoffPrompt } from './agent/session-model-handoff'
import { buildUserRulesSystemAppendSync } from './user-rules'
import {
  assertOutboundContextAllowed,
  OutboundContextPolicyError,
  prepareOutboundContext
} from './project-workspace/outbound-context-policy'
import {
  consumeOpenAIChatResponse,
  consumeOpenAIResponsesResponse,
  type OpenAIChatToolCall,
  type OpenAIResponsesToolCall
} from './protocol-adapters/openai-compatible-stream'
import {
  openAiEndpoint,
  parseProviderHeaders,
  redactProviderBaseUrl,
  redactProviderErrorText
} from './provider/openai-provider-utils'
import { applyProviderRequestOverrides } from './provider/providerRequestOverrides'
import { estimateModelAttemptCostUsd } from './provider/modelAttemptCost'
import { resolveOpenAIProtocol, resolveProviderRuntimeTarget } from './provider/providerRuntimeTarget'
import {
  ProviderRequestDeadline,
  providerRequestIsStreaming,
  providerRequestTimeouts
} from './provider/providerRequestTimeout'
import {
  firstSuccessfulRecovery,
  OpenAiRecoveryState,
  planOpenAiProviderFailover,
  planOpenAiProviderModelRecovery,
  planOpenAiProtocolRecovery
} from './provider/openAiProviderModelRecovery'
import { normalizeStableMessagePayload } from './stable-message-payload'
import {
  providerChatCheckpointId,
  restoreProviderChatCheckpoint
} from './provider-chat-checkpoint'
import {
  buildConfirmedToolReplayIndex,
  findConfirmedToolReplay,
  portableConversationReplayDetail,
  recordConfirmedToolReplay,
  type ConfirmedToolReplayIndex
} from './conversation-ledger-replay'
import { isModelAttemptPersistenceError, unwrapModelAttemptOperationError } from './task/model-attempt-runtime'
import { addUsageTotals, OpenAIModelAttemptTracker } from './task/openai-model-attempt-runtime'
import { buildProviderNeutralContextDigest } from './task/provider-neutral-context'
import type {
  ChatContent,
  ChatMessage,
  OpenAIErrorContext,
  TurnToolFailure
} from './openAiEngineTypes'
import { formatProviderErrorContext, isResponsesConversationContext } from './openAiEngineTypes'
import {
  assertDigitalWorkerProviderDispatchAllowed
} from './digital-worker/session-action-policy'
import { AUTO_MODEL } from '../shared/types'
import type { Engine, EngineEmit, EngineFactory } from './engine'
import type {
  AgentEvent,
  AssistantBlock,
  CheckpointRestoreMode,
  CheckpointRestoreResult,
  EffectStatus,
  ImageAttachmentView,
  OpenAIProtocol,
  OutboundContextManifest,
  PermissionModeId,
  PermissionRequestInfo,
  Provider,
  ResponsesConversationContext,
  SendMessagePayload,
  SessionMeta,
  TranscriptEntry,
  UsageTotals
} from '../shared/types'

const DEFAULT_OPENAI_MODEL = 'gpt-4.1'

/** Agent 循环上限:防模型无限调工具烧穿 */
const MAX_TOOL_ITERATIONS = 40

/**
 * OpenAIEngine —— 原生 OpenAI 协议适配器,支持两种协议:
 * - 'responses':OpenAI 原生 Responses API(/v1/responses,协议默认)
 * - 'chat':通用 Chat Completions(/v1/chat/completions)——DeepSeek/Qwen/
 *   new-api 网关/自部署 vLLM·Ollama 等几乎所有 OpenAI 兼容端点都讲这个协议。
 * 协议按 Provider 的 openaiProtocol 字段选择。
 *
 * 多轮上下文:chat 协议在内存维护 user/assistant 历史并随每轮全量发送;
 * resume 时从转录重建。responses 路径持久化受 Provider/模型/协议/Key 约束的
 * server response id；身份不匹配时丢弃该优化并回退本地转录。
 * OpenAI 的工具调用与本地文件编辑权限模型暂未桥接,因此权限请求如实为空。
 */
export class OpenAIEngine implements Engine {
  readonly meta: SessionMeta
  private readonly transcript: TranscriptWriter
  private readonly emitRaw: (event: AgentEvent) => void
  private abort: AbortController | null = null
  private disposed = false
  private activeTurn: Promise<void> | null = null
  private activeOutboundContext?: OutboundContextManifest
  private disposePromise: Promise<void> | null = null
  private assistantText = ''
  private turnUsage: UsageTotals | undefined
  private turnStartedAt = 0
  private activeMessageId?: string
  private activeConfirmedToolReplay: ConfirmedToolReplayIndex = new Map()
  private turnRevisionEligible = false
  private turnHadToolEvents = false
  private readonly modelAttempts = new OpenAIModelAttemptTracker()
  private readonly nativeToolRuntime: NativeToolRuntime
  /** chat 协议的多轮历史(user/assistant/tool);responses 协议不使用 */
  private chatHistory: ChatMessage[] = []
  /** 本轮流式累积的工具调用(SSE delta 分片拼装) */
  private pendingToolCalls: OpenAIChatToolCall[] = []
  /** 本轮 GUI 工具失败;最终文本不能掩盖真实桌面自动化失败 */
  private turnGuiToolFailures: TurnToolFailure[] = []
  private lastContextPressure: NonNullable<SessionMeta['contextPressure']> = 'normal'
  private forkBoundaryPending = false

  constructor(
    meta: SessionMeta,
    emit: EngineEmit,
    resumeSdkSessionId?: string,
    initialEventSeq = 0
  ) {
    this.meta = meta
    this.routedModel = meta.modelRoutingDecision?.providerId === meta.providerId ? meta.modelRoutingDecision.model : undefined
    this.transcript = new TranscriptWriter(resumeSdkSessionId, initialEventSeq)
    if (!resumeSdkSessionId && meta.conversationForkSourceSdkSessionId) {
      this.transcript.seedFrom(meta.conversationForkSourceSdkSessionId, meta.conversationForkCheckpointId)
      this.forkBoundaryPending = true
    }
    this.emitRaw = (event) => {
      const entry = this.transcript.nextEntry(event)
      emit(entry.event, entry.seq, entry)
    }
    this.nativeToolRuntime = new NativeToolRuntime(this.meta, (event) => this.emit(event))
    validateRuntimeContinuationContext(meta, this.transcript.readAll())
    this.restoreResponsesContext()
    if (resumeSdkSessionId && meta.runtimeContinuation?.state !== 'prepared') {
      this.meta.sdkSessionId = resumeSdkSessionId
      this.rebuildChatHistory()
      this.emit({ kind: 'init', sdkSessionId: resumeSdkSessionId, model: this.effectiveModel() })
    }
  }

  /** resume 时从转录重建 chat 协议的多轮历史(仅文本;图片不回放) */
  private rebuildChatHistory(): void {
    const entries = this.transcript.read()
    const persisted = restoreContextPack(app.getPath('userData'), this.meta.id)
    // Compression itself emits a post-boundary `meta` snapshot and the
    // `context-compressed` hook after the durable pack write. Those runtime
    // observations do not invalidate the pack; any conversational event after
    // the boundary still forces a transcript rebuild so newer turns win.
    const trailing = persisted
      ? entries.filter((entry) => entry.seq > persisted.boundarySeq)
      : []
    const trailingRuntimeOnly = trailing.every((entry) =>
      entry.event.kind === 'meta' ||
      (entry.event.kind === 'hook-event' && entry.event.event === 'context-compressed'))
    if (persisted && entries.at(-1)?.seq !== undefined && trailingRuntimeOnly) {
      this.chatHistory = [{ role: 'system', content: `[早期对话摘要 · 由 CaoGen 自动压缩]\n${persisted.summary}` }, ...persisted.recent]
      return
    }
    this.chatHistory = rebuildOpenAiTextHistory(entries)
  }

  async start(): Promise<void> {
    if (this.disposed) return
    this.setStatus('starting')
    if (!isUnroutedLocalPlan(this.meta)) {
      const auth = this.authConfig()
      if (!auth.available && auth.authMode !== 'none') {
        this.setStatus('error', this.missingKeyMessage())
        return
      }
    }
    if (!this.meta.sdkSessionId) {
      this.meta.sdkSessionId = `openai-${randomUUID()}`
      this.emit({ kind: 'init', sdkSessionId: this.meta.sdkSessionId, model: this.effectiveModel() })
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
  }

  send(input: string | SendMessagePayload): void {
    if (this.disposed) return
    if (this.abort) {
      this.rejectSend('上一轮仍在运行,请等待完成或中断后再发送。')
      return
    }
    const normalizedPayload = normalizeStableMessagePayload(input)
    if (!normalizedPayload.text && normalizedPayload.images.length === 0 && normalizedPayload.documents.length === 0) return

    const messageId = normalizedPayload.messageId || randomUUID()
    const payload: SendMessagePayload = { ...normalizedPayload, messageId }
    this.activeMessageId = messageId
    this.activeConfirmedToolReplay = new Map()
    this.turnRevisionEligible = normalizedPayload.images.length === 0 && normalizedPayload.documents.length === 0
    this.turnHadToolEvents = false
    this.modelAttempts.startTurn(messageId)
    emitNativeUserMessage({ meta: this.meta, payload, messageId, emit: (event) => this.emit(event),
      attachments: payload.images?.map((image) => ({ id: image.id, mime: image.mime, bytes: image.bytes })) })

    this.turnStartedAt = Date.now()
    this.assistantText = ''
    this.turnUsage = undefined
    this.turnGuiToolFailures = []
    this.recoveryExhaustedEmitted = false
    // 新一轮:重置故障切换防打转记录
    // auto 模式:跨厂商路由(openai 引擎切 Provider 无需重建,authConfig 每请求现读)
    try { this.autoRoute(payload) } catch (error) {
      const resultText = error instanceof Error ? error.message : String(error)
      this.emit({ kind: 'turn-result', isError: true, resultText, subtype: 'routing-blocked', durationMs: 0 })
      this.rejectSend(resultText)
      return
    }
    // Initialize after auto routing so failover cannot select the active Provider again.
    this.recoveryState = new OpenAiRecoveryState(this.meta.providerId)
    this.abort = new AbortController()
    this.setStatus('running')
    const turn = this.runResponse(payload, this.abort)
    this.activeTurn = turn
    void turn.then(
      () => {
        if (this.activeTurn === turn) this.activeTurn = null
      },
      () => {
        if (this.activeTurn === turn) this.activeTurn = null
      }
    )
  }

  /** 本轮路由选中的模型(meta.model 保持 auto 哨兵,下一轮重新路由) */
  private routedModel?: string

  /** Each turn reuses the same capability, budget and business-line policy as creation. */
  private autoRoute(payload: SendMessagePayload): void {
    const route = resolveOpenAiSessionTurnRoute(this.meta, payload, this.effectiveModel())
    if (!route) return
    if (route.providerId !== this.meta.providerId || route.model !== this.effectiveModel()) {
      this.clearResponsesContext(this.protocol() === 'responses')
      this.protocolOverride = undefined
    }
    this.modelAttempts.setRouteReason(route.reason)
    this.routedModel = route.model
    this.meta.providerId = route.providerId
    this.meta.modelRoutingDecision = route.decision
    this.emit(sessionRouteEvent(route))
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  rejectSend(message: string): void {
    this.setStatus(this.abort ? 'running' : 'error', message)
  }

  async interrupt(): Promise<void> {
    // 先拒掉挂起的审批,否则 Agent 循环会永远等在 gateTool 上
    this.rejectAllPendingPerms('已中断')
    const activeTurn = this.activeTurn
    if (!activeTurn) return
    this.abort?.abort()
    await activeTurn.catch(() => undefined)
  }

  /** 中断/销毁时统一拒绝所有挂起审批,防 Agent 循环悬挂 */
  private rejectAllPendingPerms(message: string): void {
    this.nativeToolRuntime.rejectAllPending(message)
  }

  respondPermission(requestId: string, allow: boolean, message?: string): void {
    this.nativeToolRuntime.respondPermission(requestId, allow, message)
  }

  pendingPermissions(): PermissionRequestInfo[] {
    return this.nativeToolRuntime.pendingPermissions()
  }

  private async executeToolWithPermission(
    name: string,
    input: Record<string, unknown>,
    toolUseId: string,
    signal?: AbortSignal
  ): Promise<NativeToolExecutionResult> {
    return this.nativeToolRuntime.executeToolWithPermission(name, input, toolUseId, signal)
  }

  private async confirmedFailoverToolOutput(
    index: ConfirmedToolReplayIndex,
    name: string,
    input: Record<string, unknown>,
    toolUseId: string
  ): Promise<string | undefined> {
    if (index.size === 0) return undefined
    const target = await this.nativeToolRuntime.describeSideEffectTarget(name, input).catch(() => null)
    if (!target) return undefined
    const confirmed = findConfirmedToolReplay(index, name, target.targetDigest)
    if (!confirmed) {
      const indexedTargets = [...index.values()]
        .filter((candidate) => candidate.toolName === name)
        .map((candidate) => candidate.targetDigest.slice(0, 12))
        .join(',')
      this.emit({
        kind: 'hook-event',
        event: 'confirmed-tool-replay-miss',
        toolName: name,
        detail: `Failover replay target ${target.targetDigest.slice(0, 12)} did not match indexed targets ${indexedTargets || 'none'}`
      })
      return undefined
    }
    this.emit({
      kind: 'hook-event',
      event: 'confirmed-tool-failover-replay',
      toolName: name,
      detail: `Reused confirmed target result ${confirmed.toolUseId} for failover call ${toolUseId}`
    })
    return [
      '[CaoGen confirmed side-effect replay]',
      `A ${name} operation for the same external target already completed successfully in this user turn.`,
      `Local result digest: sha256:${confirmed.resultDigest}`,
      'Do not execute this operation again. Continue from the confirmed success.'
    ].join('\n')
  }

  private confirmedEffectReplayTargets(): ReadonlyMap<string, string> {
    const targets = new Map<string, string>()
    for (const effect of taskRuntimeRegistry.get(this.meta.id)?.effects ?? []) {
      if (effect.status !== 'confirmed') continue
      targets.set(effect.toolUseId, effectReplayTargetDigest(effect.target))
    }
    return targets
  }

  private refreshConfirmedToolReplay(messageId?: string): void {
    const confirmed = buildConfirmedToolReplayIndex(
      this.transcript.read(),
      messageId,
      this.confirmedEffectReplayTargets()
    )
    if (confirmed.size === 0) return
    this.activeConfirmedToolReplay = new Map([
      ...this.activeConfirmedToolReplay,
      ...confirmed
    ])
  }

  private rememberConfirmedToolReplay(input: {
    toolUseId: string
    toolName: string
    targetDigest?: string
    resultContent: string
    isError: boolean
    effectStatus?: EffectStatus
  }): void {
    if (input.isError || input.effectStatus !== 'confirmed' || !input.targetDigest) return
    this.activeConfirmedToolReplay = recordConfirmedToolReplay(this.activeConfirmedToolReplay, {
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      targetDigest: input.targetDigest,
      resultContent: input.resultContent
    })
    this.emit({
      kind: 'hook-event',
      event: 'confirmed-tool-replay-indexed',
      toolName: input.toolName,
      detail: `Indexed confirmed side effect ${input.toolUseId} target ${input.targetDigest.slice(0, 12)} for current-turn failover replay`
    })
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
    const result = restoreProviderChatCheckpoint(this.transcript, messageId, mode, dryRun, () => {
      this.rebuildChatHistory()
      this.clearResponsesContext(true)
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
    if (this.disposed) return
    this.emit(event)
  }

  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    this.meta.permissionMode = mode
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  async setTaskStrategy(strategy: SessionMeta['taskStrategy']): Promise<void> {
    this.nativeToolRuntime.rejectAllPending('任务策略已切换，原审批已作废')
    updateTaskStrategyMeta(this.meta, strategy, (meta) => this.emit({ kind: 'meta', meta }))
  }

  async setModel(model: string, providerId?: string): Promise<void> {
    // A task routing transaction also resets AUTO's previously resolved target.
    // Rebuild from the local transcript even when the provider/model labels match.
    if (providerId !== undefined) this.clearResponsesContext(true)
    else if (this.meta.model !== model) this.clearResponsesContext(this.protocol() === 'responses')
    this.protocolOverride = undefined
    if (providerId !== undefined) this.meta.providerId = providerId
    this.meta.routingScope = model === AUTO_MODEL ? (this.meta.routingScope === 'global' ? 'global' : 'provider') : 'fixed'
    this.meta.model = model
    this.routedModel = undefined
    this.meta.modelRoutingDecision = undefined
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  rename(title: string): void {
    const t = title.trim()
    if (!t) return
    this.meta.title = t.slice(0, 60)
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

  private async disposeAndWait(): Promise<void> {
    this.disposed = true
    this.rejectAllPendingPerms('会话已关闭')
    this.abort?.abort()
    this.setStatus('closed')
    const activeTurn = this.activeTurn
    if (activeTurn) await activeTurn.catch(() => undefined)
    this.abort = null
  }

  private async runResponse(payload: SendMessagePayload, controller: AbortController): Promise<void> {
    let auth: OpenAIAuthConfig | undefined
    try {
      const prepared = await this.augmentPayloadWithLayeredMemory(payload)
      this.activeOutboundContext = prepared.manifest
      auth = this.authConfig()
      assertNativeSessionRecoveryTarget(this.meta, { providerId: auth.providerId, model: this.effectiveModel(), baseUrl: auth.baseUrl })
      this.modelAttempts.setRouteReason(auth.authorizationRouteReason ?? 'Session uses the configured provider and model')
      this.recoveryState.models(this.meta.providerId).add(this.effectiveModel())
      if (!auth.available && auth.authMode !== 'none') throw new Error(this.missingKeyMessage())
      if (!acquireProviderRequest(this.meta.providerId)) {
        const circuitError = 'Provider circuit is open'
        if (await this.tryFailover(circuitError, payload)) return
        this.emitRecoveryExhausted(circuitError)
        this.finishTurn(true, this.withProviderErrorContext(circuitError), 'error')
        return
      }
      if (auth.keyId) {
        this.recoveryState.keys.add(auth.keyId)
        markProviderKeyUsed(this.meta.providerId, auth.keyId)
      }

      if (this.protocol() === 'chat') {
        await this.runChatCompletion(prepared.payload, controller, auth)
      } else {
        await this.runResponsesLoop(prepared.payload, controller, auth)
      }
      const latency = Date.now() - this.turnStartedAt
      if (auth.keyId) recordProviderKeySuccess(this.meta.providerId, auth.keyId)
      recordSuccess(this.meta.providerId, latency)
      recordModelSuccess(this.effectiveModel(), latency)
      this.finishTurn(false)
    } catch (err) {
      const aborted = controller.signal.aborted
      if (aborted) {
        releaseProviderRequest(this.meta.providerId)
        this.finishTurn(true, '已中断', 'interrupted')
        return
      }
      const rejection = nativeTurnRejection(err)
      if (rejection) {
        releaseProviderRequest(this.meta.providerId)
        this.finishTurn(true, rejection.message, rejection.subtype)
        return
      }
      if (isModelAttemptPersistenceError(err)) {
        releaseProviderRequest(this.meta.providerId)
        const phase = err.phase === 'start' ? '启动' : '完成'
        this.finishTurn(true, `模型请求账本${phase}落盘失败，已阻止请求重放:${err.message}`, 'ledger-error')
        return
      }
      await withNativeRecoveryBoundary(async () => {
        const operationError = unwrapModelAttemptOperationError(err)
        const refusal = nativeHttpRefusalEvidence(operationError)
        const nativeRetryReason = refusal?.outcome
        const text = errText(operationError)
        releaseProviderRequest(this.meta.providerId)
        if (await this.trySameTargetRetry(text, payload, controller, nativeRetryReason)) return
        if (await this.tryProviderKeyFailover(text, payload, controller, auth, nativeRetryReason)) return
        recordFailure(this.meta.providerId, text)
        recordModelFailure(this.effectiveModel())
        if (await firstSuccessfulRecovery(
          () => this.tryProviderModelFailover(text, payload, controller, nativeRetryReason),
          () => this.tryFailover(text, payload, nativeRetryReason),
          () => this.tryProtocolFailover(text, payload, controller, nativeRetryReason)
        )) return
        this.emitRecoveryExhausted(text)
        this.finishTurn(true, this.withProviderErrorContext(text), 'error')
      }, ({ message, subtype }) => this.finishTurn(true, message, subtype))
    }
  }

  private async augmentPayloadWithLayeredMemory(payload: SendMessagePayload): Promise<{
    payload: SendMessagePayload
    manifest: OutboundContextManifest
  }> {
    const layered = await augmentNativePayloadWithLayeredMemory(
      {
        ...payload,
        images: payload.images ?? [],
        documents: payload.documents ?? []
      },
      this.meta,
      app.getPath('userData')
    )
    const handoff = await buildWorkflowStageHandoffPrompt(this.meta, app.getPath('userData'))
      .catch((error) => {
        console.error('[caogen] workflow stage handoff retrieval failed:', error)
        return ''
      })
    const recoveryHandoff = await nativeRecoveryHandoffPrompt(
      this.meta,
      taskRuntimeRegistry.get(this.meta.id),
      app.getPath('userData')
    )
    const modelHandoff = sessionModelHandoffPrompt(this.meta.modelChange?.handoff, this.meta, this.transcript.readAll())
    const handoffContext = [modelHandoff, handoff, recoveryHandoff].filter(Boolean).join('\n\n')
    const outbound = await prepareOutboundContext({
      meta: this.meta,
      rootDir: app.getPath('userData'),
      payload: layered.payload,
      providerId: this.meta.providerId,
      model: this.effectiveModel(),
      additionalItems: nativeAdditionalContextItems(
        handoffContext,
        this.chatHistory.length > 0 || Boolean(this.lastResponseId),
        layered.hasMemoryContext
      )
    })
    const projectResources = outbound.resourceContext.prompt
    const documentPrompt = documentAttachmentsToPrompt(
      payload.documents ?? [],
      sessionImageAttachmentsRoot(app.getPath('userData'), this.meta.id)
    )
    const enriched = handoffContext.trim() || projectResources.trim() || documentPrompt.trim()
      ? {
        ...layered.payload,
        text: [
          projectResources,
          handoffContext,
          documentPrompt,
          '## Current User Request',
          layered.payload.text
        ]
          .filter((item) => item.trim().length > 0)
          .join('\n\n')
      }
      : layered.payload
    return { payload: enriched, manifest: outbound.manifest }
  }

  /** 本轮已试过的厂商(防切换打转);send 时重置 */
  private recoveryState = new OpenAiRecoveryState()
  private protocolOverride?: { providerId: string; from: 'responses'; to: 'chat' }
  private recoveryExhaustedEmitted = false
  /** Responses 协议的上一轮 response id(服务端多轮上下文) */
  private lastResponseId?: string
  /** 服务端链不可复用时，从本地耐久事件重建可移植上下文。 */
  private responsesReplayRequired = false
  /** 端点不支持 REST 模式的 previous_response_id 时置 true，后续请求跳过该字段 */
  private previousResponseIdUnsupported = false
  /** 本轮流式累积的 Responses 函数调用(按 output_index 拼装) */
  private pendingResponseCalls: OpenAIResponsesToolCall[] = []
  private static readonly MAX_FAILOVERS_PER_TURN = 3

  /**
   * 恢复前一轮 Responses 链时做严格身份校验。
   * AUTO 模型会把已落盘的实际模型带回本轮，避免重启后错误地从 Provider 首模型续链。
   */
  private restoreResponsesContext(): void {
    const context = this.meta.responsesContext
    if (!context) {
      this.responsesReplayRequired = this.transcript.read().length > 0
      return
    }
    if (!isResponsesConversationContext(context)) {
      this.meta.responsesContext = undefined
      this.responsesReplayRequired = this.transcript.read().length > 0
      return
    }
    if (this.meta.model === AUTO_MODEL) this.routedModel = context.model
    const currentKeyId = this.authConfig().keyId
    const keyMatches = (context.keyId ?? '') === (currentKeyId ?? '')
    const matches = this.protocol() === 'responses' &&
      context.providerId === this.meta.providerId &&
      context.model === this.effectiveModel() &&
      keyMatches
    if (matches) {
      this.lastResponseId = context.responseId
      return
    }
    // 不匹配时 fail closed:保留本地 Transcript，丢弃不可安全复用的服务端链。
    this.meta.responsesContext = undefined
    this.lastResponseId = undefined
    this.responsesReplayRequired = this.transcript.read().length > 0
  }

  private clearResponsesContext(requireReplay = true): void {
    this.lastResponseId = undefined
    if (this.meta.responsesContext) this.meta.responsesContext = undefined
    if (requireReplay) this.responsesReplayRequired = true
  }

  private rememberResponsesContext(responseId: string): void {
    const normalized = responseId.trim()
    if (!normalized || this.protocol() !== 'responses') return
    const previous = this.meta.responsesContext
    const currentKeyId = this.authConfig().keyId
    const context: ResponsesConversationContext = {
      responseId: normalized,
      providerId: this.meta.providerId,
      model: this.effectiveModel(),
      protocol: 'responses',
      ...(currentKeyId ? { keyId: currentKeyId } : {}),
      generation: previous &&
        previous.providerId === this.meta.providerId &&
        previous.model === this.effectiveModel() &&
        previous.protocol === 'responses'
        ? previous.generation + 1
        : 1,
      updatedAt: Date.now()
    }
    this.lastResponseId = normalized
    this.meta.responsesContext = context
    this.responsesReplayRequired = false
    // meta 事件进入 SessionManager 的统一持久化路径，形成重启可恢复的 ledger 游标。
    this.emit({ kind: 'meta', meta: { ...this.meta } })
  }

  /**
   * Responses 协议的 Agent 循环:与 chat 对等地接编码工具。
   * 首轮 input=用户消息;若返回 function_call,执行后以 function_call_output
   * 作为下一轮 input 回灌,并用 previous_response_id 续服务端上下文,直到
   * 无函数调用或达上限。工具的审批/执行复用与 chat 相同的 gateTool/executeCodingTool。
   */
  private async runResponsesLoop(
    payload: SendMessagePayload,
    controller: AbortController,
    auth: OpenAIAuthConfig
  ): Promise<void> {
    const replay = this.responsesReplayRequired
      ? runtimeConversationReplay(this.meta, this.transcript.read(), payload.messageId)
      : null
    if (replay) this.refreshConfirmedToolReplay(payload.messageId)
    const confirmedToolReplay = this.activeConfirmedToolReplay
    let input: unknown[] = [
      ...(replay ? [{ role: 'user', content: [{ type: 'input_text', text: replay.text }] }] : []),
      { role: 'user', content: buildInputContent(payload) }
    ]
    const statelessInput = [...input]
    if (replay) {
      this.emit({
        kind: 'hook-event',
        event: 'conversation-ledger-replay',
        detail: portableConversationReplayDetail(replay)
      })
    }

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      if (controller.signal.aborted) throw new Error('已中断')
      this.pendingResponseCalls = []
      const instructions = String(this.systemMessage().content ?? '')

      const body = {
        model: this.effectiveModel(),
        instructions,
        input,
        tools: RESPONSES_CODING_TOOLS,
        ...(this.lastResponseId && !this.previousResponseIdUnsupported
          ? { previous_response_id: this.lastResponseId }
          : {}),
        stream: true
      }
      const request = applyProviderRequestOverrides(
        auth.provider,
        openAiEndpoint(auth.baseUrl, 'responses'),
        body,
        openAIRequestHeaders(auth)
      )
      try {
        await this.fetchWithRetry(
          request.url,
          {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: controller.signal
          },
          controller.signal,
          auth,
          async (res) => {
            if (!res.ok) {
              const errMsg = await formatOpenAIError(res, this.openAIErrorContext(auth))
              // previous_response_id unsupported by endpoint: disable and fall back to full replay
              if (!this.previousResponseIdUnsupported &&
                  errMsg.includes('previous_response_id') &&
                  (res.status === 400 || res.status === 500)) {
                console.warn('[caogen] endpoint does not support previous_response_id; falling back to full context replay')
                this.previousResponseIdUnsupported = true
                this.lastResponseId = undefined
                this.responsesReplayRequired = true
                throw new Error('__PREVIOUS_RESPONSE_ID_UNSUPPORTED__')
              }
              throw new Error(errMsg)
            }
            await this.consumeResponse(res)
          }
        )
      } catch (err) {
        // previous_response_id fallback: replay the complete structured call/result chain.
        if (err instanceof Error && err.message === '__PREVIOUS_RESPONSE_ID_UNSUPPORTED__') {
          input = statelessInput
          continue
        }
        throw err
      }

      const calls = this.pendingResponseCalls.filter((c) => c.name && c.callId)
      this.pendingResponseCalls = []
      if (calls.length === 0) return // 最终文本回复,循环结束

      // 执行工具,结果作为下一轮 input(function_call_output);服务端已存住调用本身
      const outputs: unknown[] = []
      for (const call of calls) {
        if (controller.signal.aborted) throw new Error('已中断')
        let args: Record<string, unknown> = {}
        try {
          args = call.argsText ? (JSON.parse(call.argsText) as Record<string, unknown>) : {}
        } catch {
          // 参数非法 JSON:如实回给模型重试
        }
        const confirmedOutput = await this.confirmedFailoverToolOutput(
          confirmedToolReplay,
          call.name,
          args,
          call.callId
        )
        if (confirmedOutput) {
          outputs.push({
            type: 'function_call_output',
            call_id: call.callId,
            output: confirmedOutput
          })
          continue
        }
        const replayTarget = await this.nativeToolRuntime.describeSideEffectTarget(call.name, args).catch(() => null)
        this.emit({ kind: 'tool-start', toolUseId: call.callId, name: call.name })
        this.emit({
          kind: 'assistant-message',
          blocks: [{ type: 'tool_use', id: call.callId, name: call.name, input: args }]
        })
        const exec = await this.executeToolWithPermission(call.name, args, call.callId, controller.signal)
        const resultText = exec.output, isError = !exec.ok
        const effectStatus = exec.effectStatus
        this.recordGuiToolFailure(call.name, call.callId, resultText, isError)
        this.emit({
          kind: 'tool-result',
          toolUseId: call.callId,
          content: resultText,
          isError,
          ...(exec.exitCode === undefined ? {} : { exitCode: exec.exitCode }),
          ...(exec.commandTermination ? { commandTermination: exec.commandTermination } : {}),
          effectStatus
        })
        this.rememberConfirmedToolReplay({
          toolUseId: call.callId,
          toolName: call.name,
          targetDigest: replayTarget?.targetDigest,
          resultContent: resultText,
          isError,
          effectStatus
        })
        assertToolEffectSettled(effectStatus, call.name, call.callId)
        outputs.push({ type: 'function_call_output', call_id: call.callId, output: resultText })
      }
      statelessInput.push(
        ...calls.map((call) => ({
          type: 'function_call',
          call_id: call.callId,
          name: call.name,
          arguments: call.argsText
        })),
        ...outputs
      )
      // 支持服务端上下文时只发工具结果；无状态兼容端点必须重放匹配的结构化调用。
      input = this.previousResponseIdUnsupported ? statelessInput : outputs
    }
    this.appendText(`\n\n[已达单轮工具调用上限 ${MAX_TOOL_ITERATIONS} 次,任务可能未完成;请拆分任务后继续]`)
  }
  private async trySameTargetRetry(
    errorText: string,
    payload: SendMessagePayload,
    controller: AbortController,
    nativeRetryReason?: 'rate_limited' | 'auth_failed'
  ): Promise<boolean> {
    const settings = getSettings()
    const recovery = nativeSessionRecoveryContext(this.meta, settings)
    if (this.disposed || controller.signal.aborted || this.assistantText.length > 0 ||
        runHasUnresolvedEffects(taskRuntimeRegistry.get(this.meta.id)) ||
        !this.recoveryState.canRecover(this.meta.providerId, settings.failoverEnabled, recovery, nativeRetryReason) ||
        !frozenSameTargetRetryAllows({ recovery, providerId: this.meta.providerId, model: this.effectiveModel(),
          protocol: this.protocol() === 'responses' ? 'openai.responses' : 'openai.chat-completions',
          attempt: this.recoveryState.recoveryAttempts + 1,
          refusal: nativeRetryReason ? { outcome: nativeRetryReason } : undefined })) return false
    recordFailure(this.meta.providerId, errorText)
    recordModelFailure(this.effectiveModel())
    this.refreshConfirmedToolReplay(payload.messageId)
    this.clearResponsesContext(true)
    this.recoveryState.recordRecovery()
    const reason = `同一目标重试：${nativeRetryReason} (${this.recoveryState.recoveryAttempts})`
    this.modelAttempts.setRouteReason(reason)
    this.emit({ kind: 'hook-event', event: 'provider-same-target-retry', detail: reason })
    // The tracker keeps the refused request/attempt lineage. All ordinary
    // lease, circuit, outbound, budget and durable Attempt gates run again.
    await this.runResponse(payload, controller)
    return true
  }

  /** Recover the current logical request on another model before another Provider. */
  private async tryProviderModelFailover(
    errorText: string,
    payload: SendMessagePayload,
    controller: AbortController,
    nativeRetryReason?: 'rate_limited' | 'auth_failed'
  ): Promise<boolean> {
    const settings = getSettings()
    const providerId = this.meta.providerId?.trim()
    const recoveryContext = nativeSessionRecoveryContext(this.meta, settings)
    if (this.disposed || !providerId || !this.recoveryState.canRecover(providerId, settings.failoverEnabled, recoveryContext, nativeRetryReason)) return false
    const fromModel = this.effectiveModel()
    const failure = classifyFailure(errorText)
    const recovery = planOpenAiProviderModelRecovery({
      recovery: recoveryContext,
      providerId,
      fromModel,
      exclude: this.recoveryState.models(providerId),
      fallbackModel: settings.fallbackModel,
      failure,
      outboundContext: this.activeOutboundContext,
      routingExpertPolicy: settings.routingExpertPolicy
      ,nativeRetryReason, attempt: this.recoveryState.recoveryAttempts + 1
    })
    if (!recovery) return false

    const previousProtocol = this.protocol()
    this.refreshConfirmedToolReplay(payload.messageId)
    this.recoveryState.models(providerId).add(recovery.toModel)
    this.recoveryState.recordRecovery()
    if (this.meta.model === AUTO_MODEL) this.routedModel = recovery.toModel
    else this.meta.model = recovery.toModel
    const nextProtocol = this.protocol()
    this.clearResponsesContext(
      previousProtocol === 'responses' || nextProtocol === 'responses' || Boolean(this.lastResponseId)
    )
    this.modelAttempts.setRouteReason(recovery.routeReason)
    this.emit({
      kind: 'provider-model-failover',
      providerId,
      providerName: recovery.providerName,
      fromModel,
      toModel: recovery.toModel,
      reason: recovery.routeReason
    })
    this.emit({ kind: 'meta', meta: { ...this.meta } })
    await this.runResponse(payload, controller)
    return true
  }

  private async tryFailover(errorText: string, payload: SendMessagePayload, nativeRetryReason?: 'rate_limited' | 'auth_failed'): Promise<boolean> {
    const settings = getSettings()
    const recoveryContext = nativeSessionRecoveryContext(this.meta, settings)
    if (this.disposed || !this.recoveryState.canRecover(this.meta.providerId, settings.failoverEnabled, recoveryContext, nativeRetryReason)) return false
    if (this.recoveryState.providers.size > OpenAIEngine.MAX_FAILOVERS_PER_TURN) return false
    const failure = classifyFailure(errorText)
    const fromId = this.meta.providerId
    const target = planOpenAiProviderFailover({
      recovery: recoveryContext,
      currentProviderId: fromId,
      currentModel: this.effectiveModel(),
      exclude: this.recoveryState.providers,
      fallbackProviderId: settings.fallbackProviderId,
      fallbackModel: settings.fallbackModel,
      failure,
      currentProtocol: this.protocol(),
      outboundContext: this.activeOutboundContext,
      routingExpertPolicy: settings.routingExpertPolicy
      ,nativeRetryReason, attempt: this.recoveryState.recoveryAttempts + 1
    })
    if (!target) return false

    this.refreshConfirmedToolReplay(payload.messageId)
    const requiresPortableReplay = this.protocol() === 'responses' || Boolean(this.lastResponseId)
    this.recoveryState.providers.add(target.providerId)
    this.recoveryState.recordRecovery()
    this.meta.providerId = target.providerId
    this.protocolOverride = undefined
    if (target.model) {
      if (this.meta.model === AUTO_MODEL) this.routedModel = target.model
      else this.meta.model = target.model
    }
    // Responses 的 response id 不跨厂商;换家后重新开始服务端上下文链
    this.clearResponsesContext(requiresPortableReplay)
    this.modelAttempts.setRouteReason(target.routeReason)
    this.emit({
      kind: 'failover',
      fromProviderId: fromId,
      toProviderId: target.providerId,
      fromName: target.fromName,
      toName: target.name,
      model: target.model,
      reason: target.routeReason
    })
    this.emit({ kind: 'meta', meta: { ...this.meta } })

    const controller = new AbortController()
    this.abort = controller
    await this.runResponse(payload, controller)
    return true
  }

  private async tryProtocolFailover(
    errorText: string,
    payload: SendMessagePayload,
    controller: AbortController,
    nativeRetryReason?: 'rate_limited' | 'auth_failed'
  ): Promise<boolean> {
    const settings = getSettings()
    const providerId = this.meta.providerId?.trim()
    const recoveryContext = nativeSessionRecoveryContext(this.meta, settings)
    if (this.disposed || !providerId || !this.recoveryState.canRecover(providerId, settings.failoverEnabled, recoveryContext, nativeRetryReason)
      || this.protocol() !== 'responses') return false
    const recovery = planOpenAiProtocolRecovery({
      recovery: recoveryContext,
      providerId,
      model: this.effectiveModel(),
      currentProtocol: this.protocol(),
      failure: classifyFailure(errorText),
      routingExpertPolicy: settings.routingExpertPolicy,
      nativeRetryReason, attempt: this.recoveryState.recoveryAttempts + 1
    })
    if (!recovery) return false

    this.refreshConfirmedToolReplay(payload.messageId)
    this.clearResponsesContext(true)
    this.protocolOverride = { providerId, from: recovery.fromProtocol, to: recovery.toProtocol }
    this.recoveryState.recordRecovery()
    this.modelAttempts.setRouteReason(recovery.routeReason)
    this.emit({
      kind: 'provider-protocol-failover',
      providerId,
      providerName: recovery.providerName,
      model: recovery.model,
      fromProtocol: recovery.fromProtocol,
      toProtocol: recovery.toProtocol,
      reason: recovery.routeReason
    })
    await this.runResponse(payload, controller)
    return true
  }

  private emitRecoveryExhausted(errorText: string): void {
    const settings = getSettings()
    if (this.recoveryExhaustedEmitted
      || !this.recoveryState.isEnabled(this.meta.providerId, settings.failoverEnabled)) return
    const failure = classifyFailure(errorText)
    if (!failure.switchable) return
    const providerId = this.meta.providerId?.trim()
    if (!providerId) return
    this.recoveryExhaustedEmitted = true
    this.emit({
      kind: 'provider-recovery-exhausted',
      engine: 'openai',
      providerId,
      providerName: listProviders().find((provider) => provider.id === providerId)?.name ?? providerId,
      model: this.effectiveModel(),
      reason: failure.label
    })
  }

  private async tryProviderKeyFailover(
    errorText: string,
    payload: SendMessagePayload,
    controller: AbortController,
    auth: OpenAIAuthConfig | undefined,
    nativeRetryReason?: 'rate_limited' | 'auth_failed'
  ): Promise<boolean> {
    if (!auth) return false
    const settings = getSettings()
    const recoveryContext = nativeSessionRecoveryContext(this.meta, settings)
    if (this.disposed || !this.meta.providerId || !auth.keyId
      || !this.recoveryState.canRecover(this.meta.providerId, settings.failoverEnabled, recoveryContext, nativeRetryReason)) return false
    const failure = classifyFailure(errorText)
    if (!canRotateProviderKey(failure)) return false
    if (recoveryContext.frozenRetry && !frozenRetryAllows({ recovery: recoveryContext, providerId: this.meta.providerId,
      model: this.effectiveModel(), protocol: this.protocol() === 'responses' ? 'openai.responses' : 'openai.chat-completions',
      attempt: this.recoveryState.recoveryAttempts + 1, refusal: nativeRetryReason ? { outcome: nativeRetryReason } : undefined })) return false
    if (auth.authorizationAccountId) {
      if (auth.authorizationAccountExplicit) return false
      const next = recordProviderAuthorizationAccountFailure(this.meta.providerId, auth.authorizationAccountId)
      if (!next.account) return false
      this.refreshConfirmedToolReplay(payload.messageId)
      this.recoveryState.recordRecovery()
      this.clearResponsesContext(this.protocol() === 'responses')
      this.modelAttempts.setRouteReason(`OAuth account failover: ${failure.label}; ${next.reason}`)
      await this.runResponse(payload, controller)
      return true
    }
    const rotation = rotateProviderKey({
      providerId: this.meta.providerId,
      failedKeyId: auth.keyId,
      excludedKeyIds: this.recoveryState.keys,
      reason: failure.label
    })
    if (!rotation) return false

    this.refreshConfirmedToolReplay(payload.messageId)
    this.recoveryState.keys.add(rotation.toKeyId)
    this.recoveryState.recordRecovery()
    this.clearResponsesContext(this.protocol() === 'responses')
    this.modelAttempts.setRouteReason(`Provider key failover: ${failure.label}`)
    this.emit({
      kind: 'provider-key-failover',
      providerId: rotation.providerId,
      providerName: rotation.providerName,
      fromKeyId: rotation.fromKeyId,
      fromKeyLabel: rotation.fromKeyLabel,
      toKeyId: rotation.toKeyId,
      toKeyLabel: rotation.toKeyLabel,
      reason: failure.label
    })
    await this.runResponse(payload, controller)
    return true
  }

  /**
   * Chat Completions(/v1/chat/completions)一轮 = 一个 Agent 循环:
   * user 消息入历史 → 模型流式回复;若回工具调用(bash/read/write/edit/list),
   * 按 permissionMode 审批后真实执行,结果作为 tool 消息回给模型,循环直到
   * 模型给出最终文本或达 MAX_TOOL_ITERATIONS。这让任何 Chat 协议模型
   * (DeepSeek/Qwen/Grok/网关/本地)在 CaoGen 里都是真编码 Agent。
   */
  private async runChatCompletion(
    payload: SendMessagePayload,
    controller: AbortController,
    auth: OpenAIAuthConfig
  ): Promise<void> {
    const replayRequired = this.responsesReplayRequired
    const replayEntries = replayRequired ? this.transcript.read() : []
    if (replayRequired) this.refreshConfirmedToolReplay(payload.messageId)
    const confirmedToolReplay = this.activeConfirmedToolReplay
    if (replayRequired) {
      const replay = runtimeConversationReplay(this.meta, replayEntries, payload.messageId)
      if (replay) {
        this.chatHistory = [{ role: 'system', content: replay.text }]
        this.emit({
          kind: 'hook-event',
          event: 'conversation-ledger-replay',
          detail: portableConversationReplayDetail(replay)
        })
      }
      this.responsesReplayRequired = false
    }
    const userMessage: ChatMessage = { role: 'user', content: buildChatContent(payload) }
    this.chatHistory.push(userMessage)

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        if (controller.signal.aborted) throw new Error('已中断')
        this.pendingToolCalls = []
        // 每次循环重置流式文本缓冲(assistantText 聚合本轮所有文本段)
        const textBefore = this.assistantText
        const system = this.systemMessage()
        // 每次模型请求前评估上下文压力;压缩只落在 user 轮边界,不会切断 tool_call/tool_result 配对。
        await this.compressHistoryIfNeeded(auth, system)

        const baseBody = {
          model: this.effectiveModel(),
          messages: [system, ...this.chatHistory],
          tools: OPENAI_CODING_TOOLS,
          stream: true,
          stream_options: { include_usage: true }
        }
        const adaptation = adaptChatCompletionRequest(baseBody, this.providerAdapterContext())
        for (const warning of adaptation.warnings) {
          this.emit({ kind: 'hook-event', event: 'provider-adapter', detail: warning })
        }
        const request = applyProviderRequestOverrides(
          auth.provider,
          openAiEndpoint(auth.baseUrl, 'chat/completions'),
          adaptation.body as unknown as Record<string, unknown>,
          openAIRequestHeaders(auth)
        )
        await this.fetchWithRetry(
          request.url,
          {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: controller.signal
          },
          controller.signal,
          auth,
          async (res) => {
            if (!res.ok) throw new Error(await formatOpenAIError(res, this.openAIErrorContext(auth)))
            await this.consumeChatStream(res)
          }
        )

        const segmentText = this.assistantText.slice(textBefore.length).trim()
        // 部分端点省略 tool_call id / 空槽:补全 id、丢掉没有函数名的碎片
        const toolCalls = this.pendingToolCalls
          .filter((c) => c.name)
          .map((c) => ({ ...c, id: c.id || `call_${randomUUID().slice(0, 12)}` }))
        this.pendingToolCalls = []

        if (toolCalls.length === 0) {
          // 最终文本回复:入历史,循环结束
          if (segmentText) this.chatHistory.push({ role: 'assistant', content: segmentText })
          return
        }

        // assistant(含 tool_calls)入历史 —— 模型下一轮需要看到自己的调用
        this.chatHistory.push({
          role: 'assistant',
          // OpenAI accepts null here, but some compatible gateways reject it on the tool-result continuation.
          content: segmentText || '',
          tool_calls: toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.argsText }
          }))
        })

        // 逐个执行(审批 → 执行 → 事件 → tool 消息回灌)
        for (const call of toolCalls) {
          if (controller.signal.aborted) throw new Error('已中断')
          let args: Record<string, unknown> = {}
          try {
            args = call.argsText ? (JSON.parse(call.argsText) as Record<string, unknown>) : {}
          } catch {
            // 参数不是合法 JSON:如实回给模型让它重试
          }
          const confirmedOutput = await this.confirmedFailoverToolOutput(
            confirmedToolReplay,
            call.name,
            args,
            call.id
          )
          if (confirmedOutput) {
            this.chatHistory.push({ role: 'tool', tool_call_id: call.id, content: confirmedOutput })
            continue
          }
          const replayTarget = await this.nativeToolRuntime.describeSideEffectTarget(call.name, args).catch(() => null)
          this.emit({ kind: 'tool-start', toolUseId: call.id, name: call.name })
          this.emit({
            kind: 'assistant-message',
            blocks: [{ type: 'tool_use', id: call.id, name: call.name, input: args }]
          })
          const exec = await this.executeToolWithPermission(call.name, args, call.id, controller.signal)
          const resultText = exec.output, isError = !exec.ok
          const effectStatus = exec.effectStatus
          this.recordGuiToolFailure(call.name, call.id, resultText, isError)
          this.emit({
            kind: 'tool-result',
            toolUseId: call.id,
            content: resultText,
            isError,
            ...(exec.exitCode === undefined ? {} : { exitCode: exec.exitCode }),
            ...(exec.commandTermination ? { commandTermination: exec.commandTermination } : {}),
            effectStatus
          })
          this.rememberConfirmedToolReplay({
            toolUseId: call.id,
            toolName: call.name,
            targetDigest: replayTarget?.targetDigest,
            resultContent: resultText,
            isError,
            effectStatus
          })
          assertToolEffectSettled(effectStatus, call.name, call.id)
          this.chatHistory.push({ role: 'tool', tool_call_id: call.id, content: resultText })
        }
      }
      // 达迭代上限:如实告知(极少发生;防御无限循环)
      this.appendText(`\n\n[已达单轮工具调用上限 ${MAX_TOOL_ITERATIONS} 次,任务可能未完成;请拆分任务后继续]`)
      this.chatHistory.push({
        role: 'assistant',
        content: `已达单轮工具调用上限 ${MAX_TOOL_ITERATIONS} 次`
      })
    } catch (err) {
      // 本轮失败:回滚到本轮 user 消息之前,避免下一轮重复发送半截上下文
      const idx = this.chatHistory.indexOf(userMessage)
      if (idx !== -1) this.chatHistory.length = idx
      throw err
    }
  }

  /**
   * chat 历史压缩:上下文达到 90% 自动压缩阈值时,把"较旧的一段"摘要成一条 system 便签,
   * 保留最近若干轮原文。关键约束 —— 绝不切断 tool_call 配对:切点必须落在
   * 一条 user 消息之前(user 一定是干净的轮边界)。摘要失败则跳过压缩(不阻塞对话)。
   */
  private async compressHistoryIfNeeded(auth: OpenAIAuthConfig, systemMessage: ChatMessage): Promise<void> {
    const before = this.currentContextUsage(systemMessage)
    this.recordContextUsage(before)
    if (!before.shouldCompress) return

    // 找切点:保留末尾 DEFAULT_KEEP_RECENT_MESSAGES 条内、最靠前的一个 user 边界。
    // 切点之前的消息被摘要;之后(含该 user)保留原文。
    const boundary = planCompressionBoundary(this.chatHistory, DEFAULT_KEEP_RECENT_MESSAGES)
    if (!boundary.canCompress) return // 没有可压缩的旧段(全是近期轮次)

    const older = this.chatHistory.slice(0, boundary.keepFrom)
    const recent = this.chatHistory.slice(boundary.keepFrom)
    const summary = await this.summarize(older, auth).catch((error) => {
      if (isModelAttemptPersistenceError(error)) throw error
      this.modelAttempts.discardPendingFailover()
      return null
    })
    if (!summary) return // 摘要失败:保持原样,下轮再试

    const boundarySeq = this.transcript.readAll().at(-1)?.seq
    if (!boundarySeq) return // 没有可持久化的账本边界时保持原样
    persistContextPack(app.getPath('userData'), this.meta.id, {
      sourceMessageCount: older.length,
      boundarySeq,
      summary,
      recent
    })

    this.chatHistory = [
      { role: 'system', content: `[早期对话摘要 · 由 CaoGen 自动压缩]\n${summary}` },
      ...recent
    ]
    const after = this.currentContextUsage(systemMessage)
    this.recordContextUsage(after)
    this.emit({
      kind: 'hook-event',
      event: 'context-compressed',
      detail: `上下文 ${Math.round(before.usageRatio * 100)}% 触发自动压缩:压缩 ${older.length} 条历史为摘要,保留最近 ${recent.length} 条;估算 token ${before.usedTokens} → ${after.usedTokens}`
    })
  }

  private currentContextUsage(systemMessage: ChatMessage): ContextUsageState {
    return evaluateContextUsage({
      usedTokens: estimateContextTokens([systemMessage, ...this.chatHistory]),
      model: this.effectiveModel()
    })
  }

  private recordContextUsage(state: ContextUsageState): void {
    this.meta.contextTokens = state.usedTokens
    this.meta.contextWindowTokens = state.windowTokens
    this.meta.contextRemainingTokens = state.remainingTokens
    this.meta.contextUsageRatio = state.usageRatio
    this.meta.contextPressure = state.pressure
    this.emit({ kind: 'meta', meta: { ...this.meta } })

    if (state.shouldWarn && this.lastContextPressure === 'normal') {
      this.emit({
        kind: 'hook-event',
        event: 'context-warning',
        detail: `上下文已使用 ${Math.round(state.usageRatio * 100)}%,剩余约 ${state.remainingTokens} tokens`
      })
    }
    this.lastContextPressure = state.pressure
  }

  private recordContextTokens(usedTokens: number): void {
    this.recordContextUsage(evaluateContextUsage({ usedTokens, model: this.effectiveModel() }))
  }

  /** 用当前模型把一段历史压成简洁中文摘要(非流式,低温度,不带工具) */
  private async summarize(
    messages: ChatMessage[],
    auth: OpenAIAuthConfig
  ): Promise<string | null> {
    const transcript = messages
      .map((m) => {
        const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role === 'tool' ? '工具' : '系统'
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        return `${role}: ${text.slice(0, 2000)}`
      })
      .join('\n')
      .slice(0, 40_000)
    const body = {
      model: this.effectiveModel(),
      messages: [
        {
          role: 'system',
          content:
            '把下面的编码会话历史压成要点摘要:保留关键决策、已完成的改动、待办、重要文件路径与结论,丢弃寒暄与冗余。用简洁中文,不超过 400 字。'
        },
        { role: 'user', content: transcript }
      ],
      stream: false,
      max_tokens: 800
    }
    const request = applyProviderRequestOverrides(
      auth.provider,
      openAiEndpoint(auth.baseUrl, 'chat/completions'),
      body,
      openAIRequestHeaders(auth)
    )
    return this.fetchWithRetry(
      request.url,
      {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body)
      },
      this.abort?.signal ?? new AbortController().signal,
      auth,
      async (res) => {
        if (!res.ok) throw new Error(await formatOpenAIError(res, this.openAIErrorContext(auth)))
        const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
        this.applyChatUsage(json)
        const choices = Array.isArray(json?.choices) ? (json.choices as Array<Record<string, unknown>>) : []
        const message = choices[0]?.message as Record<string, unknown> | undefined
        const text = typeof message?.content === 'string' ? message.content.trim() : ''
        if (!text) throw new Error('上下文摘要响应缺少 content')
        return text
      }
    )
  }
  /** 编码 Agent 系统提示:工作目录 + 人设(每请求现算,设置变更即时生效) */
  private systemMessage(): ChatMessage {
    const settings = getSettings()
    const persona = settings.persona.trim()
    const projectContext = [buildUserRulesSystemAppendSync(), buildProjectContextSystemAppendSync(this.meta.sourceCwd ?? this.meta.cwd)].filter(Boolean).join('\n\n')
    const providerPrompt = buildChinaProviderPromptAppend(this.providerAdapterContext())
    const lines = [
      projectContext,
      providerPrompt,
      taskStrategySystemPrompt(this.meta.taskStrategy),
      preparationPermissionSystemPrompt(this.meta, app.getPath('userData')),
      taskExecutionAuthoritySystemPrompt(this.meta, app.getPath('userData')),
      '你是 CaoGen 桌面工作室里的编码 Agent。',
      `当前工作目录: ${this.meta.cwd}`,
      '你可以使用工具(bash/view/read_file/write_file/search_replace/edit_file/artifact_register/create_document/create_spreadsheet/create_presentation/create_pdf/list_dir/search_symbol/search_code/find_file/get_dependencies/task_decompose/genesis_orchestrate/task_dispatch_dag/task_decompose_and_dispatch_dag/git_status/git_diff/git_stage/git_stage_all/git_commit/git_push/git_create_pr/git_create_issue/git_merge/code_forge_delivery/send_notification)读写项目文件、生成 Word/Excel/PowerPoint/PDF 办公成品、执行命令、规划编排、发送已配置通知并完成 Git 流程。',
      '凡是通过 bash、外部工具或已有工作区文件形成的最终报告、需求、设计、代码包、测试报告、截图、回退包或安装包,必须调用 artifact_register 登记真实文件;只有 canonical Artifact/Evidence/Acceptance 返回成功后才可宣称已交付。',
      '开始任务时先用 search_symbol/search_code/find_file 定位相关文件和符号,不要盲猜路径;修改文件前用 get_dependencies 查看正向/反向依赖影响面。',
      '开始修改前再用 view 查看相关行号和上下文;已有文件编辑必须优先用 search_replace,old_str 至少包含前后 3 行上下文并保证唯一匹配。',
      'search_replace 失败时根据返回的相似片段修正 old_str 后重试;禁止因为匹配失败就改用 write_file 全量覆盖。write_file 仅用于新建文件或确需整体重写的文件。',
      '修改前可用 search_replace dry_run=true 预览 diff;完成后简要说明改动、测试和备份路径。',
      '涉及提交、推送、创建 PR/MR、创建 Issue 或合并分支时,先用 git_status/git_diff 核对改动;提交前优先用 git_stage 精确暂存文件,仅在确认当前范围全部改动都应纳入时使用 git_stage_all,禁止用 bash git add 绕过可对账的 Git index Effect;验证命令必须作为显式 bash 工具单独执行和审批,git_commit 不会隐式运行 caogen.md 命令或 Git hooks;code_forge_delivery 仅生成 report/patch,不会执行验证、暂存、提交、推送或创建 PR;git_stage_all/git_push/git_create_pr/git_create_issue/git_merge 属高风险操作,必须尊重权限审批和失败输出。',
      '复杂或跨模块任务先用 task_decompose 生成 DAG;用户明确要求 Genesis/多 Agent/隔离交付时,优先用 genesis_orchestrate 生成可审查的编排/验证/交付协议。genesis_orchestrate 第一版只规划,不会真实控制外部子 Agent、不会创建 worktree、不会提交或推送。',
      '只有在用户明确要求并通过权限审批后,才使用 task_dispatch_dag 或 task_decompose_and_dispatch_dag 启动子任务调度;Spark/Core/Forge 不应默认推动 Genesis 编排,Command/Genesis 才是编排类任务的目标档位。',
      settings.guiAutomationEnabled
        ? '如需操作真实桌面应用,可使用 gui_list_windows/gui_activate_window/gui_screenshot/gui_click/gui_type/gui_scroll/gui_hotkey;这些高风险工具必须由用户审批或临时授权。'
        : 'GUI 自动化工具默认关闭;除非用户在设置中启用并审批,不要尝试操作真实桌面应用。',
      persona
    ].filter(Boolean)
    return { role: 'system', content: lines.join('\n') }
  }

  /** 消费 Chat Completions SSE 流(choices[].delta.content + 末尾 usage 块) */
  private async consumeChatStream(res: Response): Promise<void> {
    await consumeOpenAIChatResponse(res, this.pendingToolCalls, {
      appendText: (text) => this.appendText(text),
      recordUsage: (usage) => this.recordTurnUsage(usage)
    })
  }

  /** Chat Completions 的 usage 命名(prompt/completion_tokens)转 CaoGen UsageTotals */
  private applyChatUsage(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const usage = (value as Record<string, unknown>).usage as Record<string, unknown> | undefined
    if (!usage) return
    const input = numberField(usage.prompt_tokens)
    const output = numberField(usage.completion_tokens)
    const details = usage.prompt_tokens_details as Record<string, unknown> | undefined
    const cacheRead = numberField(details?.cached_tokens)
    if (input + output + cacheRead === 0) return
    const totals: UsageTotals = { input, output, cacheRead, cacheCreation: 0 }
    this.recordTurnUsage(totals)
  }

  /**
   * 当前 Provider 的 OpenAI 协议。显式配置优先;未配置时按端点选择协议默认:
   * OpenAI 原生端点(或历史未配 Provider)→ responses;任何第三方端点 → chat
   * (Chat Completions 是通用协议,第三方几乎都不实现 Responses ——
   * 之前默认 responses 会让 DeepSeek/网关直接 404)。
   */
  private protocol(): OpenAIProtocol {
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    const target = provider
      ? resolveProviderRuntimeTarget(provider, { appId: 'openai', model: this.requestedModel() })
      : undefined
    const configured = resolveOpenAIProtocol(target ?? { baseUrl: '', protocol: undefined })
    return this.protocolOverride?.providerId === this.meta.providerId &&
      this.protocolOverride.from === configured
      ? this.protocolOverride.to
      : configured
  }

  private async consumeResponse(res: Response): Promise<void> {
    await consumeOpenAIResponsesResponse(res, this.pendingResponseCalls, {
      appendText: (text) => this.appendText(text),
      hasAssistantText: (text) => this.assistantText.includes(text),
      recordUsage: (usage) => this.recordTurnUsage(usage),
      rememberResponse: (responseId) => this.rememberResponsesContext(responseId)
    })
  }

  /**
   * 带退避重试的 fetch:瞬时网络错误(fetch failed / ECONNRESET / socket 等,
   * 高并发下常见)重试最多 2 次(0.5s、1.5s 退避)。用户中断与 HTTP 错误不重试
   * (HTTP 错误交给上层 failover/如实报错)。解决 32 并发突发下的偶发 fetch failed。
   */
  private async fetchWithRetry<T>(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    auth: OpenAIAuthConfig,
    consume: (response: Response) => Promise<T>
  ): Promise<T> {
    const streaming = providerRequestIsStreaming(init.body)
    const timeouts = providerRequestTimeouts(auth.provider)
    const providerId = this.meta.providerId || 'openai'
    const model = this.effectiveModel()
    const protocol = this.protocol() === 'chat' ? 'openai.chat-completions' : 'openai.responses'
    init = { ...init, body: boundedOpenAiRequestBody(init.body, protocol, auth.baseUrl) }
    init = { ...init, body: boundedCouncilBody(this.meta, init.body, providerId, model, protocol) as RequestInit['body'] }
    const deadlines = new WeakMap<Response, ProviderRequestDeadline>()
    return this.modelAttempts.fetch({
      run: taskRuntimeRegistry.get(this.meta.id),
      providerId,
      model,
      protocol,
      url,
      init: { ...init, signal },
      budgetScope: nativeRequestBudgetInput({ meta: this.meta, providerId, model, body: init.body }),
      signal,
      auth: { keyId: auth.keyId, keyLabel: auth.keyLabel },
      canonicalContextDigest: buildProviderNeutralContextDigest({
        entries: this.transcript.readAll(),
        outboundContext: this.activeOutboundContext,
        artifactContinuationDigest: this.meta.modelChange?.handoff.artifactContinuationDigest
      }),
      estimateCost: (usage) => estimateModelAttemptCostUsd({ providerId, model, protocol }, usage),
      executeFetch: async (operationId) => {
        await assertPersistedSessionExecutionAllowed(this.meta, app.getPath('userData'))
        const deadline = new ProviderRequestDeadline(signal, timeouts, streaming)
        try {
          const response = await this.executeProviderFetch(url, { ...init, signal: deadline.signal }, auth, operationId)
          deadlines.set(response, deadline)
          return response
        } catch (error) {
          deadline.finish()
          throw deadline.errorOr(error)
        }
      },
      preflight: async () => {
        await assertPersistedSessionExecutionAllowed(this.meta, app.getPath('userData'))
        assertNativeSessionRecoveryTarget(this.meta, { providerId, model, baseUrl: auth.baseUrl })
        await assertDigitalWorkerProviderDispatchAllowed(this.meta, app.getPath('userData'), {
          providerId,
          model,
          protocol
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
          providerId: this.meta.providerId || 'openai',
          model: this.effectiveModel(),
          engine: this.meta.engine
        })
      },
      readUsage: () => this.turnUsage,
      consume: async (response) => {
        const deadline = deadlines.get(response)
        if (!deadline) return consume(response)
        try {
          return await consume(deadline.wrapResponse(response))
        } catch (error) {
          throw deadline.errorOr(error)
        } finally {
          deadline.finish()
        }
      }
    })
  }

  private appendText(text: string): void {
    this.assistantText += text
    this.emit({ kind: 'text-delta', text })
  }

  private finishTurn(isError: boolean, resultText?: string, subtype = 'success'): void {
    const active = this.abort
    this.abort = null
    if (this.disposed) return
    if (active?.signal.aborted && !isError) return

    const guiFailureText = this.formatGuiToolFailures()
    if (!isError && guiFailureText) {
      isError = true
      subtype = 'tool-error'
      resultText = guiFailureText
    }

    const text = this.assistantText.trim()
    if (text) {
      const blocks: AssistantBlock[] = [{ type: 'text', text }]
      this.emit({ kind: 'assistant-message', blocks })
    }
    const durationMs = this.turnStartedAt ? Date.now() - this.turnStartedAt : undefined
    this.emit({
      kind: 'turn-result',
      subtype: isError ? subtype : 'success',
      isError,
      durationMs,
      resultText: isError ? resultText : text || undefined,
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
    this.activeConfirmedToolReplay = new Map()
    this.turnRevisionEligible = false
    this.turnHadToolEvents = false
    if (isError && resultText) this.setStatus('error', resultText)
    else this.setStatus('idle')
  }

  private recordGuiToolFailure(toolName: string, toolUseId: string, resultText: string, isError: boolean): void {
    if (!isError || !isGuiToolName(toolName)) return
    this.turnGuiToolFailures.push({
      toolName,
      toolUseId,
      detail: summarizeToolFailure(resultText)
    })
  }

  private formatGuiToolFailures(): string | undefined {
    if (this.turnGuiToolFailures.length === 0) return undefined
    const failures = this.turnGuiToolFailures
      .slice(0, 5)
      .map((failure) => `${failure.toolName}(${failure.toolUseId}): ${failure.detail}`)
      .join('；')
    const suffix = this.turnGuiToolFailures.length > 5 ? `；另有 ${this.turnGuiToolFailures.length - 5} 个 GUI 工具失败` : ''
    return `GUI 工具失败，任务未标记为成功: ${failures}${suffix}`
  }

  private recordTurnUsage(usage: UsageTotals): void {
    this.turnUsage = addUsageTotals(this.turnUsage, usage)
    this.meta.usage = this.turnUsage
    this.recordContextTokens(usage.input + usage.cacheRead + usage.cacheCreation)
  }
  /** 缺 key 文案:用当前 Provider 名而非写死 'OpenAI'(DeepSeek 等场景不再误导) */
  private missingKeyMessage(): string {
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    const name = provider?.name || 'OpenAI'
    return `${name} 缺少 API Key:请在设置里为该 Provider 填写密钥,或设置 OPENAI_API_KEY。`
  }

  private authConfig(): OpenAIAuthConfig {
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    return resolveOpenAiAuthConfig({
      provider,
      providerId: this.meta.providerId,
      model: this.requestedModel(),
      protocol: this.protocol()
    })
  }

  private async executeProviderFetch(
    url: string,
    init: RequestInit,
    auth: OpenAIAuthConfig,
    operationId: string
  ): Promise<Response> {
    boundedCouncilBody(this.meta, init.body, this.meta.providerId, this.effectiveModel(), this.protocol() === 'chat' ? 'openai.chat-completions' : 'openai.responses')
    const scope = providerCredentialScopeForSession(this.meta, auth.providerId, operationId)
    const currentProvider = auth.provider ? getProvider(auth.providerId) : undefined
    if (currentProvider && auth.authorizationAccountId) {
      const account = await issueProviderAuthorizationAccountLease(
        { ...currentProvider, baseUrl: auth.baseUrl },
        auth.authorizationAccountId,
        scope
      )
      boundedCouncilBody(this.meta, init.body, this.meta.providerId, this.effectiveModel(), this.protocol() === 'chat' ? 'openai.chat-completions' : 'openai.responses')
      await claimCouncilPhysicalRequest(this.meta, url)
      return fetchWithProviderCredentialLease({
        provider: account.credentialProvider,
        lease: account.lease,
        scope,
        url,
        init: {
          ...init,
          headers: {
            ...openAIRequestHeaders(auth),
            ...((init.headers ?? {}) as Record<string, string>),
            ...parseProviderHeaders(account.credentialProvider.customHeaders)
          }
        }
      })
    }
    await ensureProviderAuthorizationFresh(auth.providerId)
    const selection = currentProvider
      ? issueProviderCredentialLease(currentProvider, scope, {}, auth.keyId)
      : issueDirectProviderCredentialLease(
          auth.providerId,
          auth.keyId || 'environment:OPENAI_API_KEY',
          process.env.OPENAI_API_KEY || '',
          scope
        )
    if (auth.authMode !== 'none' && (!selection.available || !selection.lease)) {
      throw new Error('Provider credential lease is unavailable')
    }
    boundedCouncilBody(this.meta, init.body, this.meta.providerId, this.effectiveModel(), this.protocol() === 'chat' ? 'openai.chat-completions' : 'openai.responses')
    await claimCouncilPhysicalRequest(this.meta, url)
    return fetchWithProviderCredentialLease({
      provider: currentProvider ?? auth.provider,
      lease: selection.lease,
      scope,
      url,
      init: {
        ...init,
        headers: {
          ...openAIRequestHeaders(auth),
          ...((init.headers ?? {}) as Record<string, string>)
        }
      }
    })
  }

  private requestedModel(): string {
    if (this.meta.model && this.meta.model !== AUTO_MODEL) return this.meta.model
    if (this.routedModel) return this.routedModel
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    return provider?.models?.[0] || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL
  }

  private effectiveModel(): string {
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    if (this.meta.model && this.meta.model !== AUTO_MODEL) {
      return provider
        ? resolveProviderRuntimeTarget(provider, { appId: 'openai', model: this.meta.model }).model
        : this.meta.model
    }
    if (this.routedModel) return this.routedModel // auto 模式:本轮路由结果
    const fallback = provider?.models?.[0] || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL
    return provider
      ? resolveProviderRuntimeTarget(provider, { appId: 'openai', model: fallback }).model
      : fallback
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

  private providerAdapterContext(): ProviderAdapterContext {
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    return { provider, model: this.effectiveModel() }
  }

  private openAIErrorContext(auth: { baseUrl: string }): OpenAIErrorContext {
    const provider = this.meta.providerId ? getProvider(this.meta.providerId) : undefined
    return {
      providerId: this.meta.providerId || 'none',
      providerName: provider?.name || this.meta.providerId || 'OpenAI',
      baseUrl: redactProviderBaseUrl(auth.baseUrl),
      model: this.effectiveModel(),
      protocol: this.protocol()
    }
  }

  private withProviderErrorContext(message: string): string {
    const auth = this.authConfig()
    return `${redactProviderErrorText(message)}\n${formatProviderErrorContext(this.openAIErrorContext(auth))}`
  }
}

function openAIRequestHeaders(auth: OpenAIAuthConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...auth.headers
  }
}

function buildInputContent(payload: SendMessagePayload): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = []
  if (payload.text) out.push({ type: 'input_text', text: payload.text })
  for (const image of payload.images ?? []) {
    const dataUrl = imageToDataUrl(image)
    if (dataUrl) out.push({ type: 'input_image', image_url: dataUrl })
  }
  return out.length > 0 ? out : [{ type: 'input_text', text: '' }]
}

/** Chat Completions 消息内容:纯文本直接用字符串;带图时用多模态数组 */
function buildChatContent(payload: SendMessagePayload): ChatContent {
  const images = payload.images ?? []
  if (images.length === 0) return payload.text
  const out: Array<Record<string, unknown>> = []
  if (payload.text) out.push({ type: 'text', text: payload.text })
  for (const image of images) {
    const dataUrl = imageToDataUrl(image)
    if (dataUrl) out.push({ type: 'image_url', image_url: { url: dataUrl } })
  }
  return out.length > 0 ? out : payload.text
}

function imageToDataUrl(image: ImageAttachmentView): string | null {
  try {
    const data = readFileSync(image.path).toString('base64')
    return `data:${image.mime};base64,${data}`
  } catch {
    return null
  }
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function summarizeToolFailure(resultText: string): string {
  const clipped = clipText(resultText.trim() || '工具返回错误')
  try {
    const parsed = JSON.parse(resultText) as Record<string, unknown>
    const parts: string[] = []
    if (typeof parsed.error === 'string' && parsed.error.trim()) parts.push(parsed.error.trim())
    if (typeof parsed.screenCapturePermission === 'string') parts.push(`screenCapturePermission=${parsed.screenCapturePermission}`)
    if (typeof parsed.sourceCount === 'number') parts.push(`sourceCount=${parsed.sourceCount}`)
    if (parts.length > 0) return clipText(parts.join('；'))
  } catch {
    // 非 JSON 工具输出直接截断展示。
  }
  return clipped
}

function clipText(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text
}

async function formatOpenAIError(res: Response, context?: OpenAIErrorContext): Promise<string> {
  const text = await res.text().catch(() => '')
  const prefix = `OpenAI 返回 ${res.status}${statusHint(res.status)}`
  const suffix = context ? `\n${formatProviderErrorContext(context)}` : ''
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    return `${prefix}: ${redactProviderErrorText(extractErrorMessage(json.error) || text || res.statusText)}${suffix}`
  } catch {
    return `${prefix}: ${redactProviderErrorText(text || res.statusText)}${suffix}`
  }
}

function statusHint(status: number): string {
  if (status === 401 || status === 403) return '(认证/权限错误)'
  if (status === 404) return '(模型名或端点不存在)'
  if (status === 429) return '(限流/余额不足)'
  if (status >= 500) return '(网关或上游服务错误)'
  return ''
}

function extractErrorMessage(error: unknown): string {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (typeof error !== 'object') return String(error)
  const record = error as Record<string, unknown>
  return typeof record.message === 'string' ? record.message : JSON.stringify(record)
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function assertToolEffectSettled(
  status: EffectStatus | undefined,
  toolName: string,
  toolUseId: string
): void {
  if (status === 'waiting_reconciliation') {
    throw new Error(`工具效果状态未知,需先完成对账:${toolName}(${toolUseId})`)
  }
}

export const openAIEngineFactory: EngineFactory = {
  kind: 'openai',
  label: 'OpenAI 协议(Responses / Chat Completions)',
  available: () => true,
  create: (
    meta: SessionMeta,
    emit: EngineEmit,
    resumeSdkSessionId?: string,
    initialEventSeq?: number
  ): Engine => new OpenAIEngine(meta, emit, resumeSdkSessionId, initialEventSeq)
}
