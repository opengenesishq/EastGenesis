import type {
  AgentEvent,
  CheckpointRestoreMode,
  CheckpointRestoreResult,
  PermissionModeId,
  RewindResult,
  SendMessagePayload,
  SessionMeta,
  TaskStrategy,
  TaskRunRecord
} from '../shared/types'
import type {
  NativeRuntimeAdapterDeclaration,
  NativeRuntimeSnapshot
} from '../shared/native-runtime-types'
import type { Engine, EngineEmit } from './engine'
import { NativeRuntimeContractError } from './native-runtime-contract'
import { NativeRuntimeGuard } from './native-runtime-guard'
import type { NativeProtocolAdapter } from './protocol-adapters/types'
import { taskRuntimeRegistry } from './task/task-runtime-registry'

export interface NativeRuntimeBoundEngine extends Engine {
  readonly nativeRuntimeAdapter: NativeRuntimeAdapterDeclaration
  readonly protocolAdapter: NativeProtocolAdapter
  bindNativeRun(run: TaskRunRecord): void
  getNativeRuntimeSnapshot(): NativeRuntimeSnapshot
  serializeNativeRuntime(): string
}

export interface BindEngineToNativeRuntimeInput {
  adapter: NativeRuntimeAdapterDeclaration
  protocolAdapter: NativeProtocolAdapter
  meta: SessionMeta
  emit: EngineEmit
  initialEventSeq: number
  resume: boolean
  create: (emit: EngineEmit) => Engine
}

interface BufferedEngineEvent {
  event: AgentEvent
  seq: number
  identity?: Parameters<EngineEmit>[2]
}

export function bindEngineToNativeRuntime(
  input: BindEngineToNativeRuntimeInput
): NativeRuntimeBoundEngine {
  const buffered: BufferedEngineEvent[] = []
  let forward: EngineEmit | undefined
  const engine = input.create((event, seq, identity) => {
    if (forward) forward(event, seq, identity)
    else buffered.push({ event, seq, identity })
  })
  assertEngineSurface(engine, input.meta)
  const initialSeq = resolveInitialSequence(input, buffered)
  const guard = new NativeRuntimeGuard({
    adapter: input.adapter,
    meta: input.meta,
    initialSeq
  })
  forward = (event, seq, identity) => {
    const normalizedEvent = input.protocolAdapter.normalizeEvent(event)
    guard.accept(normalizedEvent, seq, identity)
    input.emit(normalizedEvent, seq, identity)
  }
  guard.hydrateTranscript(engine.getTranscript().filter((entry) =>
    entry.seq <= initialSeq && (!input.resume || !isSessionRuntimeEvent(entry.event))
  ))
  for (const entry of buffered) forward(entry.event, entry.seq, entry.identity)
  return new ContractBoundEngine(engine, guard, input.protocolAdapter)
}

function isSessionRuntimeEvent(event: AgentEvent): boolean {
  return event.kind === 'init' || event.kind === 'status' || event.kind === 'meta'
}

function resolveInitialSequence(
  input: BindEngineToNativeRuntimeInput,
  buffered: readonly BufferedEngineEvent[]
): number {
  const firstSeq = buffered[0]?.seq
  if (firstSeq === undefined || firstSeq === input.initialEventSeq + 1) return input.initialEventSeq
  if (input.resume && input.initialEventSeq === 0 && firstSeq > 1) return firstSeq - 1
  fail('event_sequence', 'Engine constructor did not continue the configured event sequence')
}

export function isNativeRuntimeBoundEngine(engine: Engine): engine is NativeRuntimeBoundEngine {
  const candidate = engine as Partial<NativeRuntimeBoundEngine>
  return typeof candidate.bindNativeRun === 'function' &&
    typeof candidate.protocolAdapter === 'object' &&
    typeof candidate.getNativeRuntimeSnapshot === 'function' &&
    typeof candidate.serializeNativeRuntime === 'function'
}

class ContractBoundEngine implements NativeRuntimeBoundEngine {
  readonly meta: SessionMeta
  readonly nativeRuntimeAdapter: NativeRuntimeAdapterDeclaration

  constructor(
    private readonly engine: Engine,
    private readonly runtime: NativeRuntimeGuard,
    readonly protocolAdapter: NativeProtocolAdapter
  ) {
    this.meta = engine.meta
    this.nativeRuntimeAdapter = runtime.adapter
  }

  async start(): Promise<void> {
    this.assertIdentity()
    await this.engine.start()
    this.assertIdentity()
  }

  send(input: string | SendMessagePayload): void {
    this.assertIdentity()
    const request = this.protocolAdapter.prepareRequest(input, this.meta)
    const run = taskRuntimeRegistry.get(this.meta.id)
    if (!run) fail('run_missing', 'native runtime send requires a canonical TaskRun')
    this.runtime.bindRun(run)
    this.engine.send(request)
  }

