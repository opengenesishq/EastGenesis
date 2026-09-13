import type { EngineKind, ModelRoutingDecisionView } from './types'

/** Durable local-ledger boundary; contains no vendor cursor, credentials or pending prompt. */
export interface SessionRuntimeContinuation {
  schemaVersion: 1
  id: string
  state: 'prepared' | 'committed'
  fromEngine: EngineKind
  toEngine: EngineKind
  providerId: string
  model: string
  boundarySeq: number
  contextDigest: string
  createdAt: number
}

export interface SessionRuntimeRoutingBinding {
  /** Concrete target is independent from the user's AUTO/model intent. */
  modelRoutingDecision?: ModelRoutingDecisionView
  runtimeContinuation?: SessionRuntimeContinuation
}
