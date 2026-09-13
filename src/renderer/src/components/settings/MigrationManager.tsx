import { useEffect, useState } from 'react'
import type {
  MigrationApplyResult,
  MigrationAsset,
  MigrationDecisionAction,
  MigrationScan
} from '../../../../shared/types'
import { useT } from '../../i18n'

export default function MigrationManager({ defaultDirectory }: { defaultDirectory?: string }): React.JSX.Element {
  const t = useT()
  const [directory, setDirectory] = useState('')
  const [scan, setScan] = useState<MigrationScan | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [backupId, setBackupId] = useState('')

  useEffect(() => {
    if (defaultDirectory) setDirectory((current) => current || defaultDirectory)
  }, [defaultDirectory])

  const runScan = async (): Promise<void> => {
    setBusy(true)
    setMessage('')
    setBackupId('')
    try {
      const result = await window.agentDesk.scanMigration(directory.trim() || undefined)
      setScan(result)
      setPicked(recommendedIds(result))
    } catch (error) {
      setMessage(errorText(error))
      setScan(null)
    } finally {
      setBusy(false)
    }
  }

  const runImport = async (): Promise<void> => {
    if (!scan || picked.size === 0) return
    setBusy(true)
    try {
      const result: MigrationApplyResult = await window.agentDesk.applyMigration({
        scanId: scan.scanId,
        decisions: scan.assets.map((asset) => ({ assetId: asset.id, action: decisionFor(asset, picked) }))
      })
      setMessage(result.message)
      setBackupId(result.backupId ?? '')
      // Keep the scan snapshot stable while the rollback affordance is visible;
      // a concurrent rescan can race the operation's durable backup state.
    } catch (error) {
      setMessage(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const runRollback = async (): Promise<void> => {
    if (!backupId) return
    setBusy(true)
    try {
      const result = await window.agentDesk.rollbackMigration(backupId)
      setMessage(result.message)
      if (result.ok) {
        setBackupId('')
        void refreshAfterMutation(scan?.cwd)
      }
    } catch (error) {
      setMessage(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const refreshScan = async (cwd?: string): Promise<void> => {
    const refreshed = await window.agentDesk.scanMigration(cwd)
    setScan(refreshed)
    setPicked(recommendedIds(refreshed))
  }

  const refreshAfterMutation = async (cwd?: string): Promise<void> => {
    try {
      await refreshScan(cwd)
    } catch (error) {
      setMessage(errorText(error))
    }
  }

  const toggle = (assetId: string): void => {
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(assetId)) next.delete(assetId)
      else next.add(assetId)
      return next
    })
  }

  return (
    <div className="migration-manager" data-migration-manager>
      <h3 className="settings-h3">{t('migrateTitle')}</h3>
      <p className="settings-hint">{t('migrateHint')}</p>
      <label className="field-label">{t('migrateProjectDirOptional')}</label>
      <div className="field-row">
        <input
          className="input"
          value={directory}
          placeholder={t('migrateConversationPlaceholder')}
          onChange={(event) => setDirectory(event.target.value)}
        />
        <button className="btn btn-ghost" data-migration-scan disabled={busy} onClick={() => void runScan()}>
          {busy ? t('migrateScanning') : t('migrateScan')}
        </button>
      </div>
      {scan && <MigrationScanResults scan={scan} picked={picked} busy={busy} onToggle={toggle} onImport={runImport} />}
      {message && <div className="notice notice-info migrate-result" data-migration-result>{message}</div>}
      {backupId && (
        <button
          className="btn btn-ghost migrate-rollback"
          data-migration-rollback
          disabled={busy}
          onClick={() => void runRollback()}
        >
          {t('migrateRollback')}
        </button>
      )}
    </div>
  )
}

function MigrationScanResults({
  scan,
  picked,
  busy,
  onToggle,
  onImport
}: {
  scan: MigrationScan
  picked: Set<string>
  busy: boolean
  onToggle: (assetId: string) => void
  onImport: () => Promise<void>
}): React.JSX.Element {
  const t = useT()
  return (
    <>
      <div className="migrate-scan-meta" data-migration-mode={scan.mode}>
        <span>{scan.mode === 'project' ? t('migrateScopeProject') : t('migrateScopeConversation')}</span>
        <span>{t('migrateFound', { n: scan.assets.length })}</span>
      </div>
      {scan.assets.length === 0 ? (
        <div className="provider-empty">{t('migrateNothing')}</div>
      ) : (
        <div className="provider-list">
          {scan.assets.map((asset) => (
            <MigrationAssetRow key={asset.id} asset={asset} checked={picked.has(asset.id)} onToggle={onToggle} />
          ))}
        </div>
      )}
      {scan.assets.length > 0 && (
        <button
          className="btn btn-primary"
          data-migration-apply
          disabled={busy || picked.size === 0}
          onClick={() => void onImport()}
        >
          {busy ? t('migrateImporting') : t('migrateImport', { n: picked.size })}
        </button>
      )}
    </>
  )
}

function MigrationAssetRow({
  asset,
  checked,
  onToggle
}: {
  asset: MigrationAsset
  checked: boolean
  onToggle: (assetId: string) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <label
      className={`provider-row migrate-row migrate-risk-${asset.risk}`}
      data-migration-asset={asset.id}
      data-migration-kind={asset.kind}
      data-migration-risk={asset.risk}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={!asset.importable}
        onChange={() => onToggle(asset.id)}
      />
      <div className="provider-row-body">
        <div className="provider-row-name">
          {asset.agent} · {asset.name}
          <span className="migrate-kind">{kindLabel(asset, t)}</span>
          <span className={`migrate-risk migrate-risk-label-${asset.risk}`}>{riskLabel(asset, t)}</span>
        </div>
        <div className="provider-row-sub">{asset.path}</div>
        {asset.targetPath && <div className="provider-row-sub">{t('migrateTarget')} · {asset.targetPath}</div>}
        <div className="migrate-preview">{asset.preview}</div>
        {(asset.conflict !== 'none' || asset.ignoredFields.length > 0) && (
          <div className="migrate-flags">
            {asset.conflict !== 'none' && <span>{t('migrateConflict')} · {asset.conflictDetail ?? asset.conflict}</span>}
            {asset.ignoredFields.length > 0 && <span>{t('migrateIgnoredFields', { n: asset.ignoredFields.length })}</span>}
          </div>
        )}
      </div>
    </label>
  )
}

function recommendedIds(scan: MigrationScan): Set<string> {
  return new Set(scan.assets.filter((asset) => asset.recommended).map((asset) => asset.id))
}

function decisionFor(asset: MigrationAsset, picked: Set<string>): MigrationDecisionAction {
  if (!picked.has(asset.id)) return 'skip'
  return asset.conflict === 'replace_required' ? 'replace' : 'import'
}

function kindLabel(asset: MigrationAsset, t: ReturnType<typeof useT>): string {
  if (asset.kind === 'rules') return t('migrateKindRules')
  if (asset.kind === 'mcp') return 'MCP'
  if (asset.kind === 'skill') return 'Skill'
  if (asset.kind === 'prompt') return 'Prompt'
  if (asset.kind === 'usage') return t('providerUsageTitle')
  if (asset.kind === 'hook') return 'Hook'
  if (asset.kind === 'memory') return t('migrateKindMemory')
  if (asset.kind === 'routine') return t('migrateKindRoutine')
  if (asset.kind === 'channel') return t('migrateKindChannel')
  return t('migrateKindConfig')
}

function riskLabel(asset: MigrationAsset, t: ReturnType<typeof useT>): string {
  if (asset.risk === 'low') return t('migrateRiskLow')
  if (asset.risk === 'review') return t('migrateRiskReview')
  return t('migrateRiskBlocked')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
