import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Share2, X } from 'lucide-react'
import type { ChatShareOperationPreview, ChatSnapshotContent, ChatSnapshotShareState, ChatSnapshotSource } from '../../../../shared/chat-snapshot-share-types'
import type { SiteDeploymentTarget } from '../../../../shared/site-deployment-types'
import { taskWindowSessionId } from '../../task-window-context'
import './chat-snapshot-share.css'

export default function ChatSnapshotShareLauncher({ sessionId, zh = true, className }: { sessionId: string; zh?: boolean; className?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return <><button type="button" className={className ?? 'btn btn-ghost btn-sm'} onClick={() => setOpen(true)}><Share2 size={15}/>{zh ? '分享快照' : 'Share snapshot'}</button>
    {open && <ChatSnapshotShareDialog sessionId={sessionId} zh={zh} onClose={() => setOpen(false)} />}</>
}

export function ChatSnapshotShareDialog({ sessionId, zh = true, onClose }: { sessionId: string; zh?: boolean; onClose(): void }): React.JSX.Element {
  const [state, setState] = useState<ChatSnapshotShareState>({ snapshots: [], adapters: [], receipts: [] })
  const [source, setSource] = useState<ChatSnapshotSource | null>(null)
  const [selected, setSelected] = useState<string[]>([]), [replacements, setReplacements] = useState<Record<string,string>>({})
  const [title, setTitle] = useState(''), [content, setContent] = useState<ChatSnapshotContent | null>(null)
  const [preview, setPreview] = useState<ChatShareOperationPreview | null>(null)
  const [targets, setTargets] = useState<SiteDeploymentTarget[]>([]), [targetId, setTargetId] = useState('')
  const [adapterId, setAdapterId] = useState(''), [adapterName, setAdapterName] = useState('聊天静态分享'), [adapterArgs, setAdapterArgs] = useState('[]')
  const [all, setAll] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const generation = useRef(0), pending = useRef(false)
  const tr = (cn: string, en: string) => zh ? cn : en
  const refresh = async (epoch: number) => {
    const next = await window.agentDesk.listChatSnapshots(all ? undefined : sessionId)
    if (generation.current === epoch) setState(next)
  }
  useEffect(() => {
    const epoch = ++generation.current
    void refresh(epoch).catch(cause => { if (generation.current === epoch) setError(message(cause)) })
    void window.agentDesk.getSiteDeployments(sessionId).then(value => { if (generation.current === epoch) setTargets(value.targets) }).catch(() => { if (generation.current === epoch) setTargets([]) })
    return () => { generation.current++ }
  }, [sessionId, all])
  const run = async (label: string, action: (epoch: number) => Promise<void>) => {
    if (pending.current) return
    pending.current = true; setBusy(label); setError(''); setNotice('')
    const epoch = generation.current
    try { await action(epoch); if (generation.current === epoch) await refresh(epoch) }
    catch (cause) { if (generation.current === epoch) setError(message(cause)) }
    finally { pending.current = false; if (generation.current === epoch) setBusy('') }
  }
  const changed = () => { setContent(null); setPreview(null) }
  const close = () => { generation.current++; onClose() }
  const adapterOptions = state.adapters.filter(adapter => adapter.sessionId === (content?.snapshot.sessionId ?? sessionId))
  const status = { executing: tr('执行中','Executing'), confirmed: tr('已确认','Confirmed'), not_applied: tr('未生效','Not applied'), needs_reconciliation: tr('待核对','Needs reconciliation') }
  return createPortal(<div className="chat-share-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close() }}>
    <section className="chat-share-dialog" role="dialog" aria-modal="true" aria-label={tr('分享聊天静态快照','Share a static chat snapshot')}>
      <header><div><h2>{tr('分享聊天快照','Share chat snapshot')}</h2><p>{tr('选择正文，检查脱敏内容，再保存或发布。','Choose messages, review redactions, then save or publish.')}</p></div><button type="button" className="btn btn-ghost btn-icon-sm" aria-label={tr('关闭','Close')} disabled={Boolean(busy)} onClick={close}><X size={18}/></button></header>
      {error && <p className="notice notice-error" role="alert">{error}</p>}{notice && <p className="notice notice-info" role="status">{notice}</p>}
      <div className="chat-share-toolbar"><button type="button" className="btn btn-primary btn-sm" disabled={Boolean(busy)} onClick={() => void run('capture', async epoch => {
        const next = await window.agentDesk.captureChatSnapshot(sessionId)
        if (generation.current !== epoch) return
        setSource(next); setSelected(next.messages.map(item => item.id)); setReplacements({}); setTitle(next.title); changed()
      })}>{source ? tr('重新捕获对话','Capture again') : tr('选择要分享的正文','Choose conversation content')}</button>
        {!taskWindowSessionId() && <label><input type="checkbox" checked={all} disabled={Boolean(busy)} onChange={event => setAll(event.target.checked)} />{tr('本机全部分享记录','All local share records')}</label>}
        {busy && <span role="status">{tr('处理中…','Working…')}</span>}
      </div>
      {source && <section className="chat-share-editor">
        <label>{tr('公开标题','Public title')}<input value={title} disabled={Boolean(busy)} maxLength={500} onChange={event => { setTitle(event.target.value); changed() }} /></label>
        <p className="chat-share-note">{tr(`已遮盖 ${source.redactedMessages} 条消息中的已识别敏感内容；省略 ${source.omittedAttachments} 个附件、${source.omittedEvents} 项非正文记录及 ${source.incompleteTurns} 个未完成轮次。请继续检查正文中的私人信息。`, `${source.redactedMessages} messages redacted; ${source.omittedAttachments} attachments, ${source.omittedEvents} non-message records and ${source.incompleteTurns} incomplete turns omitted. Review private information in the visible text.`)}</p>
        <div className="chat-share-message-list">{source.messages.map(item => <article key={item.id}>
          <label><input type="checkbox" checked={selected.includes(item.id)} disabled={Boolean(busy)} onChange={event => { setSelected(value => event.target.checked ? [...value,item.id] : value.filter(id => id !== item.id)); changed() }} />{item.role === 'user' ? tr('用户','User') : 'EastGenesis'}</label>
          <textarea aria-label={`${item.role === 'user' ? '用户' : 'EastGenesis'}公开正文`} value={replacements[item.id] ?? item.text} disabled={Boolean(busy) || !selected.includes(item.id)} onChange={event => { setReplacements(value => ({ ...value,[item.id]:event.target.value })); changed() }} />
        </article>)}</div>
        {!source.messages.length && <p>{tr('当前没有已完成的对话轮次。','No completed conversation turns are available.')}</p>}
        <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(busy) || !selected.length || !title.trim()} onClick={() => void run('prepare', async epoch => {
          const next = await window.agentDesk.prepareChatSnapshot(sessionId, { sourcePreviewId: source.id, title, selectedMessageIds: selected,
            replacements: Object.fromEntries(Object.entries(replacements).filter(([id]) => selected.includes(id))) })
          if (generation.current === epoch) { setContent(next); setPreview(null) }
        })}>{tr('生成并预览这份快照','Create and preview this snapshot')}</button>
      </section>}
      {content && <section className="chat-share-content"><h3>{content.snapshot.title}</h3><p className="chat-share-note">{content.snapshot.messageCount} {tr('条消息','messages')} · {content.snapshot.bytes.toLocaleString()} bytes · {tr('固定版本','Fixed version')}</p>
        <iframe title={tr('即将保存或发布的静态页面','Static page to save or publish')} sandbox="" referrerPolicy="no-referrer" srcDoc={content.html} />
        <div className="chat-share-toolbar"><button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void run('export', async epoch => {
          const result = await window.agentDesk.exportChatSnapshot(content.snapshot.id)
          if (!result.canceled && generation.current === epoch) setNotice(tr(`已保存：${result.filePath}`, `Saved: ${result.filePath}`))
        })}>{tr('保存独立 HTML','Save standalone HTML')}</button>
          <select aria-label={tr('分享适配器','Share adapter')} value={adapterId} disabled={Boolean(busy)} onChange={event => { setAdapterId(event.target.value); setPreview(null) }}><option value="">{tr('选择分享适配器','Choose a share adapter')}</option>{adapterOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(busy) || !adapterId || !adapterOptions.some(item => item.id === adapterId)} onClick={() => void run('prepare-publish', async epoch => {
            const next = await window.agentDesk.prepareChatShareOperation({ action: 'publish', snapshotId: content.snapshot.id, adapterId })
            if (generation.current === epoch) setPreview(next)
          })}>{tr('准备发布分享','Prepare publication')}</button>
        </div>
      </section>}
      <details className="chat-share-adapter"><summary>{tr('用户部署适配器','User deployment adapter')}</summary>
        <p className="chat-share-note">{tr('沿用本任务「站点部署」中配置的程序及环境变量。分享参数须接入 caogen-chat-share/1，支持单份资源的发布、撤销和核对。账号凭据由用户适配器管理。','Uses the program and environment configured in this task’s site deployment targets. Share arguments must implement caogen-chat-share/1 with per-share publish, revoke and inspect operations. Credentials remain with your adapter.')}</p>
        {!targets.length && <p>{tr('请先在任务工作区的站点部署面板配置用户部署目标；本地 HTML 保存仍可使用。','Configure a deployment target in the task workspace first. Local HTML export remains available.')}</p>}
        <label>{tr('部署目标','Deployment target')}<select value={targetId} onChange={event => setTargetId(event.target.value)} disabled={Boolean(busy)}><option value="">{tr('请选择','Choose')}</option>{targets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>{tr('分享适配器名称','Adapter name')}<input value={adapterName} maxLength={120} disabled={Boolean(busy)} onChange={event => setAdapterName(event.target.value)} /></label>
        <label>{tr('分享参数（JSON 字符串数组）','Share arguments (JSON string array)')}<textarea value={adapterArgs} disabled={Boolean(busy)} onChange={event => setAdapterArgs(event.target.value)} placeholder={'["/absolute/path/to/share-adapter.mjs"]'} /></label>
        <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy) || !targetId || !adapterName.trim()} onClick={() => void run('save-adapter', async epoch => {
          const target = targets.find(item => item.id === targetId)
          if (!target) throw Error(tr('部署目标已变化。','Deployment target changed.'))
          const args = JSON.parse(adapterArgs)
          if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw Error(tr('参数必须是 JSON 字符串数组。','Arguments must be a JSON string array.'))
          const saved = await window.agentDesk.saveChatShareAdapter(sessionId, { name: adapterName, deploymentTargetId: target.id, deploymentTargetRevision: target.revision, args })
          if (generation.current === epoch) { setAdapterId(saved.id); setNotice(tr('分享适配器已保存。','Share adapter saved.')) }
        })}>{tr('保存分享适配器','Save share adapter')}</button>
      </details>
      {preview && <section className="chat-share-operation"><h3>{preview.action === 'publish' ? tr('发布预览','Publication preview') : tr('撤销预览','Revocation preview')}</h3>
        <p>{preview.snapshot.title} · {preview.account.accountName}</p><dl><dt>{tr('账号','Account')}</dt><dd>{preview.account.accountScope}</dd><dt>{tr('目标','Target')}</dt><dd>{preview.account.targetId}</dd><dt>{tr('分享','Share')}</dt><dd>{preview.shareId}</dd><dt>{tr('内容摘要','Content digest')}</dt><dd>{preview.snapshot.digest}</dd></dl>
        <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(busy)} onClick={() => void run('execute', async epoch => {
          const receipt = await window.agentDesk.executeChatShareOperation(preview.id)
          if (receipt && generation.current === epoch) { setPreview(null); setNotice(`${status[receipt.status]} · ${receipt.action === 'publish' ? tr('发布','Publish') : tr('撤销','Revoke')}`) }
        })}>{preview.action === 'publish' ? tr('发布这份快照','Publish this snapshot') : tr('撤销此分享','Revoke this share')}</button>
        {busy === 'execute' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void window.agentDesk.cancelChatShareOperation(preview.operationId).catch(cause => setError(message(cause)))}>{tr('停止并核对结果','Stop and reconcile')}</button>}
      </section>}
      <section className="chat-share-history"><h3>{tr('已保存快照','Saved snapshots')}</h3>
        {state.snapshots.length === 0 && <p className="chat-share-note">{tr('尚未生成静态快照。','No snapshots yet.')}</p>}
        {state.snapshots.map(item => <article key={item.id}><div><strong>{item.title}</strong><small>{new Date(item.createdAt).toLocaleString()} · {item.messageCount} {tr('条消息','messages')}</small></div>
          <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void run('read', async epoch => { const value = await window.agentDesk.readChatSnapshot(item.id); if (generation.current === epoch) { setContent(value); setPreview(null); setSource(null) } })}>{tr('查看','View')}</button>
        </article>)}
        <h3>{tr('发布与撤销记录','Publication and revocation records')}</h3>
        {state.receipts.map(item => {
          const revoked = state.receipts.some(other => other.shareId === item.shareId && other.action === 'revoke' && other.status === 'confirmed')
          return <article key={item.id} className="chat-share-receipt"><div><strong>{item.action === 'publish' ? tr('发布','Publish') : tr('撤销','Revoke')} · {status[item.status]}{revoked && item.action === 'publish' ? tr(' · 已撤销',' · Revoked') : ''}</strong>
            <small>{item.adapterName} · {item.account.accountName} · {new Date(item.startedAt).toLocaleString()}</small><code>{item.shareId}</code>{item.url && <span className="chat-share-url">{item.url}</span>}{item.error && <p role="alert">{item.error}</p>}</div>
            <div className="chat-share-receipt-actions">
              {item.url && !revoked && item.action === 'publish' && item.status === 'confirmed' && <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void navigator.clipboard.writeText(item.url!).then(() => setNotice(tr('链接已复制。','Link copied.'))).catch(cause => setError(message(cause)))}>{tr('复制 URL','Copy URL')}</button>}
              {item.action === 'publish' && item.status === 'confirmed' && !revoked && <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void run('prepare-revoke', async epoch => {
                const next = await window.agentDesk.prepareChatShareOperation({ action: 'revoke', snapshotId: item.snapshotId, shareId: item.shareId })
                if (generation.current === epoch) setPreview(next)
              })}>{tr('撤销分享','Revoke share')}</button>}
              {item.status === 'needs_reconciliation' && <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => void run('inspect', async epoch => {
                const next = await window.agentDesk.inspectChatShareOperation(item.id)
                if (next && generation.current === epoch) setNotice(status[next.status])
              })}>{tr('核对原操作','Inspect original operation')}</button>}
              {item.status === 'executing' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void window.agentDesk.cancelChatShareOperation(item.operationId).catch(cause => setError(message(cause)))}>{tr('停止','Stop')}</button>}
            </div>
          </article>
        })}
      </section>
    </section>
  </div>, document.body)
}
function message(value: unknown): string { return value instanceof Error ? value.message : String(value) }
