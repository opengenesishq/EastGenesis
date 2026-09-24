import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent
} from 'react'
import type {
  ProjectAggregateExportBundle,
  ProviderAuthorizationAccountView,
  ProjectResourceInput,
  ProjectWorkspace,
  ProjectWorkspacePatch
} from '../../../../shared/types'
import { PROJECT_CONNECTOR_CATALOG } from '../../../../shared/types'
import { useStore } from '../../store'
import {
  PROJECT_KIND_OPTIONS,
  PROJECT_RESOURCE_OPTIONS,
  RESOURCE_DATA_CLASS_OPTIONS,
  RESOURCE_EGRESS_OPTIONS,
  TEXT,
  projectEditDraft,
  resourceInputFromDraft,
  type ProjectResourceDraft
} from './projectWorkspaceStudioModel'

export function ProjectEditForm({
  busy,
  onCancel,
  onSubmit,
  project
}: {
  busy: boolean
  onCancel: () => void
  onSubmit: (patch: ProjectWorkspacePatch) => Promise<void>
  project: ProjectWorkspace
}): React.JSX.Element {
  const baseId = useId()
  const [draft, setDraft] = useState(() => projectEditDraft(project))
  const update = <K extends keyof typeof draft>(field: K, value: typeof draft[K]): void => {
    setDraft((current) => ({ ...current, [field]: value }))
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void onSubmit({
      name: draft.name.trim(),
      kind: draft.kind,
      ownerId: draft.ownerId.trim(),
      rulesRef: draft.rulesRef.trim(),
      primaryResourceId: draft.primaryResourceId || null
    })
  }
  return (
    <form className="pws-create-form pws-lifecycle-form" aria-labelledby={`${baseId}-title`} onSubmit={submit} onKeyDown={(event) => closeOnEscape(event, onCancel)} data-project-form="edit">
      <LifecycleFormHeader id={`${baseId}-title`} title={TEXT.editProject} disabled={busy} onCancel={onCancel} />
      <fieldset className="pws-fieldset" disabled={busy}>
        <div className="pws-form-grid pws-form-grid-2">
          <LifecycleField id={`${baseId}-name`} label={TEXT.projectName}>
            <input id={`${baseId}-name`} name="projectName" className="input" value={draft.name} onChange={(event) => update('name', event.target.value)} required autoFocus />
          </LifecycleField>
          <LifecycleField id={`${baseId}-kind`} label={TEXT.projectKind}>
            <select id={`${baseId}-kind`} name="projectKind" className="select select-block" value={draft.kind} onChange={(event) => update('kind', event.target.value as typeof draft.kind)}>
              {PROJECT_KIND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </LifecycleField>
          <LifecycleField id={`${baseId}-owner`} label={TEXT.ownerIdOptional}>
            <input id={`${baseId}-owner`} name="projectOwnerId" className="input" value={draft.ownerId} onChange={(event) => update('ownerId', event.target.value)} />
          </LifecycleField>
          <LifecycleField id={`${baseId}-rules`} label={TEXT.rulesRefOptional}>
            <input id={`${baseId}-rules`} name="projectRulesRef" className="input" value={draft.rulesRef} onChange={(event) => update('rulesRef', event.target.value)} />
          </LifecycleField>
        </div>
        <LifecycleField id={`${baseId}-primary`} label="新任务的主文件夹">
          <select id={`${baseId}-primary`} className="select select-block" data-project-primary-resource value={draft.primaryResourceId} onChange={event => update('primaryResourceId', event.target.value)}>
            <option value="">自动选择可用文件夹</option>
            {project.resources.filter(resource => ['directory', 'repository'].includes(resource.kind) && resource.path).map(resource =>
              <option key={resource.id} value={resource.id}>{resource.label ? `${resource.label} · ` : ''}{resource.path}</option>)}
          </select>
        </LifecycleField>
        <p className="pws-muted">新任务从此文件夹开始。已有任务保留原工作目录；其他文件夹通过“添加资源”管理。</p>
        <LifecycleFormActions busy={busy} submitLabel={TEXT.saveProject} onCancel={onCancel} />
      </fieldset>
    </form>
  )
}

export function ProjectResourceForm({
  busy,
  onCancel,
  onSubmit
}: {
  busy: boolean
  onCancel: () => void
  onSubmit: (input: ProjectResourceInput) => Promise<void>
}): React.JSX.Element {
  const baseId = useId()
  const [draft, setDraft] = useState<ProjectResourceDraft>({
    kind: 'directory',
    label: '',
    location: '',
    dataClass: 'S2',
    egressPolicy: 'allow',
    connectorUsage: ['resource'],
    connectorId: 'generic',
    connectorCapabilities: 'resource:read',
    connectorDataDirection: 'read',
    connectorAuthorizationSubject: 'personal',
    connectorPrincipalId: '',
    connectorCredentialRef: '',
    connectorScopes: 'read',
    connectorVersion: '1',
    connectorReconciliation: 'manual_only'
  })
  const update = <K extends keyof ProjectResourceDraft>(field: K, value: ProjectResourceDraft[K]): void => {
    setDraft((current) => ({ ...current, [field]: value }))
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void onSubmit(resourceInputFromDraft(draft))
  }
  return (
    <form className="pws-create-form pws-lifecycle-form" aria-labelledby={`${baseId}-title`} onSubmit={submit} onKeyDown={(event) => closeOnEscape(event, onCancel)} data-project-form="resource">
      <LifecycleFormHeader id={`${baseId}-title`} title={TEXT.addResource} disabled={busy} onCancel={onCancel} />
      <fieldset className="pws-fieldset" disabled={busy}>
        <div className="pws-form-grid pws-form-grid-3">
          <LifecycleField id={`${baseId}-kind`} label={TEXT.resourceKind}>
            <select
              id={`${baseId}-kind`}
              name="resourceKind"
              className="select select-block"
              value={draft.kind}
              onChange={(event) => {
                const kind = event.target.value as ProjectResourceDraft['kind']
                setDraft((current) => ({ ...current, kind, ...(kind === 'connector' ? { dataClass: 'S1' as const } : {}) }))
              }}
            >
              {PROJECT_RESOURCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </LifecycleField>
          {draft.kind === 'connector' && <ProjectConnectorFields baseId={baseId} draft={draft} update={update} />}
          <LifecycleField id={`${baseId}-label`} label={TEXT.resourceLabel}>
            <input id={`${baseId}-label`} name="resourceLabel" className="input" value={draft.label} onChange={(event) => update('label', event.target.value)} autoFocus />
          </LifecycleField>
          <LifecycleField id={`${baseId}-location`} label={TEXT.resourceLocation}>
            <input id={`${baseId}-location`} name="resourceLocation" className="input" value={draft.location} onChange={(event) => update('location', event.target.value)} required />
          </LifecycleField>
          <LifecycleField id={`${baseId}-data-class`} label={TEXT.resourceDataClass}>
            <select
              id={`${baseId}-data-class`}
              name="resourceDataClass"
              className="select select-block"
              value={draft.dataClass}
              onChange={(event) => {
                const dataClass = event.target.value as ProjectResourceDraft['dataClass']
                setDraft((current) => ({
                  ...current,
                  dataClass,
                  ...(dataClass === 'S3' ? { egressPolicy: 'deny' as const } : {})
                }))
              }}
              data-resource-data-class
            >
              {RESOURCE_DATA_CLASS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </LifecycleField>
          <LifecycleField id={`${baseId}-egress`} label={TEXT.resourceEgressPolicy}>
            <select
              id={`${baseId}-egress`}
              name="resourceEgressPolicy"
              className="select select-block"
              value={draft.dataClass === 'S3' ? 'deny' : draft.egressPolicy}
              onChange={(event) => update('egressPolicy', event.target.value as ProjectResourceDraft['egressPolicy'])}
              disabled={draft.dataClass === 'S3'}
              data-resource-egress-policy
            >
              {RESOURCE_EGRESS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </LifecycleField>
        </div>
        <LifecycleFormActions busy={busy} submitLabel={TEXT.addResourceSubmit} onCancel={onCancel} />
      </fieldset>
    </form>
  )
}

type ProjectResourceDraftUpdater = <K extends keyof ProjectResourceDraft>(
  field: K,
  value: ProjectResourceDraft[K]
) => void

function ProjectConnectorFields({
  baseId,
  draft,
  update
}: {
  baseId: string
  draft: ProjectResourceDraft
  update: ProjectResourceDraftUpdater
}): React.JSX.Element {
  const [authorizationAccounts, setAuthorizationAccounts] = useState<Array<{ providerId: string; account: ProviderAuthorizationAccountView }>>([])
  useEffect(() => {
    let cancelled = false
    void window.agentDesk.listProviders()
      .then(async (providers) => {
        const entries = await Promise.all(providers.map(async (provider) => {
          try {
            const accounts = await window.agentDesk.listProviderAuthorizationAccounts(provider.id)
            return accounts.map((account) => ({ providerId: provider.id, account }))
          } catch {
            return []
          }
        }))
        if (!cancelled) setAuthorizationAccounts(entries.flat())
      })
      .catch(() => {
        if (!cancelled) setAuthorizationAccounts([])
      })
    return () => { cancelled = true }
  }, [])
  const selectedAccountValue = authorizationAccounts.find(({ providerId, account }) =>
    draft.connectorCredentialRef === `oauth:${providerId}/${account.id}`)
  return (
    <>
      <LifecycleField id={`${baseId}-connector-catalog`} label={localized('连接器目录', 'Connector catalog')}>
        <select
          id={`${baseId}-connector-catalog`}
          name="connectorCatalog"
          className="select select-block"
          value={draft.connectorId}
          onChange={(event) => {
            const entry = PROJECT_CONNECTOR_CATALOG.find((candidate) => candidate.id === event.target.value) ?? PROJECT_CONNECTOR_CATALOG[PROJECT_CONNECTOR_CATALOG.length - 1]
            updateConnectorFromCatalog(entry, update)
          }}
        >
          {PROJECT_CONNECTOR_CATALOG.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </LifecycleField>
      <LifecycleField id={`${baseId}-connector-usage`} label={localized('用途', 'Usage')}>
        <select
          id={`${baseId}-connector-usage`}
          className="select select-block"
          value={draft.connectorUsage[0] ?? 'resource'}
          onChange={(event) => update('connectorUsage', [event.target.value as ProjectResourceDraft['connectorUsage'][number]])}
        >
          <option value="resource">Project Resource</option>
          <option value="knowledge_source">{localized('知识源', 'Knowledge source')}</option>
          <option value="tool">Tool</option>
        </select>
      </LifecycleField>
      <LifecycleField id={`${baseId}-connector-direction`} label={localized('数据方向', 'Data direction')}>
        <select id={`${baseId}-connector-direction`} className="select select-block" value={draft.connectorDataDirection} onChange={(event) => update('connectorDataDirection', event.target.value as ProjectResourceDraft['connectorDataDirection'])}>
          <option value="read">{localized('只读', 'Read only')}</option>
          <option value="write">{localized('只写', 'Write only')}</option>
          <option value="bidirectional">{localized('双向', 'Bidirectional')}</option>
        </select>
      </LifecycleField>
      <LifecycleField id={`${baseId}-connector-capabilities`} label={localized('能力清单（逗号分隔）', 'Capabilities (comma-separated)')}>
        <input id={`${baseId}-connector-capabilities`} className="input" value={draft.connectorCapabilities} onChange={(event) => update('connectorCapabilities', event.target.value)} required />
      </LifecycleField>
      <LifecycleField id={`${baseId}-connector-subject`} label={localized('授权主体', 'Authorization subject')}>
        <select id={`${baseId}-connector-subject`} className="select select-block" value={draft.connectorAuthorizationSubject} onChange={(event) => update('connectorAuthorizationSubject', event.target.value as ProjectResourceDraft['connectorAuthorizationSubject'])}>
          <option value="personal">{localized('个人授权', 'Personal authorization')}</option>
          <option value="shared">{localized('共享授权', 'Shared authorization')}</option>
        </select>
      </LifecycleField>
      <LifecycleField id={`${baseId}-connector-account`} label={localized('已授权账户', 'Authorized account')}>
        <select
          id={`${baseId}-connector-account`}
          className="select select-block"
          value={selectedAccountValue ? `${selectedAccountValue.providerId}/${selectedAccountValue.account.id}` : ''}
          onChange={(event) => {
            const [providerId, accountId] = event.target.value.split('/', 2)
            const selected = authorizationAccounts.find(({ providerId: candidateProviderId, account }) => candidateProviderId === providerId && account.id === accountId)
            if (!selected) return
            update('connectorPrincipalId', selected.account.id)
            update('connectorCredentialRef', `oauth:${selected.providerId}/${selected.account.id}`)
          }}
        >
          <option value="">{localized('手动填写账户或普通 Provider 凭据', 'Enter an account or standard Provider credential manually')}</option>
          {authorizationAccounts.map(({ providerId, account }) => (
            <option key={`${providerId}/${account.id}`} value={`${providerId}/${account.id}`} disabled={account.requiresReauth}>
              {account.label} · {providerId}{account.requiresReauth ? localized(' · 需要重新授权', ' · Reauthorization required') : ''}
            </option>
          ))}
        </select>
      </LifecycleField>
      <LifecycleField id={`${baseId}-connector-principal`} label={localized('授权账户/组织 ID', 'Authorized account or organization ID')}>
        <input id={`${baseId}-connector-principal`} className="input" value={draft.connectorPrincipalId} onChange={(event) => update('connectorPrincipalId', event.target.value)} required />
      </LifecycleField>
      <LifecycleField id={`${baseId}-connector-credential`} label={localized('凭据引用（不填入令牌）', 'Credential reference (do not enter tokens)')}>
        <input id={`${baseId}-connector-credential`} className="input" value={draft.connectorCredentialRef} onChange={(event) => update('connectorCredentialRef', event.target.value)} placeholder="credential://..." />
      </LifecycleField>
      <LifecycleField id={`${baseId}-connector-scopes`} label={localized('授权作用域（逗号分隔）', 'Authorization scopes (comma-separated)')}>
        <input id={`${baseId}-connector-scopes`} className="input" value={draft.connectorScopes} onChange={(event) => update('connectorScopes', event.target.value)} required />
      </LifecycleField>
      <LifecycleField id={`${baseId}-connector-version`} label={localized('连接器版本', 'Connector version')}>
        <input id={`${baseId}-connector-version`} className="input" value={draft.connectorVersion} onChange={(event) => update('connectorVersion', event.target.value)} required />
      </LifecycleField>
      <LifecycleField id={`${baseId}-connector-reconciliation`} label={localized('写操作对账', 'Write reconciliation')}>
        <select id={`${baseId}-connector-reconciliation`} className="select select-block" value={draft.connectorReconciliation} onChange={(event) => update('connectorReconciliation', event.target.value as ProjectResourceDraft['connectorReconciliation'])}>
          <option value="queryable">{localized('可查询对账', 'Queryable reconciliation')}</option>
          <option value="manual_only">{localized('不透明/仅手动确认', 'Opaque / manual confirmation only')}</option>
        </select>
      </LifecycleField>
    </>
  )
}

function updateConnectorFromCatalog(
  entry: (typeof PROJECT_CONNECTOR_CATALOG)[number],
  update: ProjectResourceDraftUpdater
): void {
  update('connectorId', entry.id)
  update('location', entry.defaultUri)
  update('connectorUsage', [...entry.usage])
  update('connectorCapabilities', entry.capabilities.join(', '))
  update('connectorDataDirection', entry.dataDirection)
  update('connectorScopes', entry.scopes.join(', '))
  update('connectorVersion', entry.version)
  update('connectorReconciliation', entry.reconciliation)
}

export function ProjectDeleteDialog({
  busy,
  onCancel,
  onConfirm,
  permanent,
  project
}: {
  busy: boolean
  onCancel: () => void
  onConfirm: () => Promise<void>
  permanent: boolean
  project: ProjectWorkspace
}): React.JSX.Element {
  const dialogRef = useModalDialog(onCancel)
  const titleId = useId()
  const descriptionId = useId()
  const inputId = useId()
  const [confirmation, setConfirmation] = useState('')
  const confirmed = confirmation === project.name
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (confirmed && !busy) void onConfirm()
  }
  return (
    <dialog ref={dialogRef} className="pws-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} aria-modal="true" data-project-delete-dialog={permanent ? 'permanent' : 'soft'}>
      <form onSubmit={submit}>
        <h2 id={titleId}>{permanent ? TEXT.purgeProjectTitle : TEXT.deleteProjectTitle}</h2>
        <p id={descriptionId}>{permanent ? TEXT.purgeProjectHint : TEXT.deleteProjectHint}</p>
        <label htmlFor={inputId}>{TEXT.confirmProjectName(project.name)}</label>
        <input id={inputId} name="projectDeleteConfirmation" className="input" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" autoFocus />
        <div className="pws-form-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>{TEXT.cancel}</button>
          <button type="submit" className="btn btn-danger" disabled={!confirmed || busy} data-project-delete-confirm>
            {permanent ? TEXT.confirmPurge : TEXT.confirmDelete}
          </button>
        </div>
      </form>
    </dialog>
  )
}

export function ProjectManifestDialog({
  manifest,
  onClose,
  onCopy,
  projectName
}: {
  manifest: ProjectAggregateExportBundle
  onClose: () => void
  onCopy: () => Promise<void>
  projectName: string
}): React.JSX.Element {
  const dialogRef = useModalDialog(onClose)
  const titleId = useId()
  const json = JSON.stringify(manifest, null, 2)
  return (
    <dialog ref={dialogRef} className="pws-dialog pws-manifest-dialog" aria-labelledby={titleId} aria-modal="true" data-project-manifest>
      <h2 id={titleId}>{TEXT.manifestTitle}</h2>
      <div className="pws-manifest-digest">
        <span>{TEXT.manifestDigest}</span>
        <output data-manifest-digest>{manifest.exportDigest}</output>
      </div>
      <textarea className="input pws-manifest-json" aria-label={TEXT.manifestTitle} readOnly value={json} data-manifest-json />
      <div className="pws-form-actions">
        <button type="button" className="btn btn-ghost" onClick={() => void onCopy()}>{TEXT.copyManifest}</button>
        <button type="button" className="btn btn-ghost" onClick={() => downloadManifest(projectName, json)}>{TEXT.downloadManifest}</button>
        <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>{TEXT.closeManifest}</button>
      </div>
    </dialog>
  )
}

function LifecycleFormHeader({ id, title, disabled, onCancel }: { id: string; title: string; disabled: boolean; onCancel: () => void }): React.JSX.Element {
  return (
    <div className="pws-form-header">
      <h3 id={id}>{title}</h3>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={disabled} aria-label={TEXT.closeForm}>{TEXT.cancel}</button>
    </div>
  )
}

function LifecycleFormActions({ busy, submitLabel, onCancel }: { busy: boolean; submitLabel: string; onCancel: () => void }): React.JSX.Element {
  return (
    <div className="pws-form-actions">
      <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>{TEXT.cancel}</button>
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? TEXT.creating : submitLabel}</button>
    </div>
  )
}

function LifecycleField({ id, label, children }: { id: string; label: string; children: React.ReactNode }): React.JSX.Element {
  return <div className="pws-field"><label htmlFor={id}>{label}</label>{children}</div>
}

function useModalDialog(onCancel: () => void) {
  const dialogRef = useRef<HTMLDialogElement>(null!)
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const cancel = (event: Event): void => {
      event.preventDefault()
      onCancel()
    }
    dialog.addEventListener('cancel', cancel)
    return () => dialog.removeEventListener('cancel', cancel)
  }, [onCancel])
  return dialogRef
}

function closeOnEscape(event: KeyboardEvent<HTMLFormElement>, onCancel: () => void): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  onCancel()
}

function localized(chinese: string, english: string): string {
  return useStore.getState().settings.language === 'en' ? english : chinese
}

function downloadManifest(projectName: string, json: string): void {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${projectName.replace(/[^a-z0-9_-]+/gi, '-') || 'project'}-export.json`
  link.click()
  URL.revokeObjectURL(url)
}
