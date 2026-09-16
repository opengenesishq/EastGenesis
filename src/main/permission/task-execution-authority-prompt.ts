import type { SessionMeta } from '../../shared/types'
import { TaskExecutionAuthorityStore } from './task-execution-authority-store'

export function taskExecutionAuthoritySystemPrompt(meta: SessionMeta, root: string): string {
  try {
    const view = new TaskExecutionAuthorityStore(root).get(meta)
    if (view.status === 'legacy') return ''
    if (!view.available) return '当前任务的正式执行授权缺失、撤销或已失效。仅可读取和分析；独立准备区需遵守另行有效的准备授权。不得借助命令、桌面、连接器、委派或旧批准继续修改正式文件。需要正式执行时请用户在当前任务的“Agent 文件与命令授权”中重新授权。'
    return `当前任务的 Agent 正式执行权限已限定（版本 ${view.revision}）。真实根目录：${view.directory}。允许的相对路径：${view.pathPatterns.join('、') || '无'}。允许的文件工具：${view.allowedWriteTools.join('、') || '无'}。允许的完整命令（逐字匹配）：${view.allowedCommandPatterns.length ? view.allowedCommandPatterns.join('、') : '无'}。可读取资料；只有这些文件工具可在上述目录与路径内修改，或使用完全匹配上述命令的 bash。命令授权独立于文件路径授权，其他命令、桌面、连接器和委派不在此范围。独立准备区依照另行有效的准备授权。全局拒绝规则和具体动作审批仍然生效；执行前会核对当前授权，撤销或版本变化后停止原操作。`
  } catch { return '当前任务文件授权无法核验。停止正式文件写入，直到用户重新打开任务并核对授权。' }
}
