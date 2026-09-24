import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteHostApi, RemoteHostTask, RemoteHostCommandKind } from '../../../../shared/remote-host-types'
import type { RemoteWorkspaceView, RemoteWorkspaceOperation } from '../../../../shared/remote-workspace-types'
import './remote-workspace.css'

export default function RemoteWorkspacePanel({ hostId, hostLabel, task, zh, busy, onCommand, onClose, expectedProjectId, expectedSessionId }: {
  hostId: string; hostLabel: string; task: RemoteHostTask; zh: boolean; busy: boolean
  expectedProjectId?: string; expectedSessionId?: string
  onCommand(kind: RemoteHostCommandKind, task: RemoteHostTask, text?: string): void; onClose(): void
}): React.JSX.Element {
  const api = window.agentDesk as typeof window.agentDesk & RemoteHostApi
  const [workspace, setWorkspace] = useState<RemoteWorkspaceView>(), [listing, setListing] = useState<RemoteWorkspaceView>(), [preview, setPreview] = useState<RemoteWorkspaceView>()
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [instruction, setInstruction] = useState('')
  const [savingPath, setSavingPath] = useState(''), [saveNotice, setSaveNotice] = useState('')
  const generation = useRef(0)
  const open = useCallback(async () => {
    const token = ++generation.current; setLoading(true); setError(''); setSavingPath(''); setSaveNotice(''); setWorkspace(undefined); setListing(undefined); setPreview(undefined)
    try {
      const next = await api.describeRemoteWorkspace(hostId, task.id)
      if (expectedProjectId && next.binding.projectId !== expectedProjectId || expectedSessionId && next.binding.sessionId !== expectedSessionId) throw new Error(zh ? '远端工作区与原任务身份不匹配。' : 'Remote workspace does not match the original task.')
      const files = await api.readRemoteWorkspace({ hostId, binding: next.binding, operation: 'list' })
      if (token !== generation.current) return
      setWorkspace(next); setListing(files)
    } catch (cause) { if (token === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (token === generation.current) setLoading(false) }
  }, [api, hostId, task.id, expectedProjectId, expectedSessionId, zh])
  useEffect(() => { void open(); return () => { generation.current++ } }, [open])
  const read = async (operation: Exclude<RemoteWorkspaceOperation, 'describe'>, path = '.', cursor?: number): Promise<void> => {
    if (!workspace) return
    const token = ++generation.current; setLoading(true); setError('')
    try {
      const next = await api.readRemoteWorkspace({ hostId, binding: workspace.binding, operation, path, cursor })
      if (token !== generation.current) return
      if (operation === 'list') { setListing(next); setPreview(undefined) } else setPreview(next)
    } catch (cause) { if (token === generation.current) { setError(cause instanceof Error ? cause.message : String(cause)); setListing(undefined); setPreview(undefined); setWorkspace(undefined) } }
    finally { if (token === generation.current) setLoading(false) }
  }
  const save = async (path: string): Promise<void> => {
    if (!workspace || loading || busy) return
    const token = ++generation.current; setLoading(true); setSavingPath(path); setSaveNotice(''); setError('')
    try {
      const result = await api.saveRemoteWorkspaceFile({ hostId, binding: workspace.binding, path })
      if (token !== generation.current) return
      setSaveNotice(result.status === 'cancelled' ? (zh ? '已取消另存。' : 'Save cancelled.')
        : zh ? `已保存到 ${result.path}（${result.bytes?.toLocaleString()} 字节）` : `Saved to ${result.path} (${result.bytes?.toLocaleString()} bytes)`)
    } catch (cause) { if (token === generation.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (token === generation.current) { setLoading(false); setSavingPath('') } }
  }
  return <section className="remote-workspace" aria-label={zh ? '远端原任务工作区' : 'Original remote task workspace'}>
    <header><div><strong>{task.title}</strong><small>{hostLabel} · {task.status}</small></div><button onClick={onClose}>{zh ? '关闭工作区' : 'Close workspace'}</button></header>
    <p>{zh ? '文件与 Agent 均在这台远端电脑；以下操作继续原任务。' : 'Files and the Agent stay on this remote computer. These actions continue the original task.'}</p>
    <div className="remote-workspace-toolbar"><button disabled={loading} onClick={() => void open()}>{zh ? '刷新工作区' : 'Refresh workspace'}</button>
      {task.canResume && <button disabled={busy} onClick={() => onCommand('resume_work_item', task)}>{zh ? '继续任务' : 'Resume task'}</button>}
      {task.canPause && <button disabled={busy} onClick={() => onCommand('pause_work_item', task)}>{zh ? '暂停' : 'Pause'}</button>}
      {task.canCancel && <button disabled={busy} onClick={() => onCommand('cancel_work_item', task)}>{zh ? '取消任务' : 'Cancel task'}</button>}
      <button disabled={loading || !workspace} onClick={() => void read('git_status')}>{zh ? 'Git 状态' : 'Git status'}</button><button disabled={loading || !workspace} onClick={() => void read('git_diff')}>{zh ? '代码差异' : 'Git diff'}</button></div>
    {workspace && <small className="remote-workspace-binding">{workspace.binding.canonicalPath}<br />Session: {workspace.binding.sessionId} · WorkItem: {workspace.binding.workItemId}{workspace.binding.runId ? ` · Run: ${workspace.binding.runId}` : ''}</small>}
    {loading && <p role="status">{savingPath ? (zh ? `正在另存 ${savingPath}…` : `Saving ${savingPath}…`) : (zh ? '读取远端工作区…' : 'Reading remote workspace…')}</p>}{error && <p role="alert" className="notice notice-error">{error}</p>}
    {saveNotice && <p role="status" className="remote-workspace-save-notice">{saveNotice}</p>}
    <div className="remote-workspace-columns"><nav aria-label={zh ? '远端文件' : 'Remote files'}>
      {listing && <><small>{listing.path}</small>{listing.path !== '.' && <button disabled={loading} onClick={() => void read('list', listing.path!.split('/').slice(0, -1).join('/') || '.')}>← {zh ? '上一级' : 'Parent directory'}</button>}
        {!listing.entries?.length && <p>{zh ? '目录为空。' : 'This directory is empty.'}</p>}
        {listing.entries?.map(entry => <div key={entry.path} className="remote-workspace-entry"><button title={entry.path} disabled={loading || entry.kind === 'unavailable'} onClick={() => void read(entry.kind === 'directory' ? 'list' : 'read', entry.path)}>{entry.kind === 'directory' ? '▸ ' : ''}{entry.name}</button>
          {entry.kind === 'file' && <button className="remote-workspace-save" disabled={loading || busy || !workspace} aria-label={zh ? `另存 ${entry.name} 到本机` : `Save ${entry.name} to this computer`} onClick={() => void save(entry.path)}>{zh ? '另存到本机' : 'Save locally'}</button>}</div>)}
        {listing.nextCursor !== undefined && <button disabled={loading} onClick={() => void read('list', listing.path, listing.nextCursor)}>{zh ? '下一页' : 'Next page'}</button>}
        {listing.nextCursor === undefined && (listing.entries?.length ?? 0) > 0 && <button disabled={loading} onClick={() => void read('list', listing.path, 0)}>{zh ? '回到第一页' : 'First page'}</button>}</>}
    </nav><div className="remote-workspace-preview">{preview ? <><strong>{preview.operation === 'read' ? preview.path : preview.operation === 'git_status' ? 'Git status' : 'Git diff'}</strong>{preview.gitHead && <small>HEAD {preview.gitHead}</small>}<pre>{preview.content || (zh ? '没有变化。' : 'No changes.')}</pre></> : <p>{zh ? '选择文本文件预览，或查看 Git 状态与差异。文档、图片等文件可直接另存到本机，单个文件最多 32 MiB。' : 'Select a text file or inspect Git status and diffs. Save documents, images and other files directly to this computer, up to 32 MiB per file.'}</p>}</div></div>
    {task.canAppend && <form onSubmit={event => { event.preventDefault(); if (instruction.trim()) { onCommand('append_task', task, instruction) } }}><textarea value={instruction} maxLength={200000} disabled={busy} aria-label={zh ? '继续原远端任务' : 'Continue the original remote task'} placeholder={zh ? '补充要求，交给远端 Agent 继续…' : 'Add instructions for the remote Agent…'} onChange={event => setInstruction(event.target.value)} /><button disabled={busy || !instruction.trim()}>{zh ? '发送到原任务' : 'Send to original task'}</button></form>}
  </section>
}
