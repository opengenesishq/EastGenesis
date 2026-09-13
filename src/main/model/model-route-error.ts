export type ModelRouteErrorCode =
  | 'ROUTING_NO_CANDIDATES'
  | 'ROUTING_CAPABILITY_UNAVAILABLE'
  | 'ROUTING_BUDGET_EXHAUSTED'
  | 'ROUTING_BUDGET_UNAFFORDABLE'
  | 'ROUTING_MANUAL_TARGET_UNAVAILABLE'
  | 'ROUTING_INVALID_BUDGET'

/** A routing refusal must stop execution; it is never a request for legacy routing. */
export class ModelRouteError extends Error {
  readonly name = 'ModelRouteError'

  constructor(readonly code: ModelRouteErrorCode, message: string) {
    super(message)
  }
}

export function isModelRouteError(error: unknown): error is ModelRouteError {
  return error instanceof ModelRouteError
}
