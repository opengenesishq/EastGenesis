import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useStore } from '../../store'
import { normalizeTerminalPreferences } from '../../../../shared/desktop-behavior-preferences'
import type { SshHost, SshHostInput, SshKeyPreview, SshTerminalState } from '../../../../shared/ssh-types'
import '@xterm/xterm/css/xterm.css'
import './ssh-settings.css'

const blank: SshHostInput = { name: '', hostname: '', username: '', port: 22, remoteDirectory: '/' }
const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

function SshTerminal({ initial, onError, onDisconnect }: { initial: SshTerminalState; onError: (text: string) => void; onDisconnect: () => void }): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const viewRef = useRef<Terminal>()
  const fitRef = useRef<FitAddon>()
  const preferences = normalizeTerminalPreferences(useStore(state => state.settings.terminalPreferences))
  const [status, setStatus] = useState('连接中：身份验证提示将显示在终端中')
  const errorHandler = useRef(onError)
  errorHandler.current = onError
  useEffect(() => {
    if (!root.current) return
    let disposed = false
    let exited = false
    let previous = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    let queue = Promise.resolve()
    const view = new Terminal({ cursorBlink: preferences.cursorBlink, fontSize: preferences.fontSize, scrollback: preferences.scrollback, fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace', theme: { background: '#171717', foreground: '#eee' }, allowProposedApi: false })
    const fit = new FitAddon()
    view.loadAddon(fit)
    view.open(root.current)
    viewRef.current = view; fitRef.current = fit
    const id = initial.terminal.id
    const fail = (error: unknown): void => { if (!disposed) errorHandler.current(message(error)) }
    const refresh = async (): Promise<void> => {
      try {
        const state = await window.agentDesk.readSshTerminal(id)
        if (disposed) return
        if (state.buffer.startsWith(previous)) view.write(state.buffer.slice(previous.length))
        else { view.reset(); view.write(state.buffer) }
        previous = state.buffer
        if (state.terminal.exit) {
          exited = true
          view.options.disableStdin = true
          setStatus(`已断开 · 退出码 ${state.terminal.exit.exitCode ?? '未知'}。远端命令是否结束需在主机上核对。`)
        } else if (state.buffer) setStatus('SSH 终端运行中 · 请按终端提示完成登录')
      } catch (error) { fail(error) }
    }
    const unsubscribe = window.agentDesk.onSshTerminalEvent(event => {
      if (event.kind === 'started' || event.id !== id || timer || disposed) return
      timer = setTimeout(() => { timer = undefined; void refresh() }, 30)
    })
    const input = view.onData(data => {
      if (disposed || exited) return
      queue = queue.then(async () => {
        if (disposed || exited) return
        for (let i = 0; i < data.length; i += 16384) await window.agentDesk.writeSshTerminal(id, data.slice(i, i + 16384))
      }).catch(fail)
    })
    const resize = new ResizeObserver(() => {
      if (disposed || exited || !root.current?.clientWidth || !root.current?.clientHeight) return
      fit.fit()
      void window.agentDesk.resizeSshTerminal(id, view.cols, view.rows).catch(fail)
    })
    resize.observe(root.current)
    void refresh()
    view.focus()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      unsubscribe(); input.dispose(); resize.disconnect(); view.dispose()
      viewRef.current = undefined; fitRef.current = undefined
    }
  }, [initial.terminal.id])
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.options.fontSize = preferences.fontSize
    view.options.scrollback = preferences.scrollback
    view.options.cursorBlink = preferences.cursorBlink
    fitRef.current?.fit()
  }, [preferences.fontSize, preferences.scrollback, preferences.cursorBlink])
  return <section className="ssh-terminal" data-ssh-terminal-id={initial.terminal.id}>
    <header><strong>{initial.hostLabel}</strong><button className="btn btn-ghost btn-sm" onClick={onDisconnect}>断开并关闭终端</button></header>
    <p>{status}</p><div ref={root} className="ssh-terminal-viewport" aria-label="SSH 远程终端" />
  </section>
}

