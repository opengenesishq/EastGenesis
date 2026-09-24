import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileScan, RotateCcw, Trash2, X } from 'lucide-react'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import ProviderImportedModelRecovery from './ProviderImportedModelRecovery'
import { AUTO_MODEL } from '../../../../shared/types'
import type {
  ProviderProfileBackupView,
  ProviderProfileBackupPreview,
  ProviderProfileImportAction,
  ProviderProfileImportDecision,
  ProviderProfileImportPreview,
  ProviderNativeImportBackupView,
  ProviderNativeClient,
  ProviderNativeImportPreview,
  ProviderView
} from '../../../../shared/types'

type ProfileBusyState = 'import' | 'export' | 'apply' | 'backup-preview' | 'backup-delete' | 'rollback' | 'native-scan' | 'native-apply' | 'native-rollback' | ''

interface Props {
  providers: ProviderView[]
  onAdd: () => void
  onEdit?: (provider: ProviderView) => void
  children: ReactNode
}

export default function ProviderProfileManager({ providers, onAdd, onEdit, children }: Props): React.JSX.Element {
  const t = useT()
  const profile = useProviderProfileManager(providers)
  const context = useStore(state => state.settingsContext)
  const zh = useStore(state => state.settings.language === 'zh')
  const nativeClientRef = useRef<HTMLSelectElement>(null)
  useEffect(() => { if (context === 'welcome-provider-import') nativeClientRef.current?.focus() }, [context])
  const usable = providers.find(provider => provider.ready && provider.models.length > 0)
  return (
    <>
      {context === 'welcome-provider-import' && <div className="provider-first-import" data-provider-first-import>
        <p>{zh ? '选择本机客户端后扫描配置，再预览并确认导入。你的任务草稿已保留。' : 'Choose a local client, scan its configuration, then review and confirm the import. Your task draft is kept.'}</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
          const state = useStore.getState()
          if (usable) state.updateWelcomeDraft({ computeSelectionSource: 'user', providerId: usable.id, model: state.welcomeDraft.routingMode === 'fixed' ? usable.models[0] : AUTO_MODEL })
          state.setShowSettings(false)
        }}>{zh ? '返回任务草稿' : 'Back to task draft'}</button>
      </div>}
      <div className="settings-section-head">
        <h3 className="settings-h3">{t('tabProviders')}</h3>
        <div className="provider-profile-actions">
          <select ref={nativeClientRef} className="select" aria-label={t('providerNativeClient')} data-provider-native-client value={profile.nativeClient} disabled={Boolean(profile.busy)} onChange={(event) => profile.setNativeClient(event.target.value as ProviderNativeClient)}>
            <option value="codex">Codex</option><option value="claude">Claude Code</option>
            <option value="gemini">Gemini CLI</option><option value="opencode">OpenCode</option><option value="cc-switch">CC Switch</option>
          </select>
          <button className="btn btn-ghost btn-sm" data-provider-native-scan disabled={Boolean(profile.busy)} onClick={() => void profile.scanNative()}>
            <FileScan size={14} aria-hidden="true" /> {t('providerNativeScan')}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={Boolean(profile.busy)} onClick={() => void profile.chooseImport()}>
            {t('providerProfileImport')}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={Boolean(profile.busy) || providers.length === 0}
            onClick={() => void profile.exportProfile()}
          >
            {t('providerProfileExport')}
          </button>
          <button className="btn btn-ghost btn-sm" data-provider-add disabled={Boolean(profile.busy)} onClick={onAdd}>
            {t('addProvider')}
          </button>
        </div>
      </div>
      <p className="settings-hint provider-profile-hint">{t('providerProfileSafetyHint')}</p>
      {profile.message && <div className="notice notice-info provider-profile-notice">{profile.message}</div>}
      {profile.error && <div className="notice notice-error provider-profile-notice">{profile.error}</div>}
      {profile.nativePreview && <ProviderNativeCodexPreview profile={profile} />}
      {profile.preview && <ProviderProfilePreviewPanel profile={profile} />}
      {profile.backupPreview && <ProviderProfileBackupPreviewPanel profile={profile} />}
      <ProviderImportedModelRecovery providers={providers} busy={Boolean(profile.busy)} onEdit={onEdit} />
      {children}
      {profile.nativeBackups.length > 0 && <ProviderNativeBackups profile={profile} />}
      {profile.backups.length > 0 && <ProviderProfileBackups profile={profile} />}
    </>
  )
}

