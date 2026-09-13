import type {
  AgentEvent,
  AgentEventIdentity,
  CheckpointRestoreMode,
  CheckpointRestoreResult,
  PermissionModeId,
  PermissionRequestInfo,
  RewindResult,
  SendMessagePayload,
  SessionMeta,
  TaskStrategy,
  TranscriptEntry
} from '../shared/types'
import type { NativeRuntimeAdapterDeclaration } from '../shared/native-runtime-types'
import { assertNativeRuntimeAdapterDeclaration } from './native-runtime-contract'
import { bindEngineToNativeRuntime } from './native-runtime-engine'
import { assertNativeProtocolAdapter } from './protocol-adapters/shared'
import type { NativeProtocolAdapter } from './protocol-adapters/types'
import { restoreRuntimeContinuation } from './session-runtime-continuation-store'

/**
 * M6 · EngineAdapter:桌面会话与底层 Agent 引擎之间的契约。
 * 事件模型(AgentEvent)与引擎解耦——任何能产出这组事件、
 * 吃进用户消息的 CLI/SDK 都可以成为一个引擎。
 *
 * 现有实现:Anthropic Messages 与 OpenAI-compatible 原生引擎。
 * 会话引擎由 SessionManager 根据 Provider 配置解析;这里不静默回退其他协议。
 */
export interface Engine {
  readonly meta: SessionMeta
  start(): Promise<void>
  send(input: string | SendMessagePayload): void
  rejectSend(message: string): void
  /** 中断当前轮次，并在已开始的外部执行完成或当前执行器确认停止后返回。 */
  interrupt(): Promise<void>
  respondPermission(requestId: string, allow: boolean, message?: string): void
  pendingPermissions(): PermissionRequestInfo[]
  getTranscript(): TranscriptEntry[]
  /** 由 SessionManager 注入的本地合成事件,用于让编排/状态事件进入同一条转录链。 */
  emitSyntheticEvent?(event: AgentEvent): void
  setPermissionMode(mode: PermissionModeId): Promise<void>
  setTaskStrategy(strategy: TaskStrategy): Promise<void>
  setModel(model: string): Promise<void>
  rename(title: string): void
  /** 文件检查点回退(引擎可选;不支持则返回 canRewind:false) */
  rewindFiles?(messageId: string, dryRun: boolean): Promise<RewindResult>
  /** 代码/对话/两者检查点回退(引擎可选) */
  restoreCheckpoint?(
    messageId: string,
    mode: CheckpointRestoreMode,
    dryRun: boolean
  ): Promise<CheckpointRestoreResult>
  /**
   * 请求底层执行器停止，并在所有已开始的外部执行都已完成或执行器已确认退出后返回。
   * SessionManager 必须等待该屏障，才能把会话视为已停止并启动效果对账。
   */
  dispose(): Promise<void>
  /** Retire an idle protocol instance without emitting a false Session-closed event. */
  retireForContinuation?(): Promise<void>
}

export type EngineEmit = (event: AgentEvent, seq: number, identity?: AgentEventIdentity) => void

export interface EngineFactory {
  /** 引擎标识,会话按 meta.engine 选择。 */
  kind: string
  /** 人类可读名(设置和状态面板使用) */
  label: string
  /** 当前环境是否可用(CLI 是否安装等);不可用则 UI 置灰 */
  available(): boolean
  /** 可选引擎不参与默认启动或发布门禁。 */
  optional?: boolean
  /** 当前是否存在用户凭据；不代表端点协议兼容，探测失败也不阻塞引擎列表。 */
  configured?(): boolean
  /** 1.0 builtin engines declare the same frozen provider-neutral runtime contract. */
  nativeRuntime?: NativeRuntimeAdapterDeclaration
  /** Provider protocol translation and validation boundary paired with the native runtime. */
  protocolAdapter?: NativeProtocolAdapter
  create(meta: SessionMeta, emit: EngineEmit, resumeSdkSessionId?: string, initialEventSeq?: number): Engine
}

const registry = new Map<string, EngineFactory>()

export function registerEngine(factory: EngineFactory): void {
  assertFactoryAdapterBinding(factory)
  registry.set(factory.kind, factory)
}

export function listNativeRuntimeAdapters(): NativeRuntimeAdapterDeclaration[] {
  return [...registry.values()].flatMap((factory) =>
    factory.nativeRuntime ? [factory.nativeRuntime] : []
  )
}

export function listProtocolAdapters(): NativeProtocolAdapter[] {
  return [...registry.values()].flatMap((factory) =>
    factory.protocolAdapter ? [factory.protocolAdapter] : []
  )
}

export function listEngines(): Array<{
  kind: string
  label: string
  available: boolean
  optional: boolean
  configured: boolean
}> {
  return [...registry.values()].map((f) => ({
    kind: f.kind,
    label: f.label,
    available: safeProbe(f.available, false),
    optional: f.optional === true,
    configured: safeProbe(f.configured, true)
  }))
}

function safeProbe(probe: (() => boolean) | undefined, fallback: boolean): boolean {
  if (!probe) return fallback
  try {
    return probe()
  } catch {
    return false
  }
}

/** 按 kind 创建引擎;未注册/不可用时直接失败,避免暗中换成别的模型/账号体系。 */
export function createEngine(
  kind: string | undefined,
  meta: SessionMeta,
  emit: EngineEmit,
  resumeSdkSessionId?: string,
  initialEventSeq = 0
): Engine {
  if (resumeSdkSessionId) {
    meta.sdkSessionId ??= resumeSdkSessionId
    restoreRuntimeContinuation(meta)
    kind = meta.engine
  }
  if (!kind) throw new Error('请选择 Agent 引擎')
  const factory = registry.get(kind)
  if (!factory) throw new Error(`Agent 引擎未注册:${kind}`)
  if (!factory.available()) throw new Error(`Agent 引擎不可用:${factory.label}`)
  if (!factory.nativeRuntime || !factory.protocolAdapter) {
    return factory.create(meta, emit, resumeSdkSessionId, initialEventSeq)
  }
  return bindEngineToNativeRuntime({
    adapter: factory.nativeRuntime,
    protocolAdapter: factory.protocolAdapter,
    meta,
    emit,
    initialEventSeq,
    resume: Boolean(resumeSdkSessionId),
    create: (runtimeEmit) => factory.create(
      meta,
      runtimeEmit,
      resumeSdkSessionId,
      initialEventSeq
    )
  })
}

function assertFactoryAdapterBinding(factory: EngineFactory): void {
  const hasRuntime = factory.nativeRuntime !== undefined
  const hasProtocol = factory.protocolAdapter !== undefined
  if (hasRuntime !== hasProtocol) {
    throw new Error(`Agent 引擎 ${factory.kind} 必须同时声明 native runtime 与 protocol adapter`)
  }
  if (!factory.nativeRuntime || !factory.protocolAdapter) return
  assertNativeRuntimeAdapterDeclaration(factory.nativeRuntime, factory.kind)
  assertNativeProtocolAdapter(
    factory.protocolAdapter,
    factory.kind,
    factory.nativeRuntime.protocol
  )
}