export default function SshSettings(): React.JSX.Element {
  const [hosts, setHosts] = useState<SshHost[]>([])
  const [supported, setSupported] = useState(false)
  const [reason, setReason] = useState('正在读取 SSH 设置…')
  const [draft, setDraft] = useState<SshHostInput>({ ...blank })
  const [editing, setEditing] = useState<SshHost>()
  const [preview, setPreview] = useState<SshKeyPreview>()
  const [verified, setVerified] = useState(false)
  const [terminal, setTerminal] = useState<SshTerminalState>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(true)
  const terminalRef = useRef(terminal)
  terminalRef.current = terminal
  useEffect(() => {
    mounted.current = true
    void refresh().catch(cause => { if (mounted.current) setError(message(cause)) })
    return () => {
      mounted.current = false
      // React StrictMode immediately remounts effects; only a real departure disconnects.
      setTimeout(() => { if (!mounted.current && terminalRef.current) void window.agentDesk.closeSshTerminal(terminalRef.current.terminal.id).catch(() => undefined) }, 0)
    }
  }, [])
  const refresh = async (): Promise<void> => {
    const state = await window.agentDesk.listSshHosts()
    if (!mounted.current) return
    setHosts(state.hosts); setSupported(state.supported); setReason(state.reason ?? '')
  }
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (cause) { if (mounted.current) setError(message(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const reset = (): void => { setEditing(undefined); setDraft({ ...blank }); setPreview(undefined); setVerified(false) }
  return <div className="ssh-settings">
    <h3>SSH 主机</h3>
    <p className="ssh-muted">保存主机地址，核对公钥后打开真实远程终端。密码或私钥口令在终端输入，应用只保存私钥文件路径。关闭此页面会断开 SSH。</p>
    {!supported && <p className="notice notice-info">{reason}</p>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {notice && <p className="notice notice-info" role="status">{notice}</p>}
    <form onSubmit={event => { event.preventDefault(); void run(async () => { await window.agentDesk.saveSshHost(draft, editing?.id, editing?.revision); if (!mounted.current) return; reset(); await refresh(); setNotice('主机已保存；连接前请核对主机公钥。') }) }}>
      <fieldset disabled={busy || !supported}>
        <div className="ssh-fields">
          <label>名称<input className="input" value={draft.name} placeholder="开发服务器" required maxLength={100} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
          <label>主机地址<input className="input" value={draft.hostname} placeholder="server.example.com" required onChange={e => setDraft({ ...draft, hostname: e.target.value })} /></label>
          <label>用户名<input className="input" value={draft.username} placeholder="用户名" required onChange={e => setDraft({ ...draft, username: e.target.value })} /></label>
          <label>端口<input className="input" type="number" min={1} max={65535} value={draft.port} required onChange={e => setDraft({ ...draft, port: Number(e.target.value) })} /></label>
          <label className="ssh-wide">远端工作目录<input className="input" value={draft.remoteDirectory} placeholder="/home/user/project" required onChange={e => setDraft({ ...draft, remoteDirectory: e.target.value })} /></label>
        </div>
        <div className="ssh-actions"><span className="ssh-muted">{draft.identityFile || '密码登录（不保存密码）'}</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => void run(async () => { const file = await window.agentDesk.pickSshIdentity(); if (file && mounted.current) setDraft(value => ({ ...value, identityFile: file })) })}>选择私钥</button>{draft.identityFile && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft({ ...draft, identityFile: undefined })}>改用密码</button>}</div>
        <div className="ssh-actions"><button className="btn btn-primary" type="submit">{editing ? '保存修改' : '添加主机'}</button>{editing && <button className="btn btn-ghost" type="button" onClick={reset}>取消编辑</button>}</div>
      </fieldset>
    </form>
    <div className="ssh-hosts">{hosts.map(host => <section className="ssh-host" key={host.id}>
      <div><strong>{host.name}</strong><p className="ssh-muted">{host.username}@{host.hostname}:{host.port} · {host.remoteDirectory}</p><small>{host.trustedKeys.length ? `已保存 ${host.trustedKeys.length} 个主机公钥` : '尚未信任主机公钥'}</small></div>
      <div className="ssh-actions">
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setEditing(host); setDraft({ ...host }); setPreview(undefined); setVerified(false) }}>编辑</button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(async () => { const result = await window.agentDesk.scanSshHostKey(host.id, host.revision); if (mounted.current) { setPreview(result); setVerified(false) } })}>读取主机公钥</button>
        <button className="btn btn-primary btn-sm" disabled={busy || !host.trustedKeys.length} onClick={() => void run(async () => {
          if (terminal) { await window.agentDesk.closeSshTerminal(terminal.terminal.id); setTerminal(undefined) }
          const result = await window.agentDesk.connectSshHost(host.id, host.revision)
          if (!mounted.current) { await window.agentDesk.closeSshTerminal(result.terminal.id); return }
          setTerminal(result)
        })}>打开终端</button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { if (window.confirm(`删除“${host.name}”的本地主机配置并断开连接？远端文件不会删除。`)) void run(async () => { await window.agentDesk.deleteSshHost(host.id, host.revision); reset(); await refresh() }) }}>删除</button>
      </div>
    </section>)}</div>
    {preview && <section className="ssh-key-preview">
      <h4>核对主机身份 · {hosts.find(host => host.id === preview.hostId)?.name}</h4>
      <p>请与服务器管理员或服务器控制台显示的 SHA256 指纹核对。读取到的公钥本身不能证明服务器可信。确认后，公钥变化会阻止连接。</p>
      {preview.keys.map(key => <p key={key.fingerprint}><b>{key.type}</b><code>{key.fingerprint}</code></p>)}
      <label><input type="checkbox" checked={verified} onChange={event => setVerified(event.target.checked)} /> 我已通过可信渠道核对上述指纹</label>
      <div className="ssh-actions"><button className="btn btn-primary" disabled={busy || !verified} onClick={() => void run(async () => { await window.agentDesk.trustSshHostKey(preview.token); if (!mounted.current) return; setPreview(undefined); setVerified(false); await refresh() })}>信任这些公钥</button><button className="btn btn-ghost" onClick={() => setPreview(undefined)}>取消</button></div>
    </section>}
    {terminal && <SshTerminal initial={terminal} onError={setError} onDisconnect={() => void run(async () => { await window.agentDesk.closeSshTerminal(terminal.terminal.id); if (mounted.current) setTerminal(undefined) })} />}
    <p className="ssh-muted">此入口提供人工 SSH 终端。让 Agent 直接在远端项目中读写、执行和恢复任务仍需远端执行器支持。</p>
  </div>
}