function useProviderProfileManager(providers: ProviderView[]) {
  const t = useT()
  const applyProviderProfileImport = useStore((state) => state.applyProviderProfileImport)
  const refreshProviders = useStore((state) => state.refreshProviders)
  const [preview, setPreview] = useState<ProviderProfileImportPreview | null>(null)
  const [decisions, setDecisions] = useState<Record<string, ProviderProfileImportAction>>({})
  const [backups, setBackups] = useState<ProviderProfileBackupView[]>([])
  const [backupPreview, setBackupPreview] = useState<ProviderProfileBackupPreview | null>(null)
  const [busy, setBusy] = useState<ProfileBusyState>('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const native = useNativeProviderImports({
    providers, refreshProviders, t, setBusy, setMessage, setError,
    clearProfilePreview: () => { setPreview(null); setDecisions({}) }
  })
  const selectedCounts = useMemo(() => importActionCounts(preview, decisions), [preview, decisions])

  useEffect(() => { void refreshBackups() }, [providers])

  async function refreshBackups(): Promise<void> {
    setBackups(await window.agentDesk.listProviderProfileBackups().catch(() => []))
  }

  async function exportProfile(): Promise<void> {
    setBusy('export'); setError(''); setMessage('')
    try {
      const result = await window.agentDesk.exportProviderProfile()
      if (!result.canceled) setMessage(t('providerProfileExported', { n: result.providerCount }))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  async function chooseImport(): Promise<void> {
    setBusy('import'); setError(''); setMessage('')
    try {
      const next = await window.agentDesk.previewProviderProfileImport()
      if (!next) return
      setPreview(next)
      setDecisions(Object.fromEntries(next.items.map((item) => [item.id, item.defaultAction])))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  async function applyImport(): Promise<void> {
    if (!preview || selectedCounts.create + selectedCounts.update === 0) return
    setBusy('apply'); setError(''); setMessage('')
    try {
      const selected: ProviderProfileImportDecision[] = preview.items.map((item) => ({
        itemId: item.id,
        action: decisions[item.id] ?? item.defaultAction
      }))
      const result = await applyProviderProfileImport(preview.previewId, selected)
      setPreview(null); setDecisions({})
      setMessage(t('providerProfileApplied', {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped
      }))
      await refreshBackups()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  async function previewBackup(backup: ProviderProfileBackupView): Promise<void> {
    setBusy('backup-preview'); setError(''); setMessage('')
    try {
      setBackupPreview(await window.agentDesk.previewProviderProfileBackup(backup.id))
      setPreview(null); setDecisions({})
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  async function rollback(): Promise<void> {
    if (!backupPreview) return
    if (!window.confirm(t('providerProfileRollbackConfirm', {
      time: formattedTime(backupPreview.backup.createdAt)
    }))) return
    setBusy('rollback'); setError(''); setMessage('')
    try {
      const result = await window.agentDesk.applyProviderProfileBackupPreview(backupPreview.previewId)
      setBackupPreview(null)
      setMessage(t('providerProfileRolledBack', { n: result.providers.length }))
      await refreshProviders()
      await refreshBackups()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  async function deleteBackup(backup: ProviderProfileBackupView): Promise<void> {
    if (!window.confirm(t('providerProfileBackupDeleteConfirm', { time: formattedTime(backup.createdAt) }))) return
    setBusy('backup-delete'); setError(''); setMessage('')
    try {
      await window.agentDesk.deleteProviderProfileBackup(backup.id)
      setBackupPreview((current) => current?.backup.id === backup.id ? null : current)
      setMessage(t('providerProfileBackupDeleted'))
      await refreshBackups()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }

  function closePreview(): void {
    setPreview(null)
    setDecisions({})
  }

  function closeBackupPreview(): void {
    setBackupPreview(null)
  }

  return {
    preview, decisions, backups, backupPreview, busy, message, error, selectedCounts,
    setDecisions, exportProfile, chooseImport, applyImport, previewBackup, rollback, deleteBackup, closePreview, closeBackupPreview,
    ...native
  }
}

type NativeProfileArgs = {
  providers: ProviderView[]
  refreshProviders: () => Promise<void>
  t: ReturnType<typeof useT>
  setBusy: (value: ProfileBusyState) => void
  setMessage: (value: string) => void
  setError: (value: string) => void
  clearProfilePreview: () => void
}

function useNativeProviderImports({ providers, refreshProviders, t, setBusy, setMessage, setError, clearProfilePreview }: NativeProfileArgs) {
  const [nativeClient, setNativeClient] = useState<ProviderNativeClient>('codex')
  const [nativeCandidates, setNativeCandidates] = useState<ProviderNativeImportPreview[]>([])
  const [nativePreview, setNativePreview] = useState<ProviderNativeImportPreview | null>(null)
  const [nativeAction, setNativeAction] = useState<ProviderProfileImportAction>('skip')
  const [nativeBackups, setNativeBackups] = useState<ProviderNativeImportBackupView[]>([])
  const refreshNativeBackups = async (): Promise<void> => {
    setNativeBackups(await window.agentDesk.listProviderNativeImportBackups().catch(() => []))
  }
  useEffect(() => { void refreshNativeBackups() }, [providers])
  const prepare = (nextBusy: ProfileBusyState): void => { setBusy(nextBusy); setError(''); setMessage('') }
  async function scanNative(): Promise<void> {
    prepare('native-scan')
    try {
      setNativeCandidates([]); setNativePreview(null)
      const candidates = await window.agentDesk.previewNativeProviderImports(nativeClient)
      const next = candidates[0]
      setNativeCandidates(candidates); setNativePreview(next ?? null); setNativeAction(next?.defaultAction ?? 'skip')
      clearProfilePreview()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }
  async function applyNativeImport(): Promise<void> {
    if (!nativePreview || nativeAction === 'skip') return
    prepare('native-apply')
    try {
      const result = await window.agentDesk.applyNativeProviderImport(nativePreview.previewId, nativeAction)
      setNativeCandidates([]); setNativePreview(null); setNativeAction('skip')
      await refreshProviders(); await refreshNativeBackups()
      setMessage(t('providerNativeCodexApplied', { name: result.provider.name }))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }
  async function rollbackNativeImport(backup: ProviderNativeImportBackupView): Promise<void> {
    if (!window.confirm(t('providerNativeCodexRollbackConfirm', { name: backup.providerName }))) return
    prepare('native-rollback')
    try {
      await window.agentDesk.rollbackProviderNativeImportBackup(backup.id)
      await refreshProviders(); await refreshNativeBackups()
      setMessage(t('providerNativeCodexRolledBack', { name: backup.providerName }))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy('')
    }
  }
  const closeNativePreview = (): void => { setNativeCandidates([]); setNativePreview(null); setNativeAction('skip') }
  const selectNativeCandidate = (id: string): void => {
    const next = nativeCandidates.find((candidate) => candidate.previewId === id)
    if (next) { setNativePreview(next); setNativeAction(next.defaultAction) }
  }
  return { nativePreview, nativeCandidates, nativeClient, setNativeClient, selectNativeCandidate, nativeAction, nativeBackups, setNativeAction, scanNative, applyNativeImport, rollbackNativeImport, closeNativePreview }
}

type ProfileController = ReturnType<typeof useProviderProfileManager>

function ProviderNativeCodexPreview({ profile }: { profile: ProfileController }): React.JSX.Element {
  const t = useT()
  const preview = profile.nativePreview
  if (!preview) throw new Error('Codex native import preview is required')
  return (
    <section className="provider-native-preview" aria-label={t('providerNativePreviewTitle', { client: nativeClientLabel(preview.client) })} data-provider-native-preview>
      <div className="provider-native-preview-head">
        <div>
          <h4>{t('providerNativePreviewTitle', { client: nativeClientLabel(preview.client) })}</h4>
          {profile.nativeCandidates.length > 1 && <select className="select" aria-label={t('providerNativeSelectProvider')} value={preview.previewId} onChange={(event) => profile.selectNativeCandidate(event.target.value)}>
            {profile.nativeCandidates.map((candidate) => <option key={candidate.previewId} value={candidate.previewId}>{candidate.providerName} · {candidate.sourceLabel}</option>)}
          </select>}
          <p>{t('providerNativeCodexSource', {
            source: preview.source === 'environment-override'
              ? t('providerNativeEnvironmentOverride')
              : t('providerNativeCodexUserProfile'),
            config: preview.client === 'codex' ? preview.configPresent ? 'config.toml' : '-' : preview.sourceLabel ?? nativeClientLabel(preview.client),
            auth: preview.client === 'codex' ? preview.authPresent ? 'auth.json' : '-' : nativeCredentialLabel(preview, t)
          })}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-icon-sm" title={t('cancel')} aria-label={t('cancel')} onClick={profile.closeNativePreview}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="provider-native-summary">
        <NativeFact label={t('providerNativeCodexTarget')} value={preview.targetProviderName || t('providerNativeCodexNewProvider')} />
        <NativeFact label={t('providerNativeCodexProtocol')} value={({ responses: 'OpenAI Responses', chat: 'Chat Completions', anthropic: 'Anthropic Messages', gemini: 'Gemini' })[preview.protocol]} />
        <NativeFact label={t('providerNativeCodexCredential')} value={nativeCredentialLabel(preview, t)} />
        <NativeFact label={t('providerNativeCodexModels')} value={preview.models.join(', ') || '-'} />
      </div>
      {preview.warnings.map((warning) => (
        <div key={warning} className="provider-profile-warning">{t(`providerNativeWarning_${warning}`)}</div>
      ))}
      {preview.diffs.length > 0 && (
        <div className="provider-native-diffs" role="table" aria-label={t('providerNativeCodexDiffs')}>
          <div className="provider-native-diff provider-native-diff-head" role="row">
            <span>{t('providerNativeCodexField')}</span><span>{t('providerNativeCodexCurrent')}</span><span>{t('providerNativeCodexIncoming')}</span>
          </div>
          {preview.diffs.map((diff) => (
            <div className="provider-native-diff" role="row" key={diff.field}>
              <strong>{t(`providerNativeField_${diff.field}`)}</strong>
              <span>{diff.current ?? '-'}</span>
              <span>{diff.incoming}</span>
            </div>
          ))}
        </div>
      )}
      {preview.ignoredSections.length > 0 && (
        <div className="provider-native-ignored">
          <strong>{t('providerNativeCodexIgnored')}</strong>
          <span>{preview.ignoredSections.join(', ')}</span>
        </div>
      )}
      <div className="provider-profile-preview-footer">
        <span>{t('providerNativeCodexSafety')}</span>
        <div className="provider-native-apply-actions">
          <select className="select" value={profile.nativeAction} disabled={profile.busy === 'native-apply'} onChange={(event) => profile.setNativeAction(event.target.value as ProviderProfileImportAction)}>
            {preview.allowedActions.map((action) => <option key={action} value={action}>{t(`providerProfileAction_${action}`)}</option>)}
          </select>
          <button className="btn btn-primary btn-sm" disabled={profile.busy === 'native-apply' || profile.nativeAction === 'skip'} onClick={() => void profile.applyNativeImport()}>
            {profile.busy === 'native-apply' ? t('providerProfileApplying') : t('providerNativeApply')}
          </button>
        </div>
      </div>
    </section>
  )
}

function nativeClientLabel(client: ProviderNativeClient): string {
  return ({ codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini CLI', opencode: 'OpenCode', 'cc-switch': 'CC Switch' })[client]
}

function NativeFact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

function nativeCredentialLabel(preview: ProviderNativeImportPreview, t: ReturnType<typeof useT>): string {
  const kind = t(`providerNativeCredential_${preview.credentialKind}`)
  if (!preview.credentialImportable) return kind
  return `${kind} · ${t('providerNativeCredentialImportable')}`
}

function ProviderNativeBackups({ profile }: { profile: ProfileController }): React.JSX.Element {
  const t = useT()
  return (
    <section className="provider-native-backups" aria-label={t('providerNativeCodexBackups')}>
      <h4>{t('providerNativeCodexBackups')}</h4>
      {profile.nativeBackups.slice(0, 3).map((backup) => (
        <div className="provider-profile-backup-row" key={backup.id}>
          <div>
            <strong>{backup.providerName}</strong>
            <span>{formattedTime(backup.createdAt)} · {t(`providerProfileAction_${backup.action}`)}</span>
          </div>
          <button className="btn btn-ghost btn-sm" disabled={Boolean(profile.busy)} onClick={() => void profile.rollbackNativeImport(backup)}>
            <RotateCcw size={14} aria-hidden="true" /> {t('providerProfileRollback')}
          </button>
        </div>
      ))}
    </section>
  )
}

function ProviderProfilePreviewPanel({ profile }: { profile: ProfileController }): React.JSX.Element {
  const t = useT()
  const { preview } = profile
  if (!preview) throw new Error('Provider Profile preview is required')
  return (
    <section className="provider-profile-preview" aria-label={t('providerProfilePreviewTitle')}>
      <div className="provider-profile-preview-head">
        <div>
          <h4>{t('providerProfilePreviewTitle')}</h4>
          <p>{preview.fileName} · {t('providerProfilePreviewCounts', profile.selectedCounts)}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" disabled={profile.busy === 'apply'} onClick={profile.closePreview}>
          {t('cancel')}
        </button>
      </div>
      {preview.warnings.map((warning) => (
        <div key={warning} className="provider-profile-warning">{warning}</div>
      ))}
      <div className="provider-profile-import-list">
        {preview.items.map((item) => (
          <div key={item.id} className="provider-profile-import-row">
            <div className="provider-profile-import-copy">
              <strong>{item.name}</strong>
              <span>{t('providerProfileProtocol', { protocol: providerProtocolLabel(item) })}</span>
              <span>
                {t('providerAuthModeLabel')}: {t(item.authMode === 'none' ? 'providerAuthModeNone' : 'providerAuthModeApiKey')}
              </span>
              <span>{item.baseUrl || t('officialEndpoint')}</span>
              <span>{profileConflictLabel(item.conflict, item.targetProviderName, t)}</span>
              <ProviderCredentialImpact
                item={item}
                action={profile.decisions[item.id] ?? item.defaultAction}
              />
              {item.changedFields.length > 0 && (
                <span>{t('providerProfileChangedFields', { fields: item.changedFields.join(', ') })}</span>
              )}
            </div>
            <select
              className="select provider-profile-action-select"
              aria-label={t('providerProfileActionFor', { name: item.name })}
              value={profile.decisions[item.id] ?? item.defaultAction}
              disabled={profile.busy === 'apply'}
              onChange={(event) => profile.setDecisions((current) => ({
                ...current,
                [item.id]: event.target.value as ProviderProfileImportAction
              }))}
            >
              {item.allowedActions.map((action) => (
                <option key={action} value={action}>{t(`providerProfileAction_${action}`)}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <div className="provider-profile-preview-footer">
        <span>{t('providerProfileBackupBeforeApply')}</span>
        <button
          className="btn btn-primary btn-sm"
          disabled={profile.busy === 'apply' || profile.selectedCounts.create + profile.selectedCounts.update === 0}
          onClick={() => void profile.applyImport()}
        >
          {profile.busy === 'apply' ? t('providerProfileApplying') : t('providerProfileApply')}
        </button>
      </div>
    </section>
  )
}

function ProviderCredentialImpact({
  item,
  action
}: {
  item: ProviderProfileImportPreview['items'][number]
  action: ProviderProfileImportAction
}): React.JSX.Element {
  const t = useT()
  const impact = providerCredentialImpact(item, action, t)
  return (
    <span className={impact.warning ? 'provider-profile-credential-warning' : undefined}>
      {impact.text}
    </span>
  )
}

function providerCredentialImpact(
  item: ProviderProfileImportPreview['items'][number],
  action: ProviderProfileImportAction,
  t: ReturnType<typeof useT>
): { text: string; warning: boolean } {
  if (action === 'skip') return { text: t('providerProfileCredentialSkipped'), warning: false }
  if (action === 'create') {
    return item.authMode === 'none'
      ? { text: t('providerProfileCredentialNone'), warning: false }
      : { text: t('providerProfileCredentialMissing'), warning: true }
  }
  const keyCount = item.targetKeyCount ?? 0
  const keyLabel = item.targetActiveKeyLabel || t('providerProfileCredentialUnnamed')
  if (item.authMode === 'none') {
    return keyCount > 0
      ? { text: t('providerProfileCredentialRemoved', { label: keyLabel, n: keyCount }), warning: true }
      : { text: t('providerProfileCredentialNone'), warning: false }
  }
  if (keyCount === 0) return { text: t('providerProfileCredentialMissing'), warning: true }
  if (item.targetCredentialBindingChanged || item.targetCredentialMigrationRequired) {
    return { text: t('providerProfileCredentialReentry', { label: keyLabel, n: keyCount }), warning: true }
  }
  return { text: t('providerProfileCredentialPreserved', { label: keyLabel, n: keyCount }), warning: false }
}

function ProviderProfileBackups({ profile }: { profile: ProfileController }): React.JSX.Element {
  const t = useT()
  return (
    <section className="provider-profile-backups" aria-label={t('providerProfileBackupsTitle')}>
      <h4>{t('providerProfileBackupsTitle')}</h4>
      {profile.backups.map((backup) => (
        <div key={backup.id} className="provider-profile-backup-row">
          <div>
            <strong>{formattedTime(backup.createdAt)}</strong>
            <span>{t('providerProfileBackupSummary', { n: backup.providerCount })} · {backupReasonLabel(backup.reason, t)}</span>
            {backup.nonPersistentCredentialCount > 0 && (
              <span className="provider-profile-warning">
                {t('providerProfileSessionKeyWarning', { n: backup.nonPersistentCredentialCount })}
              </span>
            )}
            {backup.excludedCredentialCount > 0 && (
              <span className="provider-profile-warning">
                {t('providerProfileCredentialReentryWarning', { n: backup.excludedCredentialCount })}
              </span>
            )}
          </div>
          <button className="btn btn-ghost btn-sm" disabled={Boolean(profile.busy)} onClick={() => void profile.previewBackup(backup)}>
            {t('providerProfilePreviewVersion')}
          </button>
          <button
            className="btn btn-icon btn-sm"
            aria-label={t('providerProfileBackupDelete')}
            title={t('providerProfileBackupDelete')}
            disabled={Boolean(profile.busy)}
            onClick={() => void profile.deleteBackup(backup)}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
    </section>
  )
}

function ProviderProfileBackupPreviewPanel({ profile }: { profile: ProfileController }): React.JSX.Element {
  const t = useT()
  const preview = profile.backupPreview
  if (!preview) return <></>
  return (
    <section className="provider-profile-preview provider-profile-version-preview" aria-label={t('providerProfileVersionPreviewTitle')}>
      <div className="provider-profile-preview-head">
        <div>
          <h4>{t('providerProfileVersionPreviewTitle')}</h4>
          <p>{formattedTime(preview.backup.createdAt)} · {t('providerProfileVersionCounts', {
            create: preview.createCount,
            update: preview.updateCount,
            delete: preview.deleteCount,
            unchanged: preview.unchangedCount
          })}</p>
        </div>
        <button className="btn btn-icon btn-sm" aria-label={t('close')} onClick={profile.closeBackupPreview}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="provider-profile-version-list">
        {preview.items.map((item) => (
          <div className="provider-profile-version-row" key={`${item.action}-${item.id}`}>
            <strong>{item.providerName}</strong>
            <span>{t(`providerProfileVersionAction_${item.action}`)}</span>
            {item.changedFields.length > 0 && (
              <span>{t('providerProfileChangedFields', { fields: item.changedFields.join(', ') })}</span>
            )}
          </div>
        ))}
      </div>
      {preview.credentialReentryCount > 0 && (
        <p className="provider-profile-warning">
          {t('providerProfileCredentialReentryWarning', { n: preview.credentialReentryCount })}
        </p>
      )}
      <div className="provider-profile-preview-footer">
        <span>{t('providerProfileVersionDriftHint')}</span>
        <button className="btn btn-primary btn-sm" disabled={Boolean(profile.busy)} onClick={() => void profile.rollback()}>
          <RotateCcw size={14} aria-hidden="true" />
          {profile.busy === 'rollback' ? t('providerProfileRollingBack') : t('providerProfileRollback')}
        </button>
      </div>
    </section>
  )
}

function backupReasonLabel(reason: ProviderProfileBackupView['reason'], t: ReturnType<typeof useT>): string {
  return t(`providerProfileBackupReason_${reason}`)
}

function importActionCounts(
  preview: ProviderProfileImportPreview | null,
  decisions: Record<string, ProviderProfileImportAction>
): Record<ProviderProfileImportAction, number> {
  const counts = { create: 0, update: 0, skip: 0 }
  for (const item of preview?.items ?? []) counts[decisions[item.id] ?? item.defaultAction] += 1
  return counts
}

function profileConflictLabel(
  conflict: ProviderProfileImportPreview['items'][number]['conflict'],
  targetName: string | undefined,
  t: ReturnType<typeof useT>
): string {
  if (conflict === 'none') return t('providerProfileConflictNone')
  if (conflict === 'ambiguous') return t('providerProfileConflictAmbiguous')
  return t(`providerProfileConflict_${conflict}`, { target: targetName ?? '-' })
}

function providerProtocolLabel(item: ProviderProfileImportPreview['items'][number]): string {
  if (item.engine === 'anthropic') return 'Anthropic Messages'
  if (item.engine === 'gemini') return 'Google Generative Language'
  return item.openaiProtocol === 'responses' ? 'OpenAI Responses' : 'OpenAI Chat Completions'
}

function formattedTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
