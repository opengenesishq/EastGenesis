import { useEffect, useMemo, useRef, useState } from 'react'
import type { McpOAuthBinding, McpOAuthState } from '../../../../shared/mcp-oauth-types'
import { useStore } from '../../store'
import type { PluginRegistryPanelItem } from './PluginRegistryPanel'

export default function McpOAuthCard({ item }: { item: PluginRegistryPanelItem }) {
  const sessionId = useStore(state => state.activeId) ?? undefined
  const zh = useStore(state => state.settings.language === 'zh')
  const binding = useMemo<McpOAuthBinding>(() => ({ registryItemKey: JSON.stringify([item.kind, item.sourceRoot, item.path, item.name]), contentDigest: item.contentDigest ?? '', capabilityDigest: item.capabilityManifest.digest, serverId: item.name }), [item.kind, item.sourceRoot, item.path, item.name, item.contentDigest, item.capabilityManifest.digest])
  const [state, setState] = useState<McpOAuthState>(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [clientId, setClientId] = useState(''), [port, setPort] = useState(''), [scopes, setScopes] = useState<string[]>([])
  const version = useRef(0), valid = item.enabled && item.trust.status === 'approved' && !!item.contentDigest
  useEffect(() => {
    const current = ++version.current
    setState(undefined); setError(''); setBusy(false); setClientId(''); setPort('')
    if (!valid) return
    void window.agentDesk.getMcpOAuthState(binding, sessionId).then(value => { if (version.current === current) setState(value) }).catch(reason => { if (version.current === current) setError(String(reason)) })
    return () => { version.current += 1 }
  }, [binding, sessionId, valid])
  useEffect(() => {
    if (state?.status !== 'authorizing') return
    let alive = true, running = false
    const timer = setInterval(() => {
      if (running) return
      running = true
      void window.agentDesk.getMcpOAuthState(binding, sessionId).then(value => { if (alive) setState(value) }).catch(reason => { if (alive) setError(String(reason)) }).finally(() => { running = false })
    }, 1500)
    return () => { alive = false; clearInterval(timer) }
  }, [binding, sessionId, state?.status])
  async function act(operation: () => Promise<McpOAuthState>) {
    const current = version.current
    setBusy(true); setError('')
    try { const value = await operation(); if (current === version.current) { setState(value); if (value.preparation) setScopes(value.preparation.scopes) } }
    catch (reason) { if (current === version.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (current === version.current) setBusy(false) }
  }
  const labels = zh ? { disconnected: '未连接账号', unsupported: '无需远程 OAuth', ready: '已找到授权服务', authorizing: '等待浏览器授权', connected: '账号已连接', authorization_required: '需要重新授权', error: '连接未完成' } : { disconnected: 'No account connected', unsupported: 'Remote OAuth not applicable', ready: 'Authorization service found', authorizing: 'Waiting for browser consent', connected: 'Account connected', authorization_required: 'Authorization required', error: 'Connection incomplete' }
  return <section className="plugin-registry-card" data-mcp-oauth="true">
    <h3 className="plugin-registry-card-title">{zh ? '服务账号授权' : 'Service authorization'}</h3>
    {!valid ? <p>{zh ? '请先批准当前插件内容并启用，再连接服务账号。' : 'Approve and enable this plugin before connecting an account.'}</p> : <>
      <p role="status">{state ? labels[state.status] : (zh ? '读取连接状态…' : 'Reading connection…')}</p>
      {state?.issuer && <p style={{ overflowWrap: 'anywhere' }}>{state.issuer}</p>}
      {state?.storage && <p>{state.storage === 'encrypted' ? (zh ? '系统加密存储' : 'System encrypted storage') : (zh ? '仅本次运行；退出后需重新授权' : 'This run only; reconnect after quitting')}</p>}
      {state?.message && <p>{state.message}</p>}
      {state?.preparation && <div style={{ display: 'grid', gap: 8 }}>
        <p style={{ overflowWrap: 'anywhere' }}>{zh ? '资源：' : 'Resource: '}{state.preparation.resource}<br />{zh ? '授权方：' : 'Issuer: '}{state.preparation.issuer}</p>
        <label>{zh ? 'Public client ID' : 'Public client ID'}<input className="input" value={clientId} onChange={event => setClientId(event.target.value)} placeholder={state.preparation.dynamicRegistration ? (zh ? '留空以动态注册' : 'Leave empty for dynamic registration') : (zh ? '服务中预注册的 client_id' : 'Your pre-registered client_id')} /></label>
        <label>{zh ? '预注册回调端口（可选）' : 'Registered callback port (optional)'}<input className="input" inputMode="numeric" value={port} onChange={event => setPort(event.target.value)} placeholder={zh ? '留空使用临时端口' : 'Leave empty for an ephemeral port'} /></label>
        <small>{zh ? '回调路径为 http://127.0.0.1:端口/oauth/callback。服务需支持 public client 与 PKCE S256。' : 'Callback: http://127.0.0.1:port/oauth/callback. The service must support public clients and PKCE S256.'}</small>
        {state.preparation.scopes.map(scope => <label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={event => setScopes(value => event.target.checked ? [...value, scope] : value.filter(item => item !== scope))} /> {scope}</label>)}
        <button className="btn btn-primary btn-sm" disabled={busy || (!clientId.trim() && !state.preparation.dynamicRegistration)} data-mcp-oauth-connect onClick={() => void act(() => window.agentDesk.connectMcpOAuth(binding, { preparationId: state.preparation!.id, clientId: clientId.trim() || undefined, callbackPort: port.trim() ? Number(port) : undefined, scopes }, sessionId))}>{zh ? '连接并授权' : 'Connect and authorize'}</button>
      </div>}
      <div className="plugin-registry-actions" style={{ flexWrap: 'wrap', marginTop: 8 }}>
        {state?.status !== 'unsupported' && state?.status !== 'authorizing' && <button className="btn btn-ghost btn-sm" disabled={busy} data-mcp-oauth-prepare onClick={() => void act(() => window.agentDesk.prepareMcpOAuth(binding, sessionId))}>{zh ? '检查授权' : 'Check authorization'}</button>}
        {state?.status === 'authorizing' && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => window.agentDesk.cancelMcpOAuth(binding, sessionId))}>{zh ? '取消授权' : 'Cancel authorization'}</button>}
        {(state?.status === 'connected' || state?.status === 'authorization_required') && <>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => window.agentDesk.disconnectMcpOAuth(binding, false, sessionId))}>{zh ? '断开本机连接' : 'Disconnect locally'}</button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => window.agentDesk.disconnectMcpOAuth(binding, true, sessionId))}>{zh ? '撤销服务令牌' : 'Revoke service token'}</button>
        </>}
      </div>
    </>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}
  </section>
}
