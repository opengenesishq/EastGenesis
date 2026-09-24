import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type {
  WorkflowDeliveryIdentityTrustSnapshot,
  WorkflowProjectDeliveryPackageVerificationResult
} from '../../../../shared/types'
import { useStore } from '../../store'
import { errorMessage } from '../workflow-ledger-ui'

type VerificationReport = Exclude<WorkflowProjectDeliveryPackageVerificationResult, { canceled: true }>

export type PackageVerificationSignal = {
  key: 'bytes' | 'signature' | 'identity' | 'policy'
  state: 'ok' | 'neutral' | 'blocked'
  label: string
}

export function useDeliveryIdentityTrust(
  active: boolean,
  setError: Dispatch<SetStateAction<string>>
): [WorkflowDeliveryIdentityTrustSnapshot | undefined, Dispatch<SetStateAction<WorkflowDeliveryIdentityTrustSnapshot | undefined>>] {
  const [identityTrust, setIdentityTrust] = useState<WorkflowDeliveryIdentityTrustSnapshot>()
  useEffect(() => {
    if (!active) return
    void window.agentDesk.listWorkflowDeliveryTrustedIdentities()
      .then(setIdentityTrust)
      .catch((cause) => setError(errorMessage(cause)))
  }, [active, setError])
  return [identityTrust, setIdentityTrust]
}

export function packageVerificationSignals(report: VerificationReport): PackageVerificationSignal[] {
  const byteIntegrityValid = report.byteIntegrity === 'verified'
  const signatureState = report.signatureStatus === 'valid'
    ? 'ok'
    : report.signatureStatus === 'unsigned'
      ? 'neutral'
      : 'blocked'
  const identityState = report.identityTrust === 'local_identity' || report.identityTrust === 'trusted_identity'
    ? 'ok'
    : report.identityTrust === 'revoked_identity'
      ? 'blocked'
      : 'neutral'
  return [
    { key: 'bytes', state: byteIntegrityValid ? 'ok' : 'blocked', label: `${localized('字节', 'Bytes')} ${byteIntegrityValid ? localized('完整', 'intact') : localized('异常', 'invalid')}` },
    { key: 'signature', state: signatureState, label: `${localized('签名', 'Signature')} ${report.signatureStatus === 'valid' ? localized('有效', 'valid') : report.signatureStatus === 'unsigned' ? localized('未签名', 'unsigned') : localized('无效', 'invalid')}` },
    { key: 'identity', state: identityState, label: `${localized('身份', 'Identity')} ${deliveryIdentityTrustLabel(report)}` },
    { key: 'policy', state: report.trustPolicyVerdict === 'passed' ? 'ok' : 'blocked', label: `${localized('策略', 'Policy')} ${report.trustPolicyVerdict === 'passed' ? localized('通过', 'passed') : localized('阻断', 'blocked')} · ${deliveryTrustPolicyLabel(report.trustPolicyMode)}` }
  ]
}

function deliveryIdentityTrustLabel(report: VerificationReport): string {
  if (report.identityTrust === 'local_identity') return localized('本机 EastGenesis', 'Local EastGenesis')
  if (report.identityTrust === 'trusted_identity') return report.signingIdentityLabel || localized('已信任', 'Trusted')
  if (report.identityTrust === 'revoked_identity') return localized(`${report.signingIdentityLabel || '已知身份'}（已撤销）`, `${report.signingIdentityLabel || 'Known identity'} (revoked)`)
  if (report.identityTrust === 'unknown_identity') return localized('未知公钥', 'Unknown public key')
  return localized('未提供', 'Not provided')
}

export function deliveryTrustPolicyLabel(
  mode: WorkflowDeliveryIdentityTrustSnapshot['policy']['mode']
): string {
  if (mode === 'require_valid_signature') return localized('必须签名', 'Require valid signature')
  if (mode === 'require_trusted_identity') return localized('必须信任身份', 'Require trusted identity')
  return localized('仅审计', 'Audit only')
}

function localized(chinese: string, english: string): string {
  return useStore.getState().settings.language === 'en' ? english : chinese
}
