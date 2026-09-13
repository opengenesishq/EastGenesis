import type { RoutingDiagnostic, RoutingRuleDraftV1, RoutingTargetRef } from '../../../../../shared/routing-policy-types'

/** Display-only projections from the saved catalog; these are not persisted policy entities. */
export interface RoutingProviderOption {
  id: string
  name: string
  available: boolean
  models: readonly { model: string; displayName?: string; available: boolean; reason?: string }[]
}
export interface RoutingBusinessLineOption { id: string; name: string; enabled: boolean }
/** The outer editor supplies limits from the shared parser/service, never inferred from form values. */
export interface RoutingFormLimits { targets: number; keywords: number; retries: number; maxPriority: number }
export interface RoutingRuleFormProps {
  draft: RoutingRuleDraftV1
  providers: readonly RoutingProviderOption[]
  businessLines: readonly RoutingBusinessLineOption[]
  limits: RoutingFormLimits
  diagnostics?: readonly RoutingDiagnostic[]
  disabled?: boolean
  onChange(draft: RoutingRuleDraftV1): void
}
export interface RoutingTargetPickerProps {
  label: string
  value: RoutingTargetRef
  providers: readonly RoutingProviderOption[]
  disabled?: boolean
  onChange(target: RoutingTargetRef): void
}
