import { useCallback, useEffect, useState } from 'react'
import type { RemoteWelcomeDraft } from '../../../../shared/task-window-types'
import { useStore } from '../../store'
import { emptyWelcomeDraft, type WelcomeDraftState } from '../../store/welcome-draft'
import { loadWelcomeDraft, persistWelcomeDraftStrict, WELCOME_DRAFT_SCHEMA_VERSION } from '../../store/welcome-draft-persistence'
import { remoteConnection, remoteTarget, sameRemoteConnection } from './welcome-remote-target'
import { useRemoteTaskNavigation } from '../../store/remote-task-navigation'

const SAVED = 'caogen.remote-welcome.saved-drafts.v1', ADOPTED = 'caogen.remote-welcome.adopted.v1'
interface SavedDraft { id: string; at: number; draft: WelcomeDraftState }
function savedDrafts(): SavedDraft[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SAVED) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, 21).flatMap(row => {
      if (!row || typeof row.id !== 'string' || !Number.isSafeInteger(row.at)) return []
      const draft = loadWelcomeDraft(emptyWelcomeDraft(), { getItem: () => JSON.stringify({ schemaVersion: WELCOME_DRAFT_SCHEMA_VERSION, draft: row.draft }), setItem() {}, removeItem() {} } as unknown as Storage)
      return [{ id: row.id, at: row.at, draft }]
    })
  } catch { return [] }
}
function preserveCurrent(): void {
  const current = useStore.getState().welcomeDraft
  if (!current.text && !current.forkFromSdkSessionId) return
  const saved = savedDrafts()
  if (saved.length >= 20) throw new Error('已保存草稿达到 20 份，请先恢复并处理现有草稿。')
  writeSaved([...saved, { id: crypto.randomUUID(), at: Date.now(), draft: current }])
}
function writeSaved(items: SavedDraft[]): void {
  const serialized = JSON.stringify(items)
  localStorage.setItem(SAVED, serialized)
  if (localStorage.getItem(SAVED) !== serialized) throw new Error('无法保存原草稿，当前内容未替换。')
}
export default function WelcomeRemoteDraftInbox(): React.JSX.Element | null {
  const zh = useStore(state => state.settings.language === 'zh'), currentText = useStore(state => state.welcomeDraft.text)
  const [incoming, setIncoming] = useState<RemoteWelcomeDraft[]>([]), [saved, setSaved] = useState<SavedDraft[]>(savedDrafts), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const refresh = useCallback(async () => { setIncoming(await window.agentDesk.listRemoteWelcomeDrafts()); setSaved(savedDrafts()) }, [])
  useEffect(() => { let alive = true; const load = () => { void window.agentDesk.listRemoteWelcomeDrafts().then(rows => { if (alive) setIncoming(rows) }).catch(() => { if (alive) setError(zh ? '草稿收件列表暂不可用。' : 'Draft inbox unavailable.') }) }; load(); const stop = window.agentDesk.onRemoteWelcomeDraftsChanged(load); return () => { alive = false; stop() } }, [zh])
  const adopt = async (item: RemoteWelcomeDraft): Promise<void> => {
    setBusy(true); setError('')
    try {
      const already = JSON.parse(localStorage.getItem(ADOPTED) ?? '[]') as string[]
      if (!already.includes(item.requestId)) {
        const listed = await window.agentDesk.listRemoteHosts(), host = listed.hosts.find(row => row.id === item.hostId)
        if (!host) throw new Error('原连接不可用，交接草稿仍在收件列表。')
        const target = remoteTarget(host)
        if (!sameRemoteConnection(remoteConnection(target), item.expectedConnection)) throw new Error('原连接身份发生变化，请先核对。')
        preserveCurrent()
        useStore.getState().updateWelcomeDraft({ text: item.text, executionTarget: target, forkFromSdkSessionId: undefined, forkCheckpointId: undefined, forkSourceTitle: undefined })
        persistWelcomeDraftStrict(useStore.getState().welcomeDraft)
        localStorage.setItem(ADOPTED, JSON.stringify([...already, item.requestId].slice(-200)))
      }
      await window.agentDesk.acknowledgeRemoteWelcomeDraft(item.requestId)
      useRemoteTaskNavigation.getState().close(); useStore.getState().setShowNewSession(true)
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Draft adoption unconfirmed'); setSaved(savedDrafts()) }
    finally { setBusy(false) }
  }
  if (!incoming.length && !saved.length && !error) return null
  return <aside className="remote-draft-inbox" data-remote-draft-inbox>
    {incoming.map(item => <article key={item.requestId}><strong>{zh ? '独立窗口交来的远端草稿' : 'Remote draft from a task window'}</strong><p>{item.text.slice(0, 180)}{item.text.length > 180 ? '…' : ''}</p><button data-remote-draft-adopt disabled={busy} onClick={() => void adopt(item)}>{currentText ? zh ? '保留当前草稿并采用' : 'Save current draft and adopt' : zh ? '采用到新任务输入框' : 'Use in new task composer'}</button></article>)}
    {!!saved.length && <details><summary>{zh ? `保留的草稿（${saved.length}）` : `Saved drafts (${saved.length})`}</summary>{saved.map(item => <article key={item.id}><span>{new Date(item.at).toLocaleString()} · {item.draft.text.slice(0, 120)}</span><button disabled={busy} onClick={() => {
      try {
        // Build one durable replacement before changing the visible draft. Keep
        // the selected backup until the restored draft itself passes readback.
        const current = useStore.getState().welcomeDraft
        const remaining = savedDrafts().filter(row => row.id !== item.id)
        const preserved = current.text || current.forkFromSdkSessionId ? { id: crypto.randomUUID(), at: Date.now(), draft: current } : undefined
        const nextSaved = [...remaining, ...(preserved ? [preserved] : [])]
        writeSaved([...nextSaved, item])
        const refs = [...new Map([...(current.remoteIntakes ?? []), ...(item.draft.remoteIntakes ?? [])].map(row => [row.requestId, row])).values()]
        useRemoteTaskNavigation.getState().close(); useStore.getState().setShowNewSession(true)
        useStore.getState().updateWelcomeDraft({ ...item.draft, remoteIntakes: refs })
        persistWelcomeDraftStrict(useStore.getState().welcomeDraft)
        writeSaved(nextSaved)
        setSaved(savedDrafts())
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Cannot restore draft') }
    }}>{zh ? '保留当前内容并恢复' : 'Keep current draft and restore'}</button></article>)}</details>}
    {error && <p role="alert">{error}</p>}
  </aside>
}
