import type { ComputerHistoryApi, ComputerHistoryStatus } from '../../../../shared/computer-history-types'
export function historyApi(): ComputerHistoryApi { return window.agentDesk as typeof window.agentDesk & ComputerHistoryApi }
export function historyError(error: unknown, zh: boolean): string {
  if (!zh) return 'The operation could not finish. Refresh and check the history permissions, source selection, and local storage.'
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '').slice(0, 400) : '操作未完成，请刷新后重试。'
}
export function historyStatus(status: ComputerHistoryStatus, zh: boolean): string {
  const labels: Record<ComputerHistoryStatus, [string, string]> = {
    disabled: ['已关闭', 'Off'], paused: ['已暂停', 'Paused'], waiting: ['等待允许应用处于前台', 'Waiting for an allowed foreground app'],
    recording: ['正在记录允许应用的标题', 'Recording allowed app titles'], 'permission-required': ['需要 macOS 辅助功能权限', 'macOS Accessibility permission needed'],
    unsupported: ['当前仅支持 macOS 采集', 'Collection is available on macOS only'], temporary: ['临时工作空间不采集电脑历史', 'Collection is unavailable in temporary workspaces'], error: ['采集已停止，需要处理', 'Collection stopped; attention needed']
  }
  return labels[status][zh ? 0 : 1]
}
