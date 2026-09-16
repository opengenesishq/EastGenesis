import { randomUUID } from 'node:crypto'
import type { Engine, EngineEmit } from './engine'
import { createEngine } from './engine'
import { AUTO_MODEL, type SendMessagePayload, type SessionMeta, type TaskRunRecord } from '../shared/types'
import { resolveRuntimeSessionRoute } from './model/session-runtime-routing'
import { clearSessionTurnRoute, prepareSessionTurnRoute, takeSessionTurnRoute } from './model/session-turn-route'
import { runHasUnresolvedEffects } from './task/effect-runtime'
import { readTranscriptEntriesStrict } from './transcript'
import { prepareRuntimeContinuationContext } from './session-runtime-continuation-context'
import { assertRuntimeContinuationAligned, persistRuntimeContinuation } from './session-runtime-continuation-store'
import { getProvider, resolveProviderEngine } from './providers'
import { assertSessionExecutorEngine } from '../shared/session-executor-selection'

export interface RuntimeContinuationInput {
  session: Engine
  payload: SendMessagePayload
  run?: TaskRunRecord
  emit: EngineEmit
  /** Install the successor and persist ordinary projections after the durable continuation commit. */
  install: (successor: Engine) => Promise<void>
  create?: typeof createEngine
  persist?: typeof persistRuntimeContinuation
}

/** Called only after ordinary ownership, monthly budget and ModelAttempt send gates have passed. */
export async function prepareRuntimeContinuation(input: RuntimeContinuationInput): Promise<Engine> {
  const { session, payload } = input
  // A canonical WorkItem Run is evaluated before this boundary.  Reuse that
  // exact target so engine switching and the eventual Attempt cannot silently
  // fall back to the legacy runtime scheduler.
  const evaluatedRoute = takeSessionTurnRoute(session.meta, payload)
  clearSessionTurnRoute(session.meta)
  assertRuntimeContinuationAligned(session.meta)
  if (session.meta.model !== AUTO_MODEL || session.meta.routingScope !== 'global') {
    if (evaluatedRoute) prepareSessionTurnRoute(session.meta, payload, evaluatedRoute)
    return session
  }
  const route = evaluatedRoute ?? resolveRuntimeSessionRoute({ meta: session.meta, payload, allowAnyEngine: true })
  if (!route) return session
  const provider = getProvider(route.providerId)
  if (!provider) throw new Error('已选 Provider 不再可用')
  const engine = resolveProviderEngine(provider)
  assertSessionExecutorEngine(session.meta.executorEngine, engine)
  if (engine === session.meta.engine) {
    prepareSessionTurnRoute(session.meta, payload, route)
    return session
  }
  assertSafeRuntimeBoundary(input)
  const entries = readTranscriptEntriesStrict(session.meta.sdkSessionId!)
  const context = prepareRuntimeContinuationContext(entries, payload)
  const meta: SessionMeta = {
    ...session.meta, engine, providerId: route.providerId, modelRoutingDecision: route.decision,
    responsesContext: undefined, resumeSessionAt: undefined,
    runtimeContinuation: {
      schemaVersion: 1, id: randomUUID(), state: 'prepared', fromEngine: session.meta.engine!, toEngine: engine,
      providerId: route.providerId, model: route.model, boundarySeq: entries.at(-1)!.seq,
      ...context, createdAt: Date.now()
    }
  }
  const successor = (input.create ?? createEngine)(meta.engine, meta, input.emit, meta.sdkSessionId, entries.at(-1)!.seq)
  meta.runtimeContinuation!.state = 'committed'
  // Constructors in prepared mode never emit or write. Until this receipt is durable the original
  // instance remains untouched; after commit, recovery uses this target even if projections fail.
  try { (input.persist ?? persistRuntimeContinuation)(meta) } catch (error) {
    await successor.retireForContinuation!()
    throw error
  }
  await session.retireForContinuation!()
  try { await input.install(successor) } finally { await successor.start() }
  if (successor.meta.status !== 'idle') throw new Error(successor.meta.lastError ?? '接续引擎启动失败')
  prepareSessionTurnRoute(successor.meta, payload, route)
  return successor
}

function assertSafeRuntimeBoundary({ session, run }: RuntimeContinuationInput): void {
  if (session.meta.status !== 'idle' || !session.meta.sdkSessionId || !session.retireForContinuation ||
      session.pendingPermissions().length || run?.pendingPermissionRequestId || runHasUnresolvedEffects(run) ||
      (run && run.status !== 'completed') || run?.toolExecutions?.some((entry) => entry.status === 'unknown_outcome')) {
    throw new Error('跨执行器续聊需要已完成的回合，且没有未决工具、审批或执行结果。')
  }
}
