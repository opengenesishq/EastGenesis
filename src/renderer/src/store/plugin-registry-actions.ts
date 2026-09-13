import type { StoreApi } from 'zustand'
import type { PluginRegistryItem, SubagentDispatchResult } from '../../../shared/types'
import type { AppStore } from '../store'
import { requireMcpProbeResults } from './task-recovery-actions'

type SetState = StoreApi<AppStore>['setState']
type GetState = StoreApi<AppStore>['getState']

export interface PluginRegistryActions {
  openPluginRegistryPanel(): Promise<void>
  closePluginRegistryPanel(): void
  refreshPluginRegistryPanel(): Promise<void>
  probeMcpRuntime(items: PluginRegistryItem[]): Promise<void>
  installPluginFromLocal(): Promise<void>
  uninstallManagedPlugin(item: PluginRegistryItem): Promise<void>
  loadPluginRegistryForSlash(): Promise<void>
  selectPluginRegistryItem(id: string): void
  revealPluginRegistryItem(item: PluginRegistryItem): Promise<void>
  togglePluginRegistryItem(item: PluginRegistryItem, enabled: boolean): Promise<void>
  approvePluginRegistryItem(item: PluginRegistryItem): Promise<void>
  sendPluginRegistryItemToAgent(item: PluginRegistryItem): Promise<void>
  dispatchPluginAgent(item: PluginRegistryItem): Promise<void>
}

export function createPluginRegistryActions(set: SetState, get: GetState): PluginRegistryActions {
  return {
    async openPluginRegistryPanel() { get().openPanel('pluginRegistry') },
    closePluginRegistryPanel() { get().closePanel() },
    async refreshPluginRegistryPanel() { await loadPluginRegistry(set, get, false) },
    async probeMcpRuntime(items) { await probeMcpRuntime(set, get, items) },
    async installPluginFromLocal() { await installPluginFromLocal(set, get) },
    async uninstallManagedPlugin(item) { await uninstallManagedPlugin(set, get, item) },
    async loadPluginRegistryForSlash() { await loadPluginRegistry(set, get, true) },
    selectPluginRegistryItem(id) {
      set((state) => ({ workbench: { ...state.workbench, selectedPluginRegistryItemId: id } }))
    },
    async revealPluginRegistryItem(item) { await revealPluginRegistryItem(set, get, item) },
    async togglePluginRegistryItem(item, enabled) { await togglePluginRegistryItem(set, get, item, enabled) },
    async approvePluginRegistryItem(item) { await approvePluginRegistryItem(set, get, item) },
    async sendPluginRegistryItemToAgent(item) { await sendPluginRegistryItemToAgent(set, get, item) },
    async dispatchPluginAgent(item) { await dispatchPluginAgent(set, get, item) }
  }
}

async function loadPluginRegistry(set: SetState, get: GetState, skipIfLoading: boolean): Promise<void> {
  if (skipIfLoading && get().workbench.pluginRegistryLoading) return
  const sessionId = get().activeId ?? undefined
  set((state) => ({
    workbench: {
      ...state.workbench,
      pluginRegistryLoading: true,
      pluginRegistryError: undefined,
      ...(skipIfLoading ? {} : { pluginRegistryMessage: undefined })
    }
  }))
  try {
    const pluginRegistry = await window.agentDesk.scanPluginRegistry(sessionId)
    set((state) => ({
      workbench: {
        ...state.workbench,
        pluginRegistry,
        pluginRegistryLoading: false,
        pluginRegistryError: undefined,
        selectedPluginRegistryItemId: retainedSelection(state, pluginRegistry.items)
      }
    }))
  } catch (error) {
    setPluginError(set, error, { pluginRegistryLoading: false })
  }
}

function retainedSelection(state: AppStore, items: PluginRegistryItem[]): string | undefined {
  const selected = state.workbench.selectedPluginRegistryItemId
  return selected && items.some((item) => item.id === selected) ? selected : items[0]?.id
}

