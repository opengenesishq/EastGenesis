import { createElement, lazy } from 'react'
import type * as React from 'react'
import type { HeaderIconName } from '../ChatHeaderIcons'
import type { PanelId, PanelOpenContext } from './panel-types'

export type { PanelId, PanelOpenContext } from './panel-types'

/**
 * 工作台面板标识符。
 *
 * 11 个面板 = 原 10 个独立面板 + StudioResultPanel（归一为 'result'）。
 * 新增面板只需在此联合类型添加一个字面量 + 在 PANEL_REGISTRY 注册。
 */
/**
 * 面板注册表条目。
 *
 * 每个面板在此注册后，WorkbenchRoot 的渲染循环自动遍历挂载，
 * store 的 openPanel/closePanel/togglePanel 自动支持。
 */
export interface PanelDefinition {
  /** 面板唯一标识 */
  id: PanelId
  /** i18n key（用于面板标题/tooltip） */
  titleKey: string
  /** DeskControlRail / 面板头图标 */
  icon: HeaderIconName
  /** 懒加载组件，首次打开才加载代码 */
  component: React.LazyExoticComponent<React.ComponentType<unknown>>
  /** 是否在切换时保持挂载（keep-alive）。Q-1 决议：全部 true */
  keepAlive: boolean
}

type PanelComponent = React.LazyExoticComponent<React.ComponentType<unknown>>

function lazyPanel(loader: () => Promise<{ default: unknown }>): PanelComponent {
  const typedLoader = loader as unknown as () => Promise<{ default: React.ComponentType<unknown> }>
  return lazy(typedLoader)
}

/**
 * openPanel 的可选上下文参数。
 *
 * 供需要运行时参数的面板使用：
 * - browser: openBrowserPanel(url?) 传递 url
 * - preview: openPreviewPanel(path?) 传递 path
 *
 * 其他面板忽略此参数。
 */
/**
 * 面板注册表：11 个面板全部注册，keepAlive 全部 true。
 *
 * preview 复用 deskFiles 标题/图标（P0 架构 Q-3 决议）。
 * worktree 复用 deskReview 标题/图标（P0 架构 Q-3 决议）。
 */
export const PANEL_REGISTRY: readonly PanelDefinition[] = [
  {
    id: 'result',
    titleKey: 'toggleDeskSummary',
    icon: 'summary',
    component: lazyPanel(() => import('./StudioResultPanel')),
    keepAlive: true
  },
  {
    id: 'diff',
    titleKey: 'deskReview',
    icon: 'review',
    component: lazyPanel(() => import('./DiffPanel')),
    keepAlive: true
  },
  {
    id: 'terminal',
    titleKey: 'deskTerminal',
    icon: 'terminal',
    component: lazyPanel(() => import('./TerminalPanel')),
    keepAlive: true
  },
  {
    id: 'browser',
    titleKey: 'deskBrowser',
    icon: 'browser',
    component: lazyPanel(() => import('./BrowserPanel')),
    keepAlive: true
  },
  {
    id: 'files',
    titleKey: 'deskFiles',
    icon: 'files',
    component: lazyPanel(() => import('./DeveloperPanel')),
    keepAlive: true
  },
  {
    id: 'preview',
    titleKey: 'deskFiles',
    icon: 'files',
    component: lazyPanel(() => import('./PreviewPanel')),
    keepAlive: true
  },
  {
    id: 'worktree',
    titleKey: 'deskReview',
    icon: 'review',
    component: lazyPanel(() => import('./WorktreePanel')),
    keepAlive: true
  },
  {
    id: 'pluginRegistry',
    titleKey: 'openDeskTools',
    icon: 'plugins',
    component: lazyPanel(() => import('./PluginRegistryPanel')),
    keepAlive: true
  },
  {
    id: 'subagent',
    titleKey: 'deskSideChat',
    icon: 'subagents',
    component: lazyPanel(() => import('./SubagentPanel')),
    keepAlive: true
  },
  {
    id: 'routine',
    titleKey: 'openDeskTools',
    icon: 'routines',
    component: lazyPanel(() => import('./RoutinePanel')),
    keepAlive: true
  },
  {
    id: 'memory',
    titleKey: 'memoryShort',
    icon: 'memory',
    component: lazyPanel(() => import('../MemoryPanel')),
    keepAlive: true
  }
] as const

/** 按 PanelId 快速查找 */
export const PANEL_MAP = Object.fromEntries(
  PANEL_REGISTRY.map((def) => [def.id, def])
) as Readonly<Record<PanelId, PanelDefinition>>
