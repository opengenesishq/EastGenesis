import type { PalacePoint } from './palaceWorldLayout'

export type CommandHallStationId =
  | 'command_desk'
  | 'plan_sandbox'
  | 'approval_desk'
  | 'evidence_archive'
  | 'recovery_console'
  | 'operations_console'

export type CommandHallStationAction = 'command' | 'new_task' | 'approval' | 'results' | 'recovery' | 'incidents'

export interface CommandHallStationSpec {
  id: CommandHallStationId
  anchor: string
  label: string
  purpose: string
  position: PalacePoint
  capabilities: string[]
  action: CommandHallStationAction
}

/** The six functional stations in HALL_main. Each station is a projection of an existing CaoGen surface. */
export const COMMAND_HALL_STATIONS: readonly CommandHallStationSpec[] = [
  { id: 'command_desk', anchor: 'COMMAND_DESK', label: '总控案', purpose: '查看全局目标并提交自然语言任务', position: [0, 2.4, -14], capabilities: ['目标总览', '自然语言指令', '召集议政'], action: 'command' },
  { id: 'plan_sandbox', anchor: 'STATUS_PLAN', label: '规划沙盘', purpose: '复核 WorkItem 依赖、分派和路由建议', position: [-6, 2.4, -12], capabilities: ['WorkItem 依赖', '分派复核', '路由建议'], action: 'new_task' },
  { id: 'approval_desk', anchor: 'STATUS_APPROVAL', label: '审批案', purpose: '处理权限、外部 Effect 和拒绝请求', position: [6, 2.4, -12], capabilities: ['权限复核', 'Effect 审批', '拒绝处理'], action: 'approval' },
  { id: 'evidence_archive', anchor: 'STATUS_EVIDENCE', label: '证据阁', purpose: '查看 Artifact、Evidence、Acceptance 和交付', position: [-8, 2.4, -14], capabilities: ['成果索引', '证据索引', '验收与交付'], action: 'results' },
  { id: 'recovery_console', anchor: 'STATUS_RECOVERY', label: '恢复台', purpose: '处理对账、重试、续跑和回滚复核', position: [6, 2.4, -16], capabilities: ['对账', '重试与续跑', '回滚复核'], action: 'recovery' },
  { id: 'operations_console', anchor: 'STATUS_ROUTE', label: '路由台', purpose: '查看 Provider、模型路由、预算和故障转移', position: [8, 2.4, -14], capabilities: ['Provider 健康', '模型路由', '预算与故障转移'], action: 'incidents' }
]

export function commandHallStationById(id: CommandHallStationId): CommandHallStationSpec | undefined {
  return COMMAND_HALL_STATIONS.find((station) => station.id === id)
}
