import { useEffect, useRef, useState } from 'react'
import type { LocalDevServerStatus, LocalDevServerView } from '../../../../shared/local-dev-server-types'
import { useStore } from '../../store'
import './local-dev-server-panel.css'

const active = (status?: LocalDevServerStatus): boolean => Boolean(status && ['starting', 'running', 'stopping'].includes(status))
export default function LocalDevServerPanel({ sessionId, zh }: { sessionId: string; zh: boolean }): React.JSX.Element {
  const [view, setView] = useState<LocalDevServerView | null>(null)
  const [command, setCommand] = useState(''), [url, setUrl] = useState('http://localhost:5173/'), [cwd, setCwd] = useState('')
  const [error, setError] = useState(''), [readError, setReadError] = useState('')
  const [pendingId, setPendingId] = useState(''), [stopping, setStopping] = useState(false)
  const epoch = useRef(0), initialized = useRef(false), activeRequest = useRef('')
  const tr = (cn: string, en: string): string => zh ? cn : en
  useEffect(() => {
    const version = ++epoch.current; initialized.current = false; activeRequest.current = ''
    setView(null); setCommand(''); setUrl('http://localhost:5173/'); setCwd(''); setError(''); setReadError(''); setPendingId(''); setStopping(false)
    let fetching = false
    const refresh = async (): Promise<void> => {
      if (fetching) return
      fetching = true
      try {
        const next = await window.agentDesk.getLocalDevServer(sessionId)
        if (epoch.current !== version) return
        setView(next); setReadError('')
        if (!initialized.current) { initialized.current = true; setCommand(next.current?.config.command ?? ''); setUrl(next.current?.config.url ?? 'http://localhost:5173/'); setCwd(next.taskCwd) }
      } catch (cause) { if (epoch.current === version) setReadError(String(cause)) }
      finally { fetching = false }
    }
    void refresh(); const timer = setInterval(() => { void refresh() }, 1500)
    return () => { epoch.current++; clearInterval(timer) }
  }, [sessionId])
  const refreshAfter = async (version: number): Promise<void> => {
    const next = await window.agentDesk.getLocalDevServer(sessionId)
    if (version === epoch.current) setView(next)
  }
  async function start(): Promise<void> {
    if (activeRequest.current || active(view?.current?.status) || !cwd) return
    const id = crypto.randomUUID(), version = epoch.current
    activeRequest.current = id; setPendingId(id); setError('')
    try {
      const result = await window.agentDesk.startLocalDevServer({ sessionId, requestId: id, command, cwd, url })
      if (version === epoch.current) setView(result)
    } catch (cause) { if (version === epoch.current) setError(String(cause)) }
    finally {
      if (version === epoch.current) { activeRequest.current = ''; setPendingId(''); await refreshAfter(version).catch(() => undefined) }
    }
  }
  async function stop(): Promise<void> {
    const id = pendingId || view?.current?.id, version = epoch.current
    if (!id || stopping) return
    setStopping(true); setError('')
    try { const result = await window.agentDesk.stopLocalDevServer(sessionId, id); if (version === epoch.current) setView(result) }
    catch (cause) { if (version === epoch.current) setError(String(cause)) }
    finally { if (version === epoch.current) setStopping(false) }
  }
  async function open(): Promise<void> {
    try {
      const current = await window.agentDesk.getLocalDevServer(sessionId)
      if (useStore.getState().activeId !== sessionId) return
      if (current.current?.status !== 'running' || current.current.id !== view?.current?.id) throw new Error(tr('服务运行已变化，请刷新后重试。', 'The server run changed. Refresh and try again.'))
      await useStore.getState().openBrowserPanel(current.current.config.url)
    } catch (cause) { setError(String(cause)) }
  }
  const running = view?.current, locked = Boolean(pendingId) || active(running?.status)
  const labels: Record<LocalDevServerStatus, [string, string]> = { starting: ['启动中', 'Starting'], running: ['进程运行中', 'Process running'], stopping: ['等待进程退出', 'Waiting for exit'], stopped: ['已停止', 'Stopped'], exited: ['进程已退出', 'Process exited'], failed: ['启动或运行失败', 'Failed'], interrupted: ['上次进程状态未知', 'Previous process state unknown'] }
  return <section className="local-dev-server" data-local-dev-server>
    <p>{tr('填写项目已有的启动命令。文件更新和热更新由项目开发服务负责；请将服务配置为只监听本机。', 'Use the project’s existing start command. The project server handles file updates and hot reload. Configure it to listen on loopback only.')}</p>
    {view && !view.supported && <p className="notice">{tr('Windows 暂不支持在此托管进程树，请使用下面的任务终端入口。', 'Managed process trees are not available on Windows yet. Use the task terminal below.')}</p>}
    <label>{tr('完整启动命令', 'Full start command')}<input data-dev-server-command value={command} onChange={event => setCommand(event.target.value)} disabled={locked} placeholder="npm run dev -- --host 127.0.0.1" spellCheck={false} /></label>
    <label>{tr('工作目录（当前任务）', 'Working directory (current task)')}<input data-dev-server-cwd value={cwd} readOnly /></label>
    <label>{tr('本机预览地址', 'Local preview URL')}<input data-dev-server-url value={url} onChange={event => setUrl(event.target.value)} disabled={locked} spellCheck={false} /></label>
    <div className="local-dev-server-actions">
      <button type="button" className="btn btn-primary btn-sm" data-dev-server-start disabled={!view?.supported || locked || !command.trim() || !cwd || !url.trim()} onClick={() => void start()}>{pendingId ? tr('启动中…', 'Starting…') : tr('启动开发服务', 'Start development server')}</button>
      {locked && <button type="button" className="btn btn-ghost btn-sm" data-dev-server-stop disabled={stopping} onClick={() => void stop()}>{stopping ? tr('正在请求停止…', 'Requesting stop…') : tr('停止 / 取消启动', 'Stop / cancel start')}</button>}
      {running?.status === 'running' && <button type="button" className="btn btn-ghost btn-sm" data-dev-server-open onClick={() => void open()}>{tr('打开服务页面', 'Open server page')}</button>}
    </div>
    {running && <div className="local-dev-server-status" role="status" data-dev-server-status={running.status}>
      <strong>{labels[running.status][zh ? 0 : 1]}{running.pid ? ` · PID ${running.pid}` : ''}</strong>
      <span>{tr('地址：', 'URL: ')}{running.reachable ? tr('可访问', 'Reachable') : tr('尚未确认可访问', 'Not confirmed reachable')}{running.checkedAt ? ` · ${new Date(running.checkedAt).toLocaleTimeString()}` : ''}</span>
      <code>{running.config.url}</code>
      {running.exitCode !== undefined && <span>{tr('退出码：', 'Exit code: ')}{running.exitCode ?? '—'}{running.signal ? ` · ${running.signal}` : ''}</span>}
      {running.message && <p>{running.message}</p>}
      <small>{tr('地址检查不代表此进程拥有该端口。普通切换任务会保留服务；关闭原窗口、关闭任务或撤权会停止服务。', 'Reachability does not prove this process owns the port. Switching tasks keeps it running; closing its original window or task, or revoking authorization, stops it.')}</small>
      <details className="local-dev-server-logs" open><summary>{tr('进程日志', 'Process logs')} · {tr('最近 64 KB', 'Last 64 KB')}</summary><pre data-dev-server-logs>{running.logs.join('\n') || tr('暂无进程输出', 'No process output yet')}</pre></details>
    </div>}
    {view?.warning && <p className="notice">{view.warning}</p>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {readError && <p className="notice notice-error" role="alert">{readError}</p>}
  </section>
}
