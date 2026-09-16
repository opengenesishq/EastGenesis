import type { EffectRecord } from '../../shared/types'
import { stableValueDigest } from './tool-idempotency'

export function effectRecordIntegrityMatches(effect: EffectRecord): boolean {
  if (stableValueDigest(effect.target) !== effect.targetDigest) return false
  if (effect.evidence.some(evidence => {
    const receipt = evidence.resolutionReceipt
    if (receipt === undefined) return false
    return !receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
      Object.keys(receipt).some(key => !['resolution', 'expectedRevision', 'targetDigest', 'inputDigest', 'note'].includes(key)) ||
      evidence.kind !== 'manual_confirmation' || evidence.generation !== effect.generation ||
      !['confirmed_applied', 'confirmed_not_applied', 'abandoned_by_user'].includes(receipt.resolution) ||
      !Number.isSafeInteger(receipt.expectedRevision) || receipt.expectedRevision < 1 || receipt.expectedRevision >= effect.revision ||
      receipt.targetDigest !== effect.targetDigest || receipt.inputDigest !== effect.inputDigest ||
      (receipt.note !== undefined && (typeof receipt.note !== 'string' || !receipt.note.trim() || receipt.note.length > 2000)) ||
      stableValueDigest({ effectId: effect.id, effectKey: effect.effectKey, ...receipt }) !== evidence.digest
  })) return false
  return stableValueDigest({
    toolName: effect.toolName,
    targetDigest: effect.targetDigest,
    inputDigest: effect.inputDigest
  }) === effect.intentDigest
}
