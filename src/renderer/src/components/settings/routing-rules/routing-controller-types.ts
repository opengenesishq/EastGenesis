import type { RoutingLegacyTransition, RoutingPreviewContext, RoutingRulePreviewInput, RoutingRulePreviewResult,
  RoutingRuleReadResult, RoutingRuleSaveInput, RoutingRuleSaveResult, RoutingRuleSetDraftV1 } from '../../../../../shared/routing-policy-types'

export type RoutingEditorCommand =
  | { kind: 'read'; requestId: number }
  | { kind: 'preview'; requestId: number; input: RoutingRulePreviewInput }
  | { kind: 'save'; requestId: number; input: RoutingRuleSaveInput }

export interface RoutingControllerState {
  read: RoutingRuleReadResult | null
  draft: RoutingRuleSetDraftV1 | null
  selectedRuleId?: string | null
  migration?: RoutingLegacyTransition
  context?: RoutingPreviewContext
  dirty: boolean
  nextRequestId: number
  pending?: RoutingEditorCommand
  preview?: RoutingRulePreviewResult
  lastSave?: RoutingRuleSaveResult
  comparison?: { kind: 'refresh' | 'conflict' | 'unknown'; current: RoutingRuleReadResult }
  /** The original exact input/revision survives rereads and explicit review. It is never silently rebound. */
  uncertainSave?: { input: RoutingRuleSaveInput; originalRead: RoutingRuleReadResult; reviewed: boolean }
  error?: { kind: 'blocked' | 'transport' | 'save_outcome_unknown'; message: string }
}
export interface RoutingControllerTransition { state: RoutingControllerState; command?: RoutingEditorCommand }
export type RoutingComparisonResolution =
  | { kind: 'adopt_latest' }
  | { kind: 'use_reviewed_draft'; draft: RoutingRuleSetDraftV1; migration?: RoutingLegacyTransition }
