import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Download, FileCheck2, FileJson, GitCompareArrows, KeyRound, RotateCw, Save, ShieldCheck, ShieldOff, Upload, UserCheck, X } from 'lucide-react'
import type {
  WorkflowAcceptanceRecord,
  WorkflowEvidenceKind,
  WorkflowArtifactCompareResult,
  WorkflowArtifactIntegrityReport,
  WorkflowProjectDeliveryIntegrityReport,
  WorkflowProjectDeliveryPackageVerificationResult,
  WorkflowDeliveryIdentityTrustSnapshot,
  WorkflowProjectDeliveryArtifact,
  WorkflowProjectDeliveryWorkbench
} from '../../../../shared/types'
import { DisclosureChevron } from '../DisclosureChevron'
import { WorkflowAcceptanceRow } from '../WorkflowAcceptanceRow'
import { EVIDENCE_KINDS, errorMessage, newWorkflowId } from '../workflow-ledger-ui'
import { useStore } from '../../store'
import {
  deliveryTrustPolicyLabel,
  packageVerificationSignals,
  useDeliveryIdentityTrust
} from './projectDeliveryVerification'
interface ProjectDeliveryWorkbenchProps {
  active: boolean
  projectId: string
  /** Optional canonical WorkItem carried by a Work Inbox delivery handoff. */
  requestedWorkItemId?: string
  refreshToken?: string
}

