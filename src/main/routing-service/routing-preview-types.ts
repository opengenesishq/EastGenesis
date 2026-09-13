import type { RoutingLegacyJsonValue, RoutingPreviewContext } from '../../shared/routing-policy-types'
import type { RoutingEvaluationSnapshots, TrustedRoutingContext } from '../model/routing-policy/evaluator-types'
import type { RoutingSettingsDependencies, RoutingSettingsSnapshot } from '../routing-settings/routing-settings-types'

export interface RoutingPreviewCapture {
  context: TrustedRoutingContext
  snapshots: RoutingEvaluationSnapshots
  /** Main-owned ownership/permission revision material, without credentials. */
  authority: RoutingLegacyJsonValue
}

export interface RoutingRuleServiceDependencies extends RoutingSettingsDependencies {
  /** Read-only resolution of canonical Session ownership and current hard limits.
   * Must not create a Run, obtain grants, reserve budget, probe or generate. */
  capturePreview(input: { context: RoutingPreviewContext; settings: RoutingSettingsSnapshot }): Promise<RoutingPreviewCapture>
  /** Synchronous final check, immediately before evaluating or committing.
   * Rechecks the authority captured across any asynchronous local reads. */
  isPreviewCaptureCurrent(capture: RoutingPreviewCapture): boolean
  now?: () => number
}