async function probeMcpRuntime(set: SetState, get: GetState, items: PluginRegistryItem[]): Promise<void> {
  const sessionId = get().activeId ?? undefined
  const candidates = items.filter((item) => item.kind === 'mcp' && item.enabled && item.trust.status === 'approved')
  if (candidates.length === 0) {
    setPluginError(set, '没有已批准且已启用的 MCP 可供探测')
    return
  }
  set((state) => ({ workbench: { ...state.workbench, mcpProbing: true, pluginRegistryError: undefined } }))
  try {
    const results = await requireMcpProbeResults(
      await window.agentDesk.probeMcpServers(candidates, sessionId),
      get().refreshTaskSnapshots
    )
    set((state) => {
      const merged = { ...state.workbench.mcpProbeResults }
      for (const result of results) merged[result.id] = result
      const okCount = results.filter((result) => result.ok).length
      return { workbench: {
        ...state.workbench,
        mcpProbing: false,
        mcpProbeResults: merged,
        pluginRegistryMessage: `MCP 探测完成:${okCount}/${results.length} 连通`
      } }
    })
  } catch (error) {
    setPluginError(set, error, { mcpProbing: false })
  }
}

async function installPluginFromLocal(set: SetState, get: GetState): Promise<void> {
  clearPluginFeedback(set)
  try {
    const result = await window.agentDesk.installLocalPlugin()
    if (result.effectStatus === 'waiting_reconciliation') await get().refreshTaskSnapshots()
    if (!result.ok) {
      if (result.error !== 'canceled') setPluginError(set, result.error)
      return
    }
    setPluginMessage(set, `已安装 ${result.name}(${result.installedPath})`)
    await get().refreshPluginRegistryPanel()
  } catch (error) {
    setPluginError(set, error)
  }
}

async function uninstallManagedPlugin(set: SetState, get: GetState, item: PluginRegistryItem): Promise<void> {
  clearPluginFeedback(set)
  try {
    const result = await window.agentDesk.uninstallPlugin(item.path)
    if (result.effectStatus === 'waiting_reconciliation') await get().refreshTaskSnapshots()
    if (!result.ok) {
      setPluginError(set, result.error)
      return
    }
    setPluginMessage(set, `已卸载 ${item.name},可从回收站恢复(${result.trashedTo})`)
    await get().refreshPluginRegistryPanel()
  } catch (error) {
    setPluginError(set, error)
  }
}

async function revealPluginRegistryItem(set: SetState, get: GetState, item: PluginRegistryItem): Promise<void> {
  const sessionId = get().activeId ?? undefined
  clearPluginFeedback(set, item.id)
  const result = await window.agentDesk.revealPluginRegistryItem(item.path, sessionId)
  set((state) => ({ workbench: {
    ...state.workbench,
    pluginRegistryMessage: result.ok ? `已定位 ${item.name}` : undefined,
    pluginRegistryError: result.ok ? undefined : result.error
  } }))
}

async function togglePluginRegistryItem(
  set: SetState,
  get: GetState,
  item: PluginRegistryItem,
  enabled: boolean
): Promise<void> {
  const sessionId = get().activeId ?? undefined
  clearPluginFeedback(set, item.id)
  try {
    const result = await window.agentDesk.setPluginRegistryItemEnabled(item, enabled, sessionId)
    if (!result.ok || !result.item) {
      setPluginError(set, result.error || '插件状态更新失败')
      return
    }
    updatePluginRegistryItem(set, result.item, `${result.item.name} 已${result.item.enabled ? '启用' : '停用'}`, true)
  } catch (error) {
    setPluginError(set, error)
  }
}

async function approvePluginRegistryItem(set: SetState, get: GetState, item: PluginRegistryItem): Promise<void> {
  const sessionId = get().activeId ?? undefined
  clearPluginFeedback(set, item.id)
  try {
    const result = await window.agentDesk.approvePluginRegistryItem(item, sessionId)
    if (!result.ok || !result.item) {
      setPluginError(set, result.error || '批准失败')
      return
    }
    updatePluginRegistryItem(set, result.item, `${result.item.name} 已绑定当前内容摘要和能力清单`)
  } catch (error) {
    setPluginError(set, error)
  }
}

