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
  /** Absent on legacy text-only receipts. This mode binds the exact source ledger. */
  contextMode?: 'completed_tools_v1'
  createdAt: number
}

export interface SessionRuntimeRoutingBinding {
  /** Explicit executor requirement, independent of the currently adopted engine. */
  executorEngine?: EngineKind
  routingControl?: import('./session-routing-control-types').SessionRoutingControl
  /** Concrete target is independent from the user's AUTO/model intent. */
  modelRoutingDecision?: ModelRoutingDecisionView
  runtimeContinuation?: SessionRuntimeContinuation
  /** Latest explicit model change, with its frozen work context and predecessor. */
  modelChange?: import('./session-model-change-types').SessionModelChange
}
