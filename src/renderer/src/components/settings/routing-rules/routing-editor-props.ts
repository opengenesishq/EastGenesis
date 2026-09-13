import type { ReactNode } from 'react'
import type { RoutingDiagnostic, RoutingLegacyResolution, RoutingLegacyTransition, RoutingRuleReadResult,
  RoutingRuleSaveResult, RoutingRuleSetDraftV1 } from '../../../../../shared/routing-policy-types'
import type { RoutingBusinessLineOption } from './routing-ui-props'

/** Controlled UI projection. The controller keeps base, frozen submission and draft separately. */
export interface RoutingRuleEditorShellProps {
  read: RoutingRuleReadResult
  draft: RoutingRuleSetDraftV1
  selectedRuleId: string | null
  businessLines: readonly RoutingBusinessLineOption[]
  dirty: boolean
  busy?: 'loading' | 'saving' | 'previewing'
  migration?: RoutingLegacyTransition
  lastSave?: RoutingRuleSaveResult
  diagnostics?: readonly RoutingDiagnostic[]
  editor?: ReactNode
  preview?: ReactNode
  onSelectRule(id: string): void
  onAddRule(): void
  onRemoveRule(id: string): void
  onResolveLegacy(resolution: RoutingLegacyResolution): void
  onPreview(): void
  onSave(): void
  onReviewConflict(): void
  /** Read only: never a disguised retry/save. Keep unknown receipt until reconciliation succeeds. */
  onReread(): void
}
