import type { SessionMeta } from '../../shared/types'
import { TaskExecutionAuthorityStore } from './task-execution-authority-store'

export function taskExecutionAuthoritySystemPrompt(meta: SessionMeta, root: string): string {
  try {
    const view = new TaskExecutionAuthorityStore(root).get(meta)
    if (view.status === 'legacy') return ''
    if (!view.available) return '当前任务的正式文件执行授权缺失、撤销或已失效。仅可读取和分析；独立准备区需遵守另行有效的准备授权。不得借助命令、桌面、连接器、委派或旧批准继续修改正式文件。需要正式修改时请用户在当前任务的“Agent 文件修改范围”中重新授权。'
    return `当前任务的 Agent 正式文件修改权限已限定（版本 ${view.revision}）。真实根目录：${view.directory}。允许的相对路径：${view.pathPatterns.join('、')}。允许的工具：${view.allowedWriteTools.join('、')}。可读取资料；只有这些文件工具可在上述目录与路径内修改，其他路径、命令、桌面、连接器和委派不在此范围。独立准备区依照另行有效的准备授权。全局拒绝规则和具体动作审批仍然生效；每次落盘会核对当前授权，撤销或版本变化后停止原操作。`
  } catch { return '当前任务文件授权无法核验。停止正式文件写入，直到用户重新打开任务并核对授权。' }
}
