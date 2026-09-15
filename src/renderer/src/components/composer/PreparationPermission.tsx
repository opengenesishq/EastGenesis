import { useEffect, useRef, useState } from 'react'
import type { PreparationPermissionView } from '../../../../shared/preparation-permission-types'
import { useStore } from '../../store'
import './preparation-permission.css'

const CHANGED = 'caogen:preparation-permission-changed'

export default function PreparationPermission({ sessionId, running }: {
  sessionId: string; running: boolean
}): React.JSX.Element {
  const zh = useStore((state) => state.settings.language === 'zh')
  const strategy = useStore((state) => state.sessions[sessionId]?.meta.taskStrategy)
  const [permission, setPermission] = useState<PreparationPermissionView>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const current = useRef(sessionId)
  current.current = sessionId
  const view = permission?.sessionId === sessionId ? permission : undefined
  useEffect(() => {
    let active = true
    const refresh = (): void => {
      const request = ++generation.current
      void window.agentDesk.getPreparationPermission(sessionId).then((result) => {
        if (active && generation.current === request) { setPermission(result); setError('') }
      }).catch((cause) => {
        if (active && generation.current === request) setError(errorText(cause))
      })
    }
    const changed = (event: Event): void => {
      if ((event as CustomEvent<string>).detail === sessionId) refresh()
    }
    refresh()
    window.addEventListener(CHANGED, changed)
    return () => { active = false; generation.current++; window.removeEventListener(CHANGED, changed) }
  }, [sessionId, running])
  const mutate = async (): Promise<void> => {
    if (!view || busy) return
    setBusy(true); setError('')
    try {
      const options = { expectedRevision: view.revision }
      const result = view.status === 'granted'
        ? await window.agentDesk.revokePreparationPermission(sessionId, options)
        : await window.agentDesk.grantPreparationPermission(sessionId, options)
      if (current.current === sessionId) setPermission(result)
      window.dispatchEvent(new CustomEvent(CHANGED, { detail: sessionId }))
    } catch (cause) {
      if (current.current === sessionId) setError(errorText(cause))
    } finally { if (current.current === sessionId) setBusy(false) }
  }
  return <details className="preparation-permission" data-preparation-session={sessionId} data-preparation-status={view?.status ?? 'loading'}>
    <summary>{zh ? '文件准备区' : 'File preparation area'} · {view?.status === 'granted'
      ? (zh ? '已开启' : 'Enabled') : view?.status === 'revoked' ? (zh ? '已撤权' : 'Revoked') : (zh ? '未开启' : 'Not enabled')}</summary>
    <p>{zh ? '允许在当前任务的独立目录起草文件。修改项目文件、运行命令和对外操作仍遵循任务授权。'
      : 'Draft files in a directory for this task. Project edits, commands, and external actions follow the task’s authorization.'}</p>
    {view?.directory && <code className="preparation-directory">{view.directory}</code>}
    {view?.unavailableReason && <p>{view.unavailableReason}</p>}
    <button type="button" className="btn btn-ghost btn-sm" disabled={!view || busy || (view.status !== 'granted' && (strategy === 'view' || running))}
      onClick={() => void mutate()}>{view?.status === 'granted' ? (zh ? '撤销准备权限' : 'Revoke preparation access')
        : (zh ? '允许起草文件' : 'Allow file preparation')}</button>
    {error && <p role="alert">{error}</p>}
  </details>
}

function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
