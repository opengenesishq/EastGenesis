import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToolCapabilityGrantView } from '../../../../shared/types'
import { useStore } from '../../store'

type TemporaryGrant = ToolCapabilityGrantView
const CHANGED = 'caogen:task-temporary-permissions-changed'

async function taskGrants(sessionId: string): Promise<TemporaryGrant[]> {
  const tools = await window.agentDesk.listToolCapabilityGrants()
  return tools.filter(grant => grant.sessionId === sessionId && grant.expiresAt > Date.now())
    .sort((left, right) => left.expiresAt - right.expiresAt || left.id.localeCompare(right.id))
}

export default function TaskTemporaryPermissions({ sessionId }: { sessionId: string }): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  // Resolving a permission can issue a grant while the task is still running.
  const pending = useStore(state => state.sessions[sessionId]?.pendingPermissions)
  const [grants, setGrants] = useState<TemporaryGrant[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(false)
  const generation = useRef(0)
  const mutating = useRef(false)
  const currentSession = useRef(sessionId)
  currentSession.current = sessionId

  const refresh = useCallback(async (): Promise<void> => {
    const request = ++generation.current
    try {
      const current = await taskGrants(sessionId)
      if (mounted.current && currentSession.current === sessionId && request === generation.current) {
        setGrants(current); setLoaded(true); setError('')
      }
    } catch (cause) {
      if (mounted.current && currentSession.current === sessionId && request === generation.current) {
        setLoaded(false); setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
  }, [sessionId])

  useEffect(() => {
    mounted.current = true
    setGrants([]); setLoaded(false); setNotice('')
    const changed = (event: Event): void => {
      if ((event as CustomEvent<string>).detail === sessionId) void refresh()
    }
    const focus = (): void => { void refresh() }
    window.addEventListener(CHANGED, changed)
    window.addEventListener('focus', focus)
    return () => {
      mounted.current = false; generation.current++
      window.removeEventListener(CHANGED, changed); window.removeEventListener('focus', focus)
    }
  }, [sessionId, refresh])
  useEffect(() => { void refresh() }, [refresh, pending])
  useEffect(() => {
    if (!grants.length) return
    const timer = window.setTimeout(() => { void refresh() }, Math.max(0, grants[0].expiresAt - Date.now()) + 50)
    return () => window.clearTimeout(timer)
  }, [grants, refresh])

  const revoke = async (selected?: TemporaryGrant): Promise<void> => {
    if (mutating.current) return
    mutating.current = true; generation.current++; setBusy(true); setError(''); setNotice('')
    try {
      // Read a fresh task-filtered inventory for "all"; never invoke global revoke-all.
      const targets = selected ? [selected] : await taskGrants(sessionId)
      if (targets.some(grant => grant.sessionId !== sessionId)) throw new Error(zh ? '授权不属于当前任务。' : 'Grant belongs to another task.')
      const results = await Promise.allSettled(targets.map(grant => window.agentDesk.revokeToolCapabilityGrant(grant.id)))
      const failures = results.filter(result => result.status === 'rejected')
      window.dispatchEvent(new CustomEvent(CHANGED, { detail: sessionId }))
      await refresh()
      if (mounted.current && currentSession.current === sessionId) {
        if (failures.length) setError(zh ? '部分临时授权未能撤销，请刷新后重试。' : 'Some grants could not be revoked. Refresh and retry.')
        else setNotice(zh ? '所选临时授权已撤销或到期。后续操作将重新按权限规则判断。' : 'Selected grants were revoked or expired. Future actions will follow the current permission rules.')
      }
    } catch (cause) {
      if (mounted.current && currentSession.current === sessionId) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      mutating.current = false
      if (mounted.current && currentSession.current === sessionId) setBusy(false)
    }
  }

  return <section className="task-temporary-permissions" data-task-temporary-permissions={sessionId} aria-label={zh ? '当前任务临时授权' : 'Temporary access for this task'}>
    <div className="task-temporary-permissions-heading">
      <strong>{zh ? '当前任务临时授权' : 'Temporary access for this task'}{loaded ? ` · ${grants.length}` : ''}</strong>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void refresh()}>{zh ? '刷新' : 'Refresh'}</button>
    </div>
    <p>{zh ? '审批中授予的 5 分钟权限会列在这里。撤销影响后续操作。需要中断任务时可暂停；已发出的外部操作仍需核对结果。' : 'Five-minute grants from approvals appear here. Revocation affects future actions. Pause the task when interruption is needed; external actions already sent still require result verification.'}</p>
    {!loaded && <p>{error ? (zh ? '临时授权状态暂时无法确认，请刷新重试。' : 'Temporary access could not be verified. Refresh to retry.') : (zh ? '正在读取临时授权…' : 'Loading temporary access…')}</p>}
    {loaded && !grants.length && <p>{zh ? '当前没有有效临时授权。' : 'No active temporary grants.'}</p>}
    {grants.length > 0 && <>
      <ul className="task-temporary-permissions-list">{grants.map(grant => <li key={grant.id}>
        <div><strong>{grant.toolName}</strong><span>{grant.scopeLabel}</span>
          <small>{zh ? '到期时间：' : 'Expires: '}<time dateTime={new Date(grant.expiresAt).toISOString()}>{new Date(grant.expiresAt).toLocaleTimeString()}</time></small></div>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void revoke(grant)} aria-label={zh ? `撤销 ${grant.toolName} 临时授权` : `Revoke temporary ${grant.toolName} access`}>{zh ? '撤销' : 'Revoke'}</button>
      </li>)}</ul>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void revoke()}>{zh ? '撤销本任务全部临时授权' : 'Revoke all temporary access for this task'}</button>
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}