async function sendPluginRegistryItemToAgent(set: SetState, get: GetState, item: PluginRegistryItem): Promise<void> {
  const sessionId = get().activeId
  if (!sessionId) {
    setPluginError(set, '请先选择一个会话')
    return
  }
  if (!trustedAndEnabled(item)) {
    clearPluginFeedback(set, item.id)
    setPluginError(set, '该插件条目未批准或已停用，请先批准当前内容')
    return
  }
  clearPluginFeedback(set, item.id)
  try {
    const trustedItem = await authorizePluginItem(item, sessionId)
    await get().sendMessage(pluginRegistryItemPrompt(trustedItem))
    setPluginMessage(set, `已把 ${item.name} 发给当前 Agent`)
  } catch (error) {
    setPluginError(set, error)
  }
}

async function dispatchPluginAgent(set: SetState, get: GetState, item: PluginRegistryItem): Promise<void> {
  const error = pluginAgentPreflightError(item, get().activeId)
  if (error) {
    clearPluginFeedback(set, item.id)
    setPluginError(set, error)
    return
  }
  const parentId = get().activeId as string
  clearPluginFeedback(set, item.id)
  try {
    const trustedItem = await authorizePluginItem(item, parentId)
    const result = await get().dispatchSubagents({
      tasks: [{
        id: pluginRegistryAgentTaskId(trustedItem),
        role: trustedItem.name,
        title: `${trustedItem.name} 子 Agent`,
        prompt: pluginRegistryAgentDispatchPrompt(trustedItem)
      }]
    })
    setPluginDispatchResult(set, item, result)
  } catch (cause) {
    setPluginError(set, cause)
  }
}

function pluginAgentPreflightError(item: PluginRegistryItem, parentId: string | null): string | undefined {
  if (item.kind !== 'agent') return '只有 Agent 定义可以派发为子 Agent'
  if (!trustedAndEnabled(item)) return '该 Agent 定义未批准或已停用，请先批准当前内容'
  if (!parentId) return '请先选择一个父会话'
  return undefined
}

async function authorizePluginItem(item: PluginRegistryItem, sessionId: string): Promise<PluginRegistryItem> {
  const result = await window.agentDesk.authorizePluginRegistryItem(item, sessionId)
  if (!result.ok || !result.item) throw new Error(result.error || '插件信任校验失败')
  return result.item
}

function updatePluginRegistryItem(
  set: SetState,
  updatedItem: PluginRegistryItem,
  message: string,
  strictIdentity = false
): void {
  set((state) => ({ workbench: {
    ...state.workbench,
    pluginRegistry: state.workbench.pluginRegistry ? {
      ...state.workbench.pluginRegistry,
      items: state.workbench.pluginRegistry.items.map((candidate) =>
        matchesPluginItem(candidate, updatedItem, strictIdentity) ? updatedItem : candidate)
    } : state.workbench.pluginRegistry,
    selectedPluginRegistryItemId: updatedItem.id,
    pluginRegistryMessage: message,
    pluginRegistryError: undefined
  } }))
}

function matchesPluginItem(left: PluginRegistryItem, right: PluginRegistryItem, strict: boolean): boolean {
  return strict
    ? left.id === right.id && left.kind === right.kind && left.sourceRoot === right.sourceRoot &&
      left.path === right.path && left.name === right.name
    : left.id === right.id
}

function setPluginDispatchResult(
  set: SetState,
  item: PluginRegistryItem,
  result: SubagentDispatchResult | undefined
): void {
  set((state) => ({ workbench: {
    ...state.workbench,
    lastSubagentDispatch: result ?? state.workbench.lastSubagentDispatch,
    pluginRegistryMessage: result ? `已派发 ${item.name} 子 Agent` : undefined,
    pluginRegistryError: result ? undefined : '子 Agent 派发失败'
  } }))
}

