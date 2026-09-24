import { useEffect, useRef, useState } from 'react'
import type { PluginRegistryItem } from '../../../../shared/plugin-registry-types'
import type { McpOAuthState } from '../../../../shared/mcp-oauth-types'
import { useStore } from '../../store'
import { migrationServiceCandidates } from './migration-service-links'

function currentContext() {
  const state = useStore.getState(), session = state.activeId ? state.sessions[state.activeId]?.meta : undefined
  return { id: state.activeId ?? undefined, directories: [session?.cwd, session?.sourceCwd] }
}
export default function MigrationServiceFollowup({ targetPaths }: { targetPaths: string[] }) {
  const zh = useStore(state => state.settings.language === 'zh'), activeId = useStore(state => state.activeId)
  const [items, setItems] = useState<PluginRegistryItem[]>([]), [states, setStates] = useState<Record<string, McpOAuthState['status']>>({})
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), generation = useRef(0)
  const targetsKey = JSON.stringify(targetPaths)
  useEffect(() => { generation.current++; setItems([]); setStates({}); setMessage(''); setBusy(false); return () => { generation.current++ } }, [activeId, targetsKey])
  if (!targetPaths.some(path => /[/\\]\.caogen[/\\]mcp[/\\]mcp\.json$/.test(path))) return null
  async function inspect() {
    const token = ++generation.current, context = currentContext()
    setBusy(true); setMessage('')
    try {
      const registry = await window.agentDesk.scanPluginRegistry(context.id)
      if (token !== generation.current || JSON.stringify(currentContext()) !== JSON.stringify(context)) return
      const candidates = migrationServiceCandidates(targetPaths, registry.items, context.directories)
      const statuses: Record<string, McpOAuthState['status']> = {}
      for (const item of candidates.slice(0, 100)) {
        if (!item.enabled || item.trust.status !== 'approved' || !item.contentDigest) continue
        try {
          const result = await window.agentDesk.getMcpOAuthState({ registryItemKey: JSON.stringify([item.kind, item.sourceRoot, item.path, item.name]), contentDigest: item.contentDigest, capabilityDigest: item.capabilityManifest.digest, serverId: item.name }, context.id)
          statuses[item.id] = result.status
        } catch { statuses[item.id] = 'error' }
      }
      if (token !== generation.current || JSON.stringify(currentContext()) !== JSON.stringify(context)) return
      setItems(candidates); setStates(statuses)
      if (!candidates.length) setMessage(zh ? '当前任务未匹配此记录的服务配置。请先切换到导入目录对应的项目任务，再检查；已恢复或移除的配置不会连接。' : 'No matching configuration in the current task. Select a task in the imported project and check again; removed configurations cannot connect.')
    } catch (cause) { if (token === generation.current) setMessage(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (token === generation.current) setBusy(false) }
  }
  async function open(item: PluginRegistryItem) {
    const token = ++generation.current, context = currentContext()
    setBusy(true); setMessage('')
    try {
      const registry = await window.agentDesk.scanPluginRegistry(context.id)
      if (token !== generation.current || JSON.stringify(currentContext()) !== JSON.stringify(context)) return
      const exact = migrationServiceCandidates(targetPaths, registry.items, context.directories).find(candidate => candidate.path === item.path && candidate.name === item.name && candidate.sourceRoot === item.sourceRoot)
      if (!exact) throw new Error(zh ? '原服务配置或项目已变化，请重新检查。' : 'The original service configuration or project changed. Check again.')
      const store = useStore.getState()
      store.selectPluginRegistryItem(exact.id); store.setShowSettings(false); store.setView('list'); store.setExperienceMode('studio'); store.setStudioSurface('session')
      await store.openPluginRegistryPanel()
    } catch (cause) { if (token === generation.current) setMessage(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (token === generation.current) setBusy(false) }
  }
  const labels: Record<McpOAuthState['status'], string> = zh
    ? { connected: '已授权', disconnected: '未连接账号', authorization_required: '需要重新授权', unsupported: '需人工检查进程环境配置', ready: '等待授权', authorizing: '等待浏览器授权', error: '需要检查连接' }
    : { connected: 'Authorized', disconnected: 'No account connected', authorization_required: 'Reauthorization required', unsupported: 'Review process environment configuration', ready: 'Ready to authorize', authorizing: 'Waiting for browser consent', error: 'Review connection' }
  return <section className="migration-service-followup">
    <p className="settings-hint">{zh ? '导入不会转移凭据。检查此记录关联的当前 MCP 配置，再按服务要求补充授权；本地进程或静态密钥服务需要人工配置。' : 'Credentials are not imported. Review the current MCP configuration associated with this record, then authorize its services. Local processes and static-key services require manual configuration.'}</p>
    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void inspect()}>{zh ? '查看服务连接' : 'Review service connections'}</button>
    {message && <p role="status">{message}</p>}
    {items.map(item => <div className="migration-service-row" key={item.id}><div><strong>{item.name}</strong><small>{states[item.id] ? labels[states[item.id]] : zh ? '先批准内容并启用，再检查授权' : 'Approve and enable before checking authorization'}</small><code>{item.path}</code></div><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void open(item)}>{zh ? '授权与配置' : 'Authorization and configuration'}</button></div>)}
  </section>
}
