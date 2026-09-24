import { useEffect, useRef, useState } from 'react'
import type { LocalSitePreview } from '../../../../shared/site-deployment-types'
import { useStore } from '../../store'
import { trackLocalSitePreview, untrackLocalSitePreview } from './local-site-preview-lifecycle'
import LocalDevServerPanel from './LocalDevServerPanel'

export default function LocalSitePreviewControls({ sessionId, zh }: { sessionId: string; zh: boolean }): React.JSX.Element {
  const [path, setPath] = useState('dist')
  const [preview, setPreview] = useState<LocalSitePreview | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const alive = useRef(true)
  const revision = useRef(0)
  const tr = (cn: string, en: string): string => zh ? cn : en
  useEffect(() => {
    alive.current = true
    const refresh = (): void => {
      const request = revision.current
      void window.agentDesk.getLocalSitePreview(sessionId).then(value => {
        if (!alive.current || request !== revision.current) return
        setPreview(value)
        if (value) trackLocalSitePreview(sessionId)
      }).catch(cause => { if (alive.current) setError(String(cause)) })
    }
    refresh(); const timer = setInterval(refresh, 3000)
    return () => { alive.current = false; revision.current++; clearInterval(timer) }
  }, [sessionId])
  const open = async (url: string): Promise<void> => {
    if (useStore.getState().activeId !== sessionId) return
    await useStore.getState().openBrowserPanel(url)
  }
  async function start(): Promise<void> {
    if (busy) return
    setBusy(true); setError('')
    const request = ++revision.current
    trackLocalSitePreview(sessionId)
    try {
      const next = await window.agentDesk.startLocalSitePreview(sessionId, path.trim())
      if (!alive.current || request !== revision.current || useStore.getState().activeId !== sessionId) {
        await window.agentDesk.stopLocalSitePreview(sessionId, next.id); return
      }
      setPreview(next)
      await open(next.localUrl)
    } catch (cause) { if (alive.current && request === revision.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (alive.current && request === revision.current) setBusy(false) }
  }
  async function stop(): Promise<void> {
    const request = ++revision.current; setBusy(true); setError('')
    try {
      await window.agentDesk.stopLocalSitePreview(sessionId)
      untrackLocalSitePreview(sessionId)
      if (alive.current && request === revision.current) setPreview(null)
    } catch (cause) { if (alive.current && request === revision.current) setError(String(cause)) }
    finally { if (alive.current && request === revision.current) setBusy(false) }
  }
  async function openServer(): Promise<void> {
    try {
      const url = new URL(serverUrl.trim())
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(tr('请输入终端中已启动的本机 HTTP(S) 服务地址。', 'Enter the local HTTP(S) server URL shown in the terminal.'))
      setError(''); await open(url.toString())
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return <article className="site-deployment-preview" data-local-site-preview>
    <h4>{tr('本地使用', 'Use locally')}</h4>
    <p>{tr('直接打开当前任务中的静态页面；修改文件后点击更新预览。', 'Open static pages from this task. Update the preview after editing files.')}</p>
    <label>{tr('HTML 文件或构建目录（相对任务目录）', 'HTML file or build directory (relative to this task)')}<input value={path} onChange={event => setPath(event.target.value)} placeholder="dist / report.html" spellCheck={false} /></label>
    <div className="site-deployment-actions">
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !path.trim()} onClick={() => void start()}>{busy ? tr('处理中…', 'Working…') : preview ? tr('更新并打开预览', 'Update and open preview') : tr('打开本地预览', 'Open local preview')}</button>
      {preview && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void open(preview.localUrl).catch(cause => setError(String(cause)))}>{tr('查看当前预览', 'View current preview')}</button>}
      {(preview || busy) && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void stop()}>{tr('停止预览', 'Stop preview')}</button>}
    </div>
    {preview && <p role="status">{preview.sourcePath} · {preview.fileCount} {tr('个文件', 'files')} · {(preview.bytes / 1024).toFixed(1)} KB · {tr('有效至', 'Until')} {new Date(preview.expiresAt).toLocaleTimeString()}</p>}
    <p className="settings-hint">{tr('单个 HTML 按独立文件预览；有 CSS、图片或脚本资源时选择包含 index.html 的构建目录。预览只在本机开放，切换任务会停止。', 'A single HTML is previewed on its own. For CSS, images and scripts, select the build directory containing index.html. Preview stays on this computer and stops when you switch tasks.')}</p>
    <details><summary>{tr('需要开发服务器或后端', 'Development server or backend')}</summary>
      <LocalDevServerPanel key={sessionId} sessionId={sessionId} zh={zh} />
      <h5>{tr('已在终端运行的服务', 'Server already running in a terminal')}</h5>
      <p>{tr('在当前任务终端运行项目的启动命令，查看日志和实际服务地址；结束时在终端停止服务。静态预览不会启动后端。', 'Run the project start command in this task’s terminal, inspect its logs and actual server address, and stop it there when finished. Static preview does not start a backend.')}</p>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
        if (useStore.getState().activeId !== sessionId) return
        useStore.setState(state => ({ workbench: { ...state.workbench, terminalScope: 'task' } }))
        void useStore.getState().openTerminalPanel().catch(cause => setError(String(cause)))
      }}>{tr('打开当前任务终端', 'Open task terminal')}</button>
      <label>{tr('终端中的实际服务地址', 'Actual server URL from terminal')}<input value={serverUrl} onChange={event => setServerUrl(event.target.value)} placeholder="http://localhost:5173" /></label>
      <button type="button" className="btn btn-ghost btn-sm" disabled={!serverUrl.trim()} onClick={() => void openServer()}>{tr('在浏览器打开服务', 'Open server in browser')}</button>
    </details>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
  </article>
}