  rejectSend(message: string): void {
    requiredString(message, 'send rejection')
    this.engine.rejectSend(message)
  }

  async interrupt(): Promise<void> {
    await this.engine.interrupt()
  }

  respondPermission(requestId: string, allow: boolean, message?: string): void {
    requiredString(requestId, 'permission request id')
    this.engine.respondPermission(requestId, allow, message)
  }

  pendingPermissions(): ReturnType<Engine['pendingPermissions']> {
    const pending = this.engine.pendingPermissions()
    if (!Array.isArray(pending)) fail('engine_surface', 'Engine pendingPermissions must return an array')
    return pending
  }

  getTranscript(): ReturnType<Engine['getTranscript']> {
    const transcript = this.engine.getTranscript()
    if (!Array.isArray(transcript)) fail('engine_surface', 'Engine transcript must be an array')
    return transcript
  }

  emitSyntheticEvent(event: AgentEvent): void {
    if (!this.engine.emitSyntheticEvent) {
      fail('engine_surface', 'Engine does not expose canonical synthetic event ingress')
    }
    this.engine.emitSyntheticEvent(event)
  }

  async setPermissionMode(mode: PermissionModeId): Promise<void> {
    await this.engine.setPermissionMode(mode)
    this.assertIdentity()
  }

  async setTaskStrategy(strategy: TaskStrategy): Promise<void> {
    await this.engine.setTaskStrategy(strategy)
    this.assertIdentity()
  }

  async setModel(model: string, providerId?: string): Promise<void> {
    requiredString(model, 'model')
    if (providerId !== undefined) requiredString(providerId, 'provider id')
    await this.engine.setModel(model, providerId)
    this.assertIdentity()
  }

  rename(title: string): void {
    requiredString(title, 'session title')
    this.engine.rename(title)
    this.assertIdentity()
  }

  rewindFiles(messageId: string, dryRun: boolean): Promise<RewindResult> {
    requiredString(messageId, 'checkpoint message id')
    if (this.engine.rewindFiles) return this.engine.rewindFiles(messageId, dryRun)
    return Promise.resolve({ canRewind: false, error: 'Engine adapter has no native file rewind' })
  }

  restoreCheckpoint(
    messageId: string,
    mode: CheckpointRestoreMode,
    dryRun: boolean
  ): Promise<CheckpointRestoreResult> {
    requiredString(messageId, 'checkpoint message id')
    if (this.engine.restoreCheckpoint) return this.engine.restoreCheckpoint(messageId, mode, dryRun)
    return Promise.resolve({
      mode,
      checkpointId: messageId,
      canRewind: false,
      applied: false,
      error: 'Engine adapter has no native checkpoint restore'
    })
  }

  async dispose(): Promise<void> {
    await this.engine.dispose()
  }

  async retireForContinuation(): Promise<void> {
    if (!this.engine.retireForContinuation) throw new Error('引擎不支持安全交接')
    await this.engine.retireForContinuation()
  }

  bindNativeRun(run: TaskRunRecord): void {
    this.runtime.bindRun(run)
  }

  getNativeRuntimeSnapshot(): NativeRuntimeSnapshot {
    return this.runtime.snapshot()
  }

  serializeNativeRuntime(): string {
    return this.runtime.serialize()
  }

  private assertIdentity(): void {
    if (
      this.engine.meta !== this.meta ||
      this.meta.engine !== this.nativeRuntimeAdapter.engineKind ||
      this.protocolAdapter.engineKind !== this.nativeRuntimeAdapter.engineKind ||
      this.protocolAdapter.protocol !== this.nativeRuntimeAdapter.protocol
    ) {
      fail('engine_identity', 'Engine changed its canonical Session or adapter identity')
    }
  }
}

function assertEngineSurface(engine: Engine, meta: SessionMeta): void {
  if (!engine || typeof engine !== 'object' || engine.meta !== meta) {
    fail('engine_identity', 'Engine factory returned a forged Session identity')
  }
  const methods: Array<keyof Engine> = [
    'start', 'send', 'rejectSend', 'interrupt', 'respondPermission', 'pendingPermissions',
    'getTranscript', 'setPermissionMode', 'setTaskStrategy', 'setModel', 'rename', 'dispose'
  ]
  for (const method of methods) {
    if (typeof engine[method] !== 'function') {
      fail('engine_surface', `Engine is missing required native runtime method: ${method}`)
    }
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail('required_field', `${label} is required`)
  return value
}

function fail(code: string, message: string): never {
  throw new NativeRuntimeContractError(code, message)
}
