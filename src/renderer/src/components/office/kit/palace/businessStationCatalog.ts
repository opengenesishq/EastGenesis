import type { PalacePoint } from './palaceWorldLayout'

export type BusinessHallRole = 'assistant' | 'project' | 'video' | 'custom'
export type BusinessStationAction = 'new_task' | 'results' | 'surface'

export interface BusinessStationSpec {
  id: string
  role: BusinessHallRole
  anchor: string
  label: string
  purpose: string
  offset: PalacePoint
  capabilities: string[]
  action: BusinessStationAction
}

const STATION_OFFSETS: readonly PalacePoint[] = [[-5.2, 1.2, 1.4], [5.2, 1.2, 1.4], [-5.2, 1.2, -1.4], [5.2, 1.2, -1.4], [0, 1.2, -2.2]]

const ROLE_STATIONS: Record<BusinessHallRole, readonly [string, string, string, string][]> = {
  assistant: [['intake_desk', '接入案', '目标输入与会话上下文', 'new_task'], ['conversation_workbench', '对话案', '当前会话与任务交互', 'surface'], ['tool_receipt', '工具回执案', '工具调用与权限回执', 'results'], ['personal_artifact', '个人成果案', '个人 Artifact 与交付', 'results']],
  project: [['workitem_board', '工单板', 'WorkItem、依赖和状态', 'surface'], ['code_workbench', '代码案', '代码工作区与变更', 'surface'], ['diff_review', '差异审案', 'Diff、审查和验收', 'surface'], ['test_receipt', '测试回执案', '测试结果和证据', 'results'], ['project_artifact', '项目成果案', '项目 Artifact 与交付', 'results']],
  video: [['script_desk', '脚本案', '脚本和生产目标', 'new_task'], ['storyboard_table', '分镜案', '分镜、连续性和素材', 'surface'], ['preview_stage', '预览台', '渲染预览与媒体任务', 'surface'], ['review_desk', '交付审案', '媒体验收和交付', 'results'], ['media_artifact', '媒体成果案', '媒体 Artifact 与交付', 'results']],
  custom: [['custom_intake', '业务接入案', '自定义业务目标输入', 'new_task'], ['custom_workitem', '业务工单案', '自定义 WorkItem', 'surface'], ['custom_review', '业务审案', '自定义验收与证据', 'results'], ['custom_delivery', '业务交付案', '自定义交付回执', 'results']]
}

export const BUSINESS_STATIONS: readonly BusinessStationSpec[] = (Object.entries(ROLE_STATIONS) as [BusinessHallRole, typeof ROLE_STATIONS[BusinessHallRole]][]).flatMap(([role, entries]) => entries.map(([id, label, purpose, action], index) => ({
  id: `${role}_${id}`, role, anchor: `${role.toUpperCase()}_${id.toUpperCase()}`, label, purpose, offset: STATION_OFFSETS[index], capabilities: [purpose, '真实业务线投影', '可返回 CaoGen 工作面'], action: action as BusinessStationAction
})))

export function businessStationsForRole(role: BusinessHallRole): readonly BusinessStationSpec[] {
  return BUSINESS_STATIONS.filter((station) => station.role === role)
}

export function businessRoleForVariant(variant?: string): BusinessHallRole {
  if (variant === 'assistant' || variant === 'project' || variant === 'video') return variant
  return 'custom'
}
