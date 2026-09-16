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
  routingControl?: import('./session-routing-control-types').SessionRoutingControl
  /** Concrete target is independent from the user's AUTO/model intent. */
  modelRoutingDecision?: ModelRoutingDecisionView
  runtimeContinuation?: SessionRuntimeContinuation
  /** Latest explicit model change, with its frozen work context and predecessor. */
  modelChange?: import('./session-model-change-types').SessionModelChange
}