export function ProjectDeliveryWorkbench({
  active,
  projectId,
  requestedWorkItemId,
  refreshToken = ''
}: ProjectDeliveryWorkbenchProps): React.JSX.Element {
  useStore((state) => state.settings.language)
  const openFile = useStore((state) => state.openFile)
  const openPreviewPanel = useStore((state) => state.openPreviewPanel)
  const openBrowserPanel = useStore((state) => state.openBrowserPanel)
  const [projection, setProjection] = useState<WorkflowProjectDeliveryWorkbench | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [repairByAcceptanceId, setRepairByAcceptanceId] = useState<Record<string, string>>({})
  const [exporting, setExporting] = useState(false)
  const [deliveryAudit, setDeliveryAudit] = useState<WorkflowProjectDeliveryIntegrityReport>()
  const [packageVerification, setPackageVerification] = useState<Exclude<WorkflowProjectDeliveryPackageVerificationResult, { canceled: true }>>()
  const [identityTrust, setIdentityTrust] = useDeliveryIdentityTrust(active, setError)
  const [auditing, setAuditing] = useState<'verify' | 'manifest' | 'package' | 'verify-package' | ''>('')

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectId) return
    setLoading(true)
    setError('')
    try {
      setProjection(await window.agentDesk.getProjectDeliveryWorkbench(projectId))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh, refreshToken])

  useLayoutEffect(() => {
    if (!requestedWorkItemId || !projection) return
    const targets = document.querySelectorAll<HTMLElement>(`[data-delivery-work-item-id="${CSS.escape(requestedWorkItemId)}"]`)
    // A duplicated Acceptance identity is ambiguous; do not focus a guessed row.
    if (targets.length !== 1) return
    const target = targets[0]
    target.dataset.deliveryNavigationTarget = 'true'
    target.tabIndex = -1
    target.focus({ preventScroll: true })
    target.scrollIntoView({ block: 'center', inline: 'nearest' })
    const timer = window.setTimeout(() => {
      if (target.isConnected) delete target.dataset.deliveryNavigationTarget
    }, 2_000)
    return () => window.clearTimeout(timer)
  }, [projection, requestedWorkItemId])

  const evidenceById = useMemo(
    () => new Map((projection?.evidence ?? []).map((record) => [record.evidenceId, record])),
    [projection?.evidence]
  )
  const artifactByAcceptanceId = useMemo(() => {
    const records = new Map<string, WorkflowProjectDeliveryArtifact['artifact']>()
    for (const item of projection?.artifacts ?? []) {
      for (const acceptanceId of item.acceptanceIds) records.set(acceptanceId, item.artifact)
    }
    return records
  }, [projection?.artifacts])
  const onRepairReported = useCallback((repair: { acceptanceId: string; workItemId: string }): void => {
    setRepairByAcceptanceId((current) => ({ ...current, [repair.acceptanceId]: repair.workItemId }))
  }, [])
  const startRepair = useCallback(async (acceptance: WorkflowAcceptanceRecord): Promise<void> => {
    setMessage('')
    try {
      const result = await window.agentDesk.startWorkflowAcceptanceRepair(acceptance.id)
      setRepairByAcceptanceId((current) => ({ ...current, [acceptance.id]: result.workItemId }))
      setMessage(localized(`返工任务 ${result.workItemId} 已${result.disposition === 'blocked' ? '阻塞' : '启动'}`, `Repair task ${result.workItemId} ${result.disposition === 'blocked' ? 'is blocked' : 'started'}`))
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [refresh])
  const exportDelivery = useCallback(async (): Promise<void> => {
    setExporting(true)
    setError('')
    setMessage('')
    try {
      const exported = await window.agentDesk.exportProjectWorkspaceData(projectId)
      downloadDeliveryExport(projectId, exported.json)
      setMessage(localized(`交付包已导出 · ${exported.exportDigest.slice(0, 16)}`, `Delivery package exported · ${exported.exportDigest.slice(0, 16)}`))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setExporting(false)
    }
  }, [projectId])
  const verifyProjectDelivery = useCallback(async (): Promise<void> => {
    setAuditing('verify')
    setError('')
    setMessage('')
    try {
      setDeliveryAudit(await window.agentDesk.verifyWorkflowProjectDelivery({ projectId }))
    } catch (cause) {
      setDeliveryAudit(undefined)
      setError(errorMessage(cause))
    } finally {
      setAuditing('')
    }
  }, [projectId])
  const exportProjectManifest = useCallback(async (): Promise<void> => {
    setAuditing('manifest')
    setError('')
    setMessage('')
    try {
      const result = await window.agentDesk.exportWorkflowProjectDeliveryManifest({ projectId })
      if (!result.canceled) {
        setMessage(localized(`${result.fileName} · ${result.readyArtifactCount} 可交付 / ${result.blockedArtifactCount} 阻塞 · ${shortDigest(result.manifestDigest)}`, `${result.fileName} · ${result.readyArtifactCount} ready / ${result.blockedArtifactCount} blocked · ${shortDigest(result.manifestDigest)}`))
        setDeliveryAudit(await window.agentDesk.verifyWorkflowProjectDelivery({ projectId }))
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setAuditing('')
    }
  }, [projectId])
  const exportVerifiedPackage = useCallback(async (): Promise<void> => {
    setAuditing('package')
    setError('')
    setMessage('')
    try {
      const result = await window.agentDesk.exportWorkflowProjectDeliveryPackage({ projectId })
      if (!result.canceled) {
        setMessage(localized(`${result.fileName} · Ed25519 已签名 · ${result.includedArtifactCount} 个已验收文件 · ${result.blockedArtifactCount} 个阻塞 · ${shortDigest(result.packageDigest)}`, `${result.fileName} · Ed25519 signed · ${result.includedArtifactCount} accepted files · ${result.blockedArtifactCount} blocked · ${shortDigest(result.packageDigest)}`))
        setDeliveryAudit(await window.agentDesk.verifyWorkflowProjectDelivery({ projectId }))
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setAuditing('')
    }
  }, [projectId])
  const verifyDeliveryPackage = useCallback(async (): Promise<void> => {
    setAuditing('verify-package')
    setError('')
    setMessage('')
    try {
      const result = await window.agentDesk.verifyWorkflowProjectDeliveryPackage()
      if (!result.canceled) setPackageVerification(result)
    } catch (cause) {
      setPackageVerification(undefined)
      setError(errorMessage(cause))
    } finally {
      setAuditing('')
    }
  }, [])

  return (
    <section className="pws-section pws-delivery-workbench" aria-labelledby={`delivery-${projectId}`} data-project-delivery-workbench data-delivery-requested-work-item={requestedWorkItemId ?? ''}>
      <div className="pws-section-header">
        <div className="pws-section-title">
          <h2 id={`delivery-${projectId}`}>{localized('交付与验收', 'Delivery and acceptance')}</h2>
          {projection && <span>{projection.summary.currentArtifactCount}/{projection.summary.artifactCount}</span>}
        </div>
        <div className="pws-section-actions">
          <span className="pws-delivery-state">{loading ? localized('同步中...', 'Syncing...') : projection ? localized('已同步', 'Synced') : localized('尚无交付数据', 'No delivery data')}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void verifyDeliveryPackage()} disabled={Boolean(auditing)}>
            <FileCheck2 size={13} aria-hidden="true" />
            {auditing === 'verify-package' ? localized('验证中...', 'Verifying...') : localized('验证交付包', 'Verify package')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void verifyProjectDelivery()} disabled={loading || Boolean(auditing)}>
            <ShieldCheck size={13} aria-hidden="true" />
            {auditing === 'verify' ? localized('审计中...', 'Auditing...') : localized('全项目审计', 'Audit project')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void exportProjectManifest()} disabled={loading || Boolean(auditing)}>
            <FileJson size={13} aria-hidden="true" />
            {auditing === 'manifest' ? localized('导出中...', 'Exporting...') : localized('项目清单', 'Project manifest')}
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void exportVerifiedPackage()} disabled={loading || Boolean(auditing)}>
            <Download size={13} aria-hidden="true" />
            {auditing === 'package' ? localized('打包中...', 'Packaging...') : localized('可验证交付包', 'Verifiable package')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void exportDelivery()} disabled={loading || exporting}>
            {exporting ? localized('导出中...', 'Exporting...') : localized('导出项目数据', 'Export project data')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={loading}>{localized('刷新', 'Refresh')}</button>
        </div>
      </div>
      {error && <div className="pws-error" role="alert">{error}</div>}
      {message && <div className="pws-announcer" role="status">{message}</div>}
      {packageVerification && (
        <DeliveryPackageVerification
          report={packageVerification}
          trustSnapshot={identityTrust}
          onVerificationChange={setPackageVerification}
          onTrustChange={setIdentityTrust}
          onSaved={(saved) => setMessage(`${saved.fileName} · ${shortDigest(saved.receiptDigest)}`)}
          onError={setError}
        />
      )}
      {identityTrust && (
        <DeliveryIdentityTrustList
          snapshot={identityTrust}
          onChange={setIdentityTrust}
          onPolicyChange={() => setPackageVerification(undefined)}
          onMessage={setMessage}
          onError={setError}
        />
      )}
      {projection && (
        <>
          <DeliverySummary projection={projection} />
          {deliveryAudit && <ProjectDeliveryAudit report={deliveryAudit} />}
          <div className="pws-delivery-grid">
            <ArtifactDeliveryList
              artifacts={projection.artifacts}
              evidence={projection.evidence}
              evidenceById={evidenceById}
              projectId={projectId}
              onOpenFile={openFile}
              onOpenPreview={openPreviewPanel}
              onOpenBrowser={openBrowserPanel}
              onRefresh={refresh}
            />
            <div className="pws-delivery-column">
              <section className="pws-delivery-subsection" aria-labelledby={`acceptance-${projectId}`}>
                <h3 id={`acceptance-${projectId}`}>{localized('验收清单', 'Acceptance checklist')}</h3>
                {projection.acceptances.length === 0 ? <p className="pws-delivery-empty">{localized('暂无 Acceptance', 'No Acceptance records')}</p> : projection.acceptances.map((acceptance) => (
                  <div className="pws-delivery-acceptance" key={acceptance.id} data-delivery-work-item-id={acceptance.workItemId ?? ''}>
                    <WorkflowAcceptanceRow
                      acceptance={acceptance}
                      evidence={projection.evidence}
                      artifact={artifactByAcceptanceId.get(acceptance.id)}
                      onRefresh={refresh}
                      repairWorkItemId={repairByAcceptanceId[acceptance.id]}
                      onRepairReported={onRepairReported}
                    />
                    {acceptance.status === 'failed' && (
                      <button type="button" className="btn btn-ghost btn-xs" onClick={() => void startRepair(acceptance)}>
                        {localized('启动返工', 'Start repair')}
                      </button>
                    )}
                  </div>
                ))}
              </section>
              <section className="pws-delivery-subsection" aria-labelledby={`evidence-${projectId}`}>
                <h3 id={`evidence-${projectId}`}>Evidence ({projection.evidence.length})</h3>
                {projection.evidence.length === 0 ? <p className="pws-delivery-empty">{localized('暂无 Evidence', 'No Evidence')}</p> : projection.evidence.slice(0, 12).map((record) => (
                  <div className="pws-delivery-evidence" key={record.evidenceId}>
                    <strong>{record.title}</strong>
                    <span>{record.kind} · {record.source}{record.artifactId ? ` · ${record.artifactId}` : localized(' · 未绑定产物', ' · No bound artifact')}</span>
                    {record.summary && <p>{record.summary}</p>}
                  </div>
                ))}
              </section>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function DeliveryPackageVerification({
  report,
  trustSnapshot,
  onVerificationChange,
  onTrustChange,
  onSaved,
  onError
}: {
  report: Exclude<WorkflowProjectDeliveryPackageVerificationResult, { canceled: true }>
  trustSnapshot?: WorkflowDeliveryIdentityTrustSnapshot
  onVerificationChange: (report: Exclude<WorkflowProjectDeliveryPackageVerificationResult, { canceled: true }>) => void
  onTrustChange: (snapshot: WorkflowDeliveryIdentityTrustSnapshot) => void
  onSaved: (saved: { fileName: string; receiptDigest: string }) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const [trusting, setTrusting] = useState(false)
  const [identityLabel, setIdentityLabel] = useState('')
  const saveReceipt = useCallback(async (): Promise<void> => {
    setSaving(true)
    onError('')
    try {
      const saved = await window.agentDesk.saveWorkflowProjectDeliveryPackageVerificationReceipt({
        verificationId: report.verificationId
      })
      if (!saved.canceled) onSaved(saved)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }, [onError, onSaved, report.verificationId])
  const trustIdentity = useCallback(async (): Promise<void> => {
    if (!trustSnapshot || !identityLabel.trim()) return
    setTrusting(true)
    onError('')
    try {
      const result = await window.agentDesk.trustWorkflowDeliveryIdentity({
        verificationId: report.verificationId,
        label: identityLabel,
        expectedRevision: trustSnapshot.revision
      })
      onTrustChange(result.snapshot)
      if (result.verification) onVerificationChange(result.verification)
      setIdentityLabel('')
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setTrusting(false)
    }
  }, [identityLabel, onError, onTrustChange, onVerificationChange, report.verificationId, trustSnapshot])
  return (
    <div className={`pws-package-verification is-${report.verdict}`} role="status" aria-live="polite">
      <div className="pws-package-verification-head">
        <div>
          <strong>{report.verdict === 'verified' ? localized('交付包验证通过', 'Delivery package verified') : localized('交付包验证未通过', 'Delivery package verification failed')}</strong>
          <span>{report.fileName}{report.projectId ? ` · ${report.projectId}` : ''}</span>
        </div>
        <span>
          {localized(`${report.verifiedArtifactCount ?? 0}/${report.declaredArtifactCount ?? 0} 文件`, `${report.verifiedArtifactCount ?? 0}/${report.declaredArtifactCount ?? 0} files`)} · {formatBytes(report.verifiedArtifactBytes ?? 0)}
          {report.manifestVerdict ? ` · ${localized('清单', 'Manifest')} ${report.manifestVerdict}` : ''}
        </span>
      </div>
      <div className="pws-package-verification-signals" aria-label={localized('交付包验证状态', 'Delivery package verification status')}>
        {packageVerificationSignals(report).map((signal) => (
          <span key={signal.key} data-state={signal.state}>{signal.label}</span>
        ))}
      </div>
      {report.packageDigest && (
        <div className="pws-package-verification-digests">
          <code>{shortDigest(report.packageDigest)}</code>
          {report.manifestDigest && <code>{shortDigest(report.manifestDigest)}</code>}
          {report.signingIdentityFingerprint && <code title={localized('Ed25519 公钥 SHA-256 指纹', 'Ed25519 public key SHA-256 fingerprint')}>{shortDigest(report.signingIdentityFingerprint)}</code>}
        </div>
      )}
      {(report.identityTrust === 'unknown_identity' || report.identityTrust === 'revoked_identity') && report.signatureStatus === 'valid' && trustSnapshot && (
        <div className="pws-package-verification-trust">
          <input
            value={identityLabel}
            onChange={(event) => setIdentityLabel(event.target.value)}
            maxLength={100}
            placeholder={report.identityTrust === 'revoked_identity' ? report.signingIdentityLabel || localized('重新信任名称', 'Name for restored trust') : localized('合作方身份名称', 'Partner identity name')}
            aria-label={localized('合作方身份名称', 'Partner identity name')}
          />
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => void trustIdentity()}
            disabled={trusting || !identityLabel.trim()}
          >
            <UserCheck size={12} aria-hidden="true" />
            {trusting ? localized('保存中...', 'Saving...') : report.identityTrust === 'revoked_identity' ? localized('重新信任', 'Trust again') : localized('信任此身份', 'Trust this identity')}
          </button>
        </div>
      )}
      {report.blockers.length > 0 && (
        <ul className="pws-package-verification-blockers">
          {report.blockers.map((blocker, index) => (
            <li key={`${blocker.code}-${blocker.entry ?? ''}-${index}`}>
              {blocker.message}{blocker.entry ? ` · ${blocker.entry}` : ''}
            </li>
          ))}
        </ul>
      )}
      <div className="pws-package-verification-actions">
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => void saveReceipt()} disabled={saving}>
          <Save size={12} aria-hidden="true" />
          {saving ? localized('保存中...', 'Saving...') : localized('保存验证凭证', 'Save verification receipt')}
        </button>
      </div>
    </div>
  )
}

function DeliveryIdentityTrustList({
  snapshot,
  onChange,
  onPolicyChange,
  onMessage,
  onError
}: {
  snapshot: WorkflowDeliveryIdentityTrustSnapshot
  onChange: (snapshot: WorkflowDeliveryIdentityTrustSnapshot) => void
  onPolicyChange: () => void
  onMessage: (message: string) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [revoking, setRevoking] = useState('')
  const [busy, setBusy] = useState<'policy' | 'trust-export' | 'trust-import' | 'backup' | 'restore' | 'rotate' | ''>('')
  const [passphrase, setPassphrase] = useState('')
  const [confirmingRotation, setConfirmingRotation] = useState(false)
  const localIdentityAvailable = snapshot.localIdentityStatus === 'available'
  const updatePolicy = useCallback(async (
    mode: WorkflowDeliveryIdentityTrustSnapshot['policy']['mode']
  ): Promise<void> => {
    if (mode === snapshot.policy.mode) return
    setBusy('policy')
    onError('')
    try {
      const result = await window.agentDesk.updateWorkflowDeliveryTrustPolicy({
        mode,
        expectedRevision: snapshot.revision
      })
      onChange(result.snapshot)
      onPolicyChange()
      onMessage(localized(`交付信任策略已切换为 ${deliveryTrustPolicyLabel(mode)}，请重新验证交付包`, `Delivery trust policy changed to ${deliveryTrustPolicyLabel(mode)}. Verify the package again.`))
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }, [onChange, onError, onMessage, onPolicyChange, snapshot.policy.mode, snapshot.revision])
  const revoke = useCallback(async (fingerprint: string): Promise<void> => {
    setRevoking(fingerprint)
    onError('')
    try {
      const result = await window.agentDesk.revokeWorkflowDeliveryIdentity({
        fingerprint,
        expectedRevision: snapshot.revision
      })
      onChange(result.snapshot)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setRevoking('')
    }
  }, [onChange, onError, snapshot.revision])
  const exportTrustBundle = useCallback(async (): Promise<void> => {
    setBusy('trust-export')
    onError('')
    try {
      const result = await window.agentDesk.exportWorkflowDeliveryIdentityTrustBundle()
      if (!result.canceled) onMessage(localized(`${result.fileName} · ${result.identityCount ?? 0} 个身份`, `${result.fileName} · ${result.identityCount ?? 0} identities`))
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }, [onError, onMessage])
  const importTrustBundle = useCallback(async (): Promise<void> => {
    setBusy('trust-import')
    onError('')
    try {
      const result = await window.agentDesk.importWorkflowDeliveryIdentityTrustBundle(snapshot.revision)
      if (!result.canceled) {
        onChange(result.snapshot)
        onMessage(localized(`信任包已合并 · 新增 ${result.importedCount} · 更新 ${result.updatedCount} · 未变 ${result.unchangedCount}`, `Trust bundle merged · ${result.importedCount} added · ${result.updatedCount} updated · ${result.unchangedCount} unchanged`))
      }
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }, [onChange, onError, onMessage, snapshot.revision])
  const backupIdentity = useCallback(async (): Promise<void> => {
    if (passphrase.length < 12) return
    setBusy('backup')
    onError('')
    try {
      const result = await window.agentDesk.exportWorkflowDeliveryIdentityBackup({ passphrase })
      if (!result.canceled) {
        onMessage(`${result.fileName} · ${shortDigest(result.identityFingerprint)}`)
        setPassphrase('')
      }
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }, [onError, onMessage, passphrase])
  const restoreIdentity = useCallback(async (): Promise<void> => {
    if (passphrase.length < 12) return
    setBusy('restore')
    onError('')
    try {
      const result = await window.agentDesk.restoreWorkflowDeliveryIdentityBackup({ passphrase })
      if (!result.canceled) {
        onChange(result.snapshot)
        onMessage(result.disposition === 'reinstalled' ? localized('交付身份已重新安装', 'Delivery identity reinstalled') : localized('交付身份已恢复，原身份已撤销', 'Delivery identity restored; the previous identity was revoked'))
        setPassphrase('')
      }
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }, [onChange, onError, onMessage, passphrase])
  const rotateIdentity = useCallback(async (): Promise<void> => {
    setBusy('rotate')
    onError('')
    try {
      const result = await window.agentDesk.rotateWorkflowDeliveryIdentity({
        ...(snapshot.localIdentity ? { expectedFingerprint: snapshot.localIdentity.fingerprint } : {})
      })
      onChange(result.snapshot)
      onMessage(localized('新的交付签名身份已启用，原身份已撤销', 'A new delivery signing identity is active; the previous identity was revoked'))
      setConfirmingRotation(false)
    } catch (cause) {
      onError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }, [onChange, onError, onMessage, snapshot.localIdentity])
  return (
    <section className="pws-delivery-identities" aria-labelledby="delivery-trusted-identities">
      <div className="pws-delivery-identities-head">
        <div>
          <strong id="delivery-trusted-identities">{localized('交付身份', 'Delivery identities')}</strong>
          <span>{localized(`${snapshot.identities.filter((item) => item.status === 'trusted').length} 个可信`, `${snapshot.identities.filter((item) => item.status === 'trusted').length} trusted`)} · rev {snapshot.revision}</span>
        </div>
        <div className="pws-delivery-identity-toolbar">
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => void importTrustBundle()} disabled={Boolean(busy)} title={localized('导入交付身份信任包', 'Import delivery identity trust bundle')}>
            <Upload size={12} aria-hidden="true" />{busy === 'trust-import' ? localized('导入中...', 'Importing...') : localized('导入信任', 'Import trust')}
          </button>
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => void exportTrustBundle()} disabled={Boolean(busy) || !localIdentityAvailable} title={localized('导出交付身份信任包', 'Export delivery identity trust bundle')}>
            <Download size={12} aria-hidden="true" />{busy === 'trust-export' ? localized('导出中...', 'Exporting...') : localized('导出信任', 'Export trust')}
          </button>
        </div>
      </div>
      <div className="pws-delivery-trust-policy" role="group" aria-label={localized('组织交付信任策略', 'Organization delivery trust policy')}>
        {(['audit_only', 'require_valid_signature', 'require_trusted_identity'] as const).map((mode) => (
          <button
            type="button"
            key={mode}
            aria-pressed={snapshot.policy.mode === mode}
            onClick={() => void updatePolicy(mode)}
            disabled={Boolean(busy)}
          >
            {deliveryTrustPolicyLabel(mode)}
          </button>
        ))}
      </div>
      <div className="pws-delivery-local-identity" data-local-identity-status={snapshot.localIdentityStatus}>
        <div>
          <KeyRound size={13} aria-hidden="true" />
          <strong>{localized('本机签名身份', 'Local signing identity')}</strong>
          {snapshot.localIdentity ? (
            <>
            <code>{shortDigest(snapshot.localIdentity.fingerprint)}</code>
            <span>{localized(`${snapshot.localIdentity.retiredIdentities.length} 个历史身份`, `${snapshot.localIdentity.retiredIdentities.length} historical identities`)}</span>
            </>
          ) : <span>{localized('系统凭据加密不可用', 'System credential encryption unavailable')}</span>}
        </div>
        {snapshot.localIdentity && (!confirmingRotation ? (
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => setConfirmingRotation(true)} disabled={Boolean(busy)} title={localized('轮换本机交付签名身份', 'Rotate local delivery signing identity')}><RotateCw size={12} aria-hidden="true" />{localized('轮换', 'Rotate')}</button>
        ) : (
          <div className="pws-delivery-rotation-confirm">
            <button type="button" className="btn btn-danger btn-xs" onClick={() => void rotateIdentity()} disabled={Boolean(busy)}><RotateCw size={12} aria-hidden="true" />{busy === 'rotate' ? localized('轮换中...', 'Rotating...') : localized('确认轮换', 'Confirm rotation')}</button>
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setConfirmingRotation(false)} disabled={Boolean(busy)} title={localized('取消轮换', 'Cancel rotation')}><X size={12} aria-hidden="true" />{localized('取消', 'Cancel')}</button>
          </div>
        ))}
      </div>
      <div className="pws-delivery-identity-backup">
        <input
          type="password"
          value={passphrase}
          minLength={12}
          maxLength={1024}
          onChange={(event) => setPassphrase(event.target.value)}
          placeholder={localized('身份备份密码（至少 12 位）', 'Identity backup passphrase (at least 12 characters)')}
          aria-label={localized('交付身份备份密码', 'Delivery identity backup passphrase')}
          autoComplete="new-password"
          disabled={!localIdentityAvailable}
        />
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => void backupIdentity()} disabled={Boolean(busy) || !localIdentityAvailable || passphrase.length < 12}>
          <Save size={12} aria-hidden="true" />{busy === 'backup' ? localized('备份中...', 'Backing up...') : localized('备份身份', 'Back up identity')}
        </button>
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => void restoreIdentity()} disabled={Boolean(busy) || !localIdentityAvailable || passphrase.length < 12}>
          <Upload size={12} aria-hidden="true" />{busy === 'restore' ? localized('恢复中...', 'Restoring...') : localized('恢复身份', 'Restore identity')}
        </button>
      </div>
      <div className="pws-delivery-identities-list">
        {snapshot.identities.length === 0 && <span className="pws-delivery-empty">{localized('暂无合作方身份', 'No partner identities')}</span>}
        {snapshot.identities.map((identity) => (
          <div className="pws-delivery-identity" data-status={identity.status} key={identity.fingerprint}>
            <div>
              <strong>{identity.label}</strong>
              <code>{shortDigest(identity.fingerprint)}</code>
              <span>{identity.status === 'trusted' ? localized('可信', 'Trusted') : localized('已撤销', 'Revoked')}{identity.lastProjectId ? ` · ${identity.lastProjectId}` : ''}</span>
            </div>
            {identity.status === 'trusted' && (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => void revoke(identity.fingerprint)}
                disabled={Boolean(revoking)}
                title={localized('撤销交付身份信任', 'Revoke delivery identity trust')}
              >
                <ShieldOff size={12} aria-hidden="true" />
                {revoking === identity.fingerprint ? localized('撤销中...', 'Revoking...') : localized('撤销', 'Revoke')}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function ProjectDeliveryAudit({ report }: { report: WorkflowProjectDeliveryIntegrityReport }): React.JSX.Element {
  return (
    <div className={`pws-project-delivery-audit is-${report.verdict}`} role="status">
      <div>
        <strong>{report.verdict === 'ready' ? localized('Project 当前产物全部可交付', 'All current project artifacts are deliverable') : localized(`${report.summary.blockedArtifactCount} 个当前产物有阻塞`, `${report.summary.blockedArtifactCount} current artifacts are blocked`)}</strong>
        <span>{report.summary.readyArtifactCount}/{report.summary.currentArtifactCount} {localized('可交付', 'deliverable')} · {localized('已核对', 'verified')} {formatBytes(report.summary.verifiedBytes)}</span>
      </div>
      {report.summary.blockerCounts.length > 0 && (
        <div className="pws-project-delivery-blockers">
          {report.summary.blockerCounts.map((item) => <span key={item.code}>{projectBlockerLabel(item.code)} · {item.count}</span>)}
        </div>
      )}
    </div>
  )
}

function projectBlockerLabel(code: WorkflowProjectDeliveryIntegrityReport['summary']['blockerCounts'][number]['code']): string {
  const labels: Record<typeof code, string> = {
    HISTORICAL_VERSION: localized('历史版本', 'Historical version'),
    LOCAL_LOCATION_UNVERIFIED: localized('文件未校验', 'File not verified'),
    EVIDENCE_MISSING: localized('缺 Evidence', 'Evidence missing'),
    ACCEPTANCE_MISSING: localized('缺 Acceptance', 'Acceptance missing'),
    ACCEPTANCE_PENDING: localized('等待验收', 'Acceptance pending'),
    ACCEPTANCE_FAILED: localized('验收失败', 'Acceptance failed')
  }
  return labels[code]
}

function DeliverySummary({ projection }: { projection: WorkflowProjectDeliveryWorkbench }): React.JSX.Element {
  const { summary } = projection
  return (
    <div className="pws-delivery-summary" data-delivery-summary>
      <span><strong>{summary.availableArtifactCount}</strong> {localized('可用产物', 'available artifacts')}</span>
      <span><strong>{summary.evidenceCount}</strong> Evidence</span>
      <span><strong>{summary.passedAcceptanceCount}</strong> {localized('通过', 'passed')}</span>
      <span><strong>{summary.pendingAcceptanceCount}</strong> {localized('待验收', 'pending')}</span>
      <span><strong>{summary.failedAcceptanceCount}</strong> {localized('失败', 'failed')}</span>
      <span><strong>{summary.unlinkedEvidenceCount}</strong> {localized('未绑定 Evidence', 'unlinked Evidence')}</span>
    </div>
  )
}

function ArtifactDeliveryList({
  artifacts,
  evidence,
  evidenceById,
  projectId,
  onOpenFile,
  onOpenPreview,
  onOpenBrowser,
  onRefresh
}: {
  artifacts: WorkflowProjectDeliveryArtifact[]
  evidence: WorkflowProjectDeliveryWorkbench['evidence']
  evidenceById: ReadonlyMap<string, WorkflowProjectDeliveryWorkbench['evidence'][number]>
  projectId: string
  onOpenFile: (path: string) => Promise<void>
  onOpenPreview: (path?: string) => Promise<void>
  onOpenBrowser: (url?: string) => Promise<void>
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const artifactById = new Map(artifacts.map((item) => [item.artifact.id, item]))
  return (
    <section className="pws-delivery-subsection" aria-labelledby="delivery-artifacts">
      <h3 id="delivery-artifacts">{localized('交付物', 'Deliverables')} ({artifacts.length})</h3>
      {artifacts.length === 0 ? <p className="pws-delivery-empty">{localized('暂无 Artifact', 'No Artifacts')}</p> : artifacts.map((item) => (
        <article className={`pws-delivery-artifact ${item.isCurrent ? '' : 'is-superseded'}`} key={item.artifact.id}>
          <div className="pws-delivery-artifact-head">
            <strong>{item.artifact.title}</strong>
            <span>v{item.artifact.version} · {item.artifact.kind}</span>
          </div>
          <div className="pws-delivery-artifact-meta">
            <span>{item.available ? localized('可用位置', 'Available location') : localized('缺少可用位置', 'No available location')} · {localized(`${item.locations.length} 个位置`, `${item.locations.length} locations`)}</span>
            <span>{item.evidenceIds.length} Evidence · {item.acceptanceIds.length} Acceptance</span>
          </div>
          <ArtifactLineage artifact={item} artifactById={artifactById} />
          <ArtifactComparer artifact={item} artifactById={artifactById} />
          <ArtifactIntegrity artifact={item} />
          <ArtifactExporter artifact={item} />
          {item.acceptanceIds.length === 0 && (
            <ArtifactAcceptanceCreator artifact={item} onRefresh={onRefresh} />
          )}
          {item.locations.length > 0 && <div className="pws-delivery-locations">{item.locations.map((location) => (
            <div className="pws-delivery-location" key={location.id}>
              <code>{location.path || location.uri || location.kind} · {location.availability}</code>
              {location.path && location.availability === 'available' && (
                <>
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => void onOpenFile(location.path!)}>{localized('打开文件', 'Open file')}</button>
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => void onOpenPreview(location.path)}>{localized('预览', 'Preview')}</button>
                </>
              )}
              {location.uri && /^https?:\/\//i.test(location.uri) && (
                <button type="button" className="btn btn-ghost btn-xs" onClick={() => void onOpenBrowser(location.uri)}>{localized('打开链接', 'Open link')}</button>
              )}
            </div>
          ))}</div>}
          {item.evidenceIds.length > 0 && <div className="pws-delivery-evidence-chips">{item.evidenceIds.map((id) => <span key={id}>{evidenceById.get(id)?.title || id}</span>)}</div>}
          <ArtifactEvidenceBinder
            artifact={item}
            evidence={evidence}
            projectId={projectId}
            onRefresh={onRefresh}
          />
        </article>
      ))}
    </section>
  )
}

function ArtifactLineage({
  artifact,
  artifactById
}: {
  artifact: WorkflowProjectDeliveryArtifact
  artifactById: ReadonlyMap<string, WorkflowProjectDeliveryArtifact>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const versions = artifact.lineageArtifactIds
    .map((id) => artifactById.get(id))
    .filter((item): item is WorkflowProjectDeliveryArtifact => Boolean(item))
  const hasHistory = versions.length > 1
  const currentVersions = artifact.currentArtifactIds
    .map((id) => artifactById.get(id))
    .filter((item): item is WorkflowProjectDeliveryArtifact => Boolean(item))
  return (
    <div className="pws-artifact-lineage">
      <div className="pws-artifact-lineage-summary">
        <code title={artifact.artifact.digest}>{shortDigest(artifact.artifact.digest)}</code>
        <span>{artifact.isCurrent ? localized('当前版本', 'Current version') : localized('历史版本', 'Historical version')}</span>
        {artifact.predecessorArtifactId && <span>{localized('替代', 'Supersedes')} v{artifactById.get(artifact.predecessorArtifactId)?.artifact.version ?? '?'}</span>}
        {artifact.successorArtifactIds.length > 0 && <span>{localized(`${artifact.successorArtifactIds.length} 个后继`, `${artifact.successorArtifactIds.length} successors`)}</span>}
        {hasHistory && (
          <button
            type="button"
            className="btn btn-ghost btn-icon-sm"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={expanded ? localized('收起版本历史', 'Collapse version history') : localized('展开版本历史', 'Expand version history')}
            title={expanded ? localized('收起版本历史', 'Collapse version history') : localized('展开版本历史', 'Expand version history')}
          >
            <DisclosureChevron expanded={expanded} size={13} />
          </button>
        )}
      </div>
      {!artifact.isCurrent && currentVersions.length > 0 && (
        <div className="pws-artifact-current-leaves">
          {localized('当前可交付：', 'Current deliverables: ')}{currentVersions.map((item) => `v${item.artifact.version} ${shortDigest(item.artifact.digest)}`).join(' · ')}
        </div>
      )}
      {expanded && (
        <ol className="pws-artifact-lineage-versions">
          {versions.map((item) => (
            <li className={item.isCurrent ? 'is-current' : ''} key={item.artifact.id}>
              <span>v{item.artifact.version}</span>
              <strong>{item.artifact.title}</strong>
              <code title={item.artifact.digest}>{shortDigest(item.artifact.digest)}</code>
              <span>{item.isCurrent ? localized('当前', 'Current') : localized('历史', 'Historical')}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function shortDigest(value: string): string {
  const normalized = value.replace(/^sha256:/i, '')
  return normalized.length > 16 ? `${normalized.slice(0, 8)}...${normalized.slice(-8)}` : normalized
}

function ArtifactComparer({
  artifact,
  artifactById
}: {
  artifact: WorkflowProjectDeliveryArtifact
  artifactById: ReadonlyMap<string, WorkflowProjectDeliveryArtifact>
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<WorkflowArtifactCompareResult>()
  const [error, setError] = useState('')
  const baseArtifactId = artifact.predecessorArtifactId ?? artifact.artifact.id
  const targetArtifactId = artifact.predecessorArtifactId
    ? artifact.artifact.id
    : artifact.successorArtifactIds[0]
  if (!targetArtifactId || !artifactById.has(baseArtifactId) || !artifactById.has(targetArtifactId)) return null
  const compare = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setResult(await window.agentDesk.compareWorkflowArtifacts({ baseArtifactId, targetArtifactId }))
    } catch (cause) {
      setResult(undefined)
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pws-artifact-compare">
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => void compare()} disabled={busy}>
        <GitCompareArrows size={12} aria-hidden="true" />
        {busy ? localized('比较中...', 'Comparing...') : artifact.predecessorArtifactId ? localized('对比前一版', 'Compare previous version') : localized('对比后一版', 'Compare next version')}
      </button>
      {result && <ArtifactCompareResult result={result} />}
      {error && <span className="pws-delivery-inline-error" role="alert">{error}</span>}
    </div>
  )
}

function ArtifactCompareResult({ result }: { result: WorkflowArtifactCompareResult }): React.JSX.Element {
  return (
    <div className="pws-artifact-compare-result" role="status">
      <div className="pws-artifact-compare-summary">
        <strong>v{result.base.version} → v{result.target.version}</strong>
        <span>{result.comparison === 'identical' ? localized('内容相同', 'Identical content') : result.comparison === 'binary' ? localized('二进制差异', 'Binary difference') : localized(`+${result.addedLines} / -${result.removedLines} 行`, `+${result.addedLines} / -${result.removedLines} lines`)}</span>
        <span>{signedBytes(result.sizeDeltaBytes)}</span>
        {result.truncated && <span>{localized('结果已截断', 'Result truncated')}</span>}
      </div>
      <div className="pws-artifact-compare-digests">
        <code title={result.base.digest}>{shortDigest(result.base.digest)}</code>
        <span>→</span>
        <code title={result.target.digest}>{shortDigest(result.target.digest)}</code>
      </div>
      {result.changes.length > 0 && (
        <pre className="pws-artifact-compare-lines" aria-label={localized('Artifact 文本版本差异', 'Artifact text version diff')}>
          {result.changes.map((change, index) => (
            <span className={`is-${change.kind}`} key={`${index}:${change.kind}`}>
              {change.kind === 'added' ? '+' : change.kind === 'removed' ? '-' : ' '}{change.text}{'\n'}
            </span>
          ))}
        </pre>
      )}
    </div>
  )
}

function signedBytes(value: number): string {
  if (value === 0) return localized('大小不变', 'No size change')
  return `${value > 0 ? '+' : '-'}${formatBytes(Math.abs(value))}`
}

function ArtifactExporter({ artifact }: { artifact: WorkflowProjectDeliveryArtifact }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const hasLocalLocation = artifact.locations.some((location) =>
    location.availability === 'available' && Boolean(location.path || location.uri?.toLowerCase().startsWith('file:'))
  )
  const exportArtifact = async (): Promise<void> => {
    setBusy(true)
    setMessage('')
    setError('')
    try {
      const result = await window.agentDesk.exportWorkflowArtifact({ artifactId: artifact.artifact.id })
      if (!result.canceled) {
        setMessage(`${result.fileName} · ${formatBytes(result.sizeBytes)} · ${result.digest.slice(0, 20)}`)
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pws-delivery-artifact-export">
      <button
        type="button"
        className="btn btn-ghost btn-xs"
        onClick={() => void exportArtifact()}
        disabled={busy || !hasLocalLocation}
        title={hasLocalLocation ? localized('导出并校验交付物', 'Export and verify deliverable') : localized('没有可导出的本地文件', 'No exportable local file')}
      >
        <Download size={12} aria-hidden="true" />
        {busy ? localized('导出中...', 'Exporting...') : localized('导出', 'Export')}
      </button>
      {message && <span className="pws-delivery-inline-success" role="status">{message}</span>}
      {error && <span className="pws-delivery-inline-error" role="alert">{error}</span>}
    </div>
  )
}

function ArtifactIntegrity({ artifact }: { artifact: WorkflowProjectDeliveryArtifact }): React.JSX.Element {
  const [busy, setBusy] = useState<'verify' | 'manifest' | ''>('')
  const [report, setReport] = useState<WorkflowArtifactIntegrityReport>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const verify = async (): Promise<void> => {
    setBusy('verify')
    setMessage('')
    setError('')
    try {
      setReport(await window.agentDesk.verifyWorkflowArtifactIntegrity({ artifactId: artifact.artifact.id }))
    } catch (cause) {
      setReport(undefined)
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }
  const exportManifest = async (): Promise<void> => {
    setBusy('manifest')
    setMessage('')
    setError('')
    try {
      const result = await window.agentDesk.exportWorkflowArtifactManifest({ artifactId: artifact.artifact.id })
      if (!result.canceled) {
        setMessage(`${result.fileName} · ${result.verdict === 'ready' ? localized('可交付', 'Ready') : localized('含阻塞项', 'Contains blockers')} · ${shortDigest(result.manifestDigest)}`)
        setReport(await window.agentDesk.verifyWorkflowArtifactIntegrity({ artifactId: artifact.artifact.id }))
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy('')
    }
  }
  return (
    <div className="pws-artifact-integrity">
      <div className="pws-artifact-integrity-actions">
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => void verify()} disabled={Boolean(busy)}>
          <ShieldCheck size={12} aria-hidden="true" />
          {busy === 'verify' ? localized('校验中...', 'Verifying...') : localized('完整性校验', 'Verify integrity')}
        </button>
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => void exportManifest()} disabled={Boolean(busy)}>
          <FileJson size={12} aria-hidden="true" />
          {busy === 'manifest' ? localized('导出中...', 'Exporting...') : localized('交付清单', 'Delivery manifest')}
        </button>
      </div>
      {report && <ArtifactIntegrityResult report={report} />}
      {message && <span className="pws-delivery-inline-success" role="status">{message}</span>}
      {error && <span className="pws-delivery-inline-error" role="alert">{error}</span>}
    </div>
  )
}

function ArtifactIntegrityResult({ report }: { report: WorkflowArtifactIntegrityReport }): React.JSX.Element {
  return (
    <div className={`pws-artifact-integrity-result is-${report.verdict}`} role="status">
      <div className="pws-artifact-integrity-verdict">
        <strong>{report.verdict === 'ready' ? localized('可交付', 'Ready') : localized(`${report.blockers.length} 个阻塞项`, `${report.blockers.length} blockers`)}</strong>
        <span>{report.locations.byteVerified ? localized('字节已校验', 'Bytes verified') : localized('字节未校验', 'Bytes not verified')} · {report.evidence.length} Evidence · {report.acceptances.length} Acceptance</span>
      </div>
      <div className="pws-artifact-integrity-checks">
        {report.checks.map((check) => (
          <span className={`is-${check.status}`} key={check.kind} title={check.message}>
            {check.status === 'passed' ? localized('通过', 'Passed') : localized('阻塞', 'Blocked')} · {integrityCheckLabel(check.kind)}
          </span>
        ))}
      </div>
      {report.blockers.length > 0 && (
        <ul className="pws-artifact-integrity-blockers">
          {report.blockers.map((blocker) => <li key={blocker.code}>{blocker.message}</li>)}
        </ul>
      )}
    </div>
  )
}

function integrityCheckLabel(kind: WorkflowArtifactIntegrityReport['checks'][number]['kind']): string {
  const labels: Record<typeof kind, string> = {
    canonical_ownership: localized('Project 归属', 'Project ownership'),
    artifact_graph: 'Artifact Graph',
    current_version: localized('当前版本', 'Current version'),
    local_location: localized('本地位置', 'Local location'),
    content_identity: localized('文件身份', 'Content identity'),
    evidence_binding: 'Evidence',
    acceptance_status: 'Acceptance'
  }
  return labels[kind]
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

function ArtifactAcceptanceCreator({
  artifact,
  onRefresh
}: {
  artifact: WorkflowProjectDeliveryArtifact
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const createAcceptance = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.agentDesk.createWorkflowArtifactAcceptance({ artifactId: artifact.artifact.id })
      await onRefresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pws-delivery-evidence-binder">
      <button
        type="button"
        className="btn btn-primary btn-xs"
        onClick={() => void createAcceptance()}
        disabled={busy}
      >
        {busy ? localized('创建中...', 'Creating...') : localized('创建验收', 'Create acceptance')}
      </button>
      {error && <p className="pws-delivery-inline-error" role="alert">{error}</p>}
    </div>
  )
}

function ArtifactEvidenceBinder({
  artifact,
  evidence,
  projectId,
  onRefresh
}: {
  artifact: WorkflowProjectDeliveryArtifact
  evidence: WorkflowProjectDeliveryWorkbench['evidence']
  projectId: string
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const [selectedEvidenceId, setSelectedEvidenceId] = useState('')
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [kind, setKind] = useState<WorkflowEvidenceKind>('delivery_check')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const attachExisting = async (): Promise<void> => {
    if (!selectedEvidenceId) return
    setBusy(true)
    setError('')
    try {
      await window.agentDesk.createWorkflowEvidenceLink({
        id: newWorkflowId('evidence-link'),
        evidenceId: selectedEvidenceId,
        projectId,
        artifactId: artifact.artifact.id,
        relation: 'verifies'
      })
      setSelectedEvidenceId('')
      await onRefresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const createAndAttach = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      setError(localized('Evidence 标题不能为空', 'Evidence title is required'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const evidenceId = newWorkflowId('evidence')
      await window.agentDesk.createWorkflowEvidence({
        evidenceId,
        projectId,
        artifactId: artifact.artifact.id,
        kind,
        title: trimmedTitle,
        ...(summary.trim() ? { summary: summary.trim() } : {}),
        contentDigest: await sha256(`${trimmedTitle}\n${summary.trim()}\n${artifact.artifact.id}`)
      })
      await window.agentDesk.createWorkflowEvidenceLink({
        id: newWorkflowId('evidence-link'),
        evidenceId,
        projectId,
        artifactId: artifact.artifact.id,
        relation: 'verifies'
      })
      setTitle('')
      setSummary('')
      await onRefresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const availableEvidence = evidence.filter((record) => !artifact.evidenceIds.includes(record.evidenceId))
  return (
    <div className="pws-delivery-evidence-binder">
      <div className="pws-delivery-binder-row">
        <select className="select" value={selectedEvidenceId} onChange={(event) => setSelectedEvidenceId(event.target.value)} disabled={busy} aria-label={localized('选择已有 Evidence', 'Select existing Evidence')}>
          <option value="">{localized('选择已有 Evidence', 'Select existing Evidence')}</option>
          {availableEvidence.map((record) => <option key={record.evidenceId} value={record.evidenceId}>{record.title}</option>)}
        </select>
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => void attachExisting()} disabled={busy || !selectedEvidenceId}>{localized('绑定 Evidence', 'Bind Evidence')}</button>
      </div>
      <form className="pws-delivery-new-evidence" onSubmit={(event) => void createAndAttach(event)}>
        <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={localized('新 Evidence 标题', 'New Evidence title')} disabled={busy} />
        <select className="select" value={kind} onChange={(event) => setKind(event.target.value as WorkflowEvidenceKind)} disabled={busy} aria-label={localized('Evidence 类型', 'Evidence type')}>
          {EVIDENCE_KINDS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        <input className="input" value={summary} onChange={(event) => setSummary(event.target.value)} placeholder={localized('摘要（可选）', 'Summary (optional)')} disabled={busy} />
        <button type="submit" className="btn btn-ghost btn-xs" disabled={busy || !title.trim()}>{localized('新建并绑定', 'Create and bind')}</button>
      </form>
      {error && <p className="pws-delivery-inline-error" role="alert">{error}</p>}
    </div>
  )
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const result = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function downloadDeliveryExport(projectId: string, json: string): void {
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${projectId.replace(/[^a-z0-9_-]+/gi, '-') || 'project'}-delivery-export.json`
  link.click()
  URL.revokeObjectURL(url)
}

function localized(chinese: string, english: string): string {
  return useStore.getState().settings.language === 'en' ? english : chinese
}