function clearPluginFeedback(set: SetState, selectedId?: string): void {
  set((state) => ({ workbench: {
    ...state.workbench,
    ...(selectedId ? { selectedPluginRegistryItemId: selectedId } : {}),
    pluginRegistryError: undefined,
    pluginRegistryMessage: undefined
  } }))
}

function setPluginMessage(set: SetState, message: string): void {
  set((state) => ({ workbench: { ...state.workbench, pluginRegistryMessage: message, pluginRegistryError: undefined } }))
}

function setPluginError(
  set: SetState,
  error: unknown,
  patch: { pluginRegistryLoading?: boolean; mcpProbing?: boolean } = {}
): void {
  set((state) => ({ workbench: {
    ...state.workbench,
    ...patch,
    pluginRegistryError: error instanceof Error ? error.message : String(error),
    pluginRegistryMessage: undefined
  } }))
}

function trustedAndEnabled(item: PluginRegistryItem): boolean {
  return item.enabled && item.trust.status === 'approved'
}

function pluginRegistryItemPrompt(item: PluginRegistryItem): string {
  const labels = { plugin: '插件包', skill: 'Skill', agent: 'Agent 定义', mcp: 'MCP 服务' } as const
  const hints = {
    plugin: '这是一个插件包容器。先查看该目录下的 .caogen-plugin/plugin.json、skills/、agents/、mcp/ 等子资源,再选择最适合当前目标的能力使用。',
    skill: '如果需要细节,先读取该目录下的 SKILL.md,再按其中的触发条件和步骤执行。',
    agent: '如果需要细节,先读取这个 Agent 定义文件,再判断是否应该按它的角色拆分或执行任务。',
    mcp: '先判断当前会话是否已经暴露对应 MCP 工具;如果没有可调用工具,不要假装调用成功,请说明需要启用或配置该 MCP。'
  } as const
  return [
    `请在当前任务中合理使用这个 ${labels[item.kind]},但只在它确实适合当前目标时使用。`, '',
    `名称: ${item.name}`, `类型: ${item.kind}`, `状态: ${item.enabled ? '已启用' : '未启用或不可用'}`,
    `内容摘要: ${item.contentDigest || 'unavailable'}`, `来源根目录: ${item.sourceRoot}`, `路径: ${item.path}`,
    `摘要: ${item.summary || '(无摘要)'}`, '', hints[item.kind],
    '使用前请先核对实际文件/工具状态;不要仅凭名称推断能力。'
  ].join('\n')
}

function pluginRegistryAgentTaskId(item: PluginRegistryItem): string {
  const slug = item.name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36)
  return slug || 'plugin-agent'
}

function pluginRegistryAgentDispatchPrompt(item: PluginRegistryItem): string {
  return [
    `你将作为子 Agent「${item.name}」参与当前父会话任务。`, '', '请先核对你的 Agent 定义文件,再执行工作:',
    `定义路径: ${item.path}`, `来源根目录: ${item.sourceRoot}`, `摘要: ${item.summary || '(无摘要)'}`,
    `当前扫描状态: ${item.enabled ? '已启用' : '未启用或不可用'}`, '', '工作要求:',
    '1. 读取并遵守该 Agent 定义文件中的角色、边界和输出格式。',
    '2. 围绕父会话当前目标推进一个可验证的子任务;如果上下文不足,先从仓库中的 STATUS.md、docs/PRODUCT-REQUIREMENTS.md、docs/PRODUCT-TECHNICAL-REQUIREMENTS.md 或相关源码提取事实。',
    '3. 不要假装具备定义文件没有提供的工具或权限;遇到缺口要明确说明。',
    '4. 产出应包含你检查过的证据、做出的修改或建议、以及可运行的验证命令。'
  ].join('\n')
}
