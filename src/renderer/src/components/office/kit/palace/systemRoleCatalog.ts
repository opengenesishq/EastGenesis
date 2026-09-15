import type { PalacePoint } from './palaceWorldLayout'

/**
 * Governance projections shown in the command hall.
 *
 * These entries describe who is responsible for a concern; they do not own
 * work items, runs, progress or status. Every action is an existing office
 * navigation command that reads the canonical chain:
 * Goal -> WorkItem -> Run -> Effect -> Artifact -> Evidence -> Acceptance -> Recovery.
 */
export type SystemRoleId =
  | 'taizi'
  | 'neige'
  | 'dongchang'
  | 'xichang'
  | 'libu'
  | 'hubu'
  | 'libu_ritual'
  | 'bingbu'
  | 'xingbu'
  | 'gongbu'

export type SystemRoleActionId =
  | 'open_command_hall'
  | 'summon_council'
  | 'open_new_task'
  | 'open_incident_watch'
  | 'open_results'
  | 'open_recovery'

export interface SystemRoleAction {
  id: SystemRoleActionId
  label: string
  labelEn: string
  /** Existing canonical view/command that performs this navigation. */
  target: 'command_hall' | 'summon_council' | 'new_task' | 'incident_watch' | 'results' | 'recovery'
}

export interface SystemRoleSpec {
  id: SystemRoleId
  anchor: string
  label: string
  labelEn: string
  group: 'council' | 'oversight' | 'ministry'
  duty: string
  dutyEn: string
  /** Source of the projection; never a local role-owned ledger. */
  canonicalSource: 'HALL_main'
  projectionOnly: true
  position: PalacePoint
  cameraPosition: PalacePoint
  cameraTarget: PalacePoint
  actions: readonly SystemRoleAction[]
}

const commandHallAction: SystemRoleAction = {
  id: 'open_command_hall', label: '回到议政殿', labelEn: 'Open council hall', target: 'command_hall'
}
const summonCouncilAction: SystemRoleAction = {
  id: 'summon_council', label: '查看职责', labelEn: 'View responsibilities', target: 'summon_council'
}

/** Stable catalog for all authored central-hall governance roles. */
export const SYSTEM_ROLES: readonly SystemRoleSpec[] = [
  {
    id: 'taizi', anchor: 'ROLE_TAIZI', label: '太子', labelEn: 'Crown prince', group: 'council',
    duty: '授权代办、召集议政、确认全局意图', dutyEn: 'Authorized delegation, summoning and intent review',
    canonicalSource: 'HALL_main', projectionOnly: true, position: [0, 2.4, -15.7],
    cameraPosition: [5.1, 7.1, -20.3], cameraTarget: [0, 3.1, -15.7],
    actions: [{ id: 'open_new_task', label: '发起任务', labelEn: 'Start a task', target: 'new_task' }, summonCouncilAction, commandHallAction]
  },
  {
    id: 'neige', anchor: 'ROLE_NEIGE', label: '内阁', labelEn: 'Cabinet', group: 'council',
    duty: '理解目标、筹划依赖、协调跨业务线', dutyEn: 'Interpret goals, plan dependencies and coordinate lines',
    canonicalSource: 'HALL_main', projectionOnly: true, position: [-4.65, 2.4, -13.25],
    cameraPosition: [-0.8, 6.8, -18.7], cameraTarget: [-4.65, 3.1, -13.25], actions: [commandHallAction]
  },
  {
    id: 'dongchang', anchor: 'ROLE_DONGCHANG', label: '东厂', labelEn: 'Eastern depot', group: 'oversight',
    duty: '运行巡核、发现异常、核对 Provider 与模型路由', dutyEn: 'Inspect runs, detect incidents and check routing',
    canonicalSource: 'HALL_main', projectionOnly: true, position: [4.65, 2.4, -15.6],
    cameraPosition: [9.2, 6.8, -20.3], cameraTarget: [4.65, 3.1, -15.6],
    actions: [{ id: 'open_incident_watch', label: '进入异常巡核', labelEn: 'Open incident watch', target: 'incident_watch' }, commandHallAction]
  },
  {
    id: 'xichang', anchor: 'ROLE_XICHANG', label: '西厂', labelEn: 'Western depot', group: 'oversight',
    duty: '交叉审计、证据追踪、核验恢复边界', dutyEn: 'Cross-audit, evidence tracing and recovery-boundary review',
    canonicalSource: 'HALL_main', projectionOnly: true, position: [8.1, 2.4, -17.7],
    cameraPosition: [12.4, 7.2, -22.8], cameraTarget: [8.1, 3.1, -17.7],
    actions: [{ id: 'open_results', label: '打开证据档案', labelEn: 'Open evidence archive', target: 'results' }, { id: 'open_recovery', label: '核对恢复边界', labelEn: 'Review recovery boundary', target: 'recovery' }, commandHallAction]
  },
  {
    id: 'libu', anchor: 'ROLE_LIBU', label: '吏部', labelEn: 'Ministry of Personnel', group: 'ministry',
    duty: '人员与分派；只读取真实 Worker、WorkItem 和 Run', dutyEn: 'People and assignment from real workers, work items and runs',
    canonicalSource: 'HALL_main', projectionOnly: true, position: [-8, 2.4, -22],
    cameraPosition: [-8, 7.5, -29], cameraTarget: [-8, 3, -22], actions: [commandHallAction]
  },
  {
    id: 'hubu', anchor: 'ROLE_HUBU', label: '户部', labelEn: 'Ministry of Revenue', group: 'ministry',
    duty: '预算与资源；读取真实成本、额度和 Provider 健康', dutyEn: 'Budget and resources from real cost and provider health',
    canonicalSource: 'HALL_main', projectionOnly: true, position: [-5, 2.4, -22],
    cameraPosition: [-5, 7.5, -29], cameraTarget: [-5, 3, -22], actions: [commandHallAction]
  },
  {
    id: 'libu_ritual', anchor: 'ROLE_LIBU_RITUAL', label: '礼部', labelEn: 'Ministry of Rites', group: 'ministry',
    duty: '标准与验收；查看 Evidence、Acceptance 和交付回执', dutyEn: 'Standards and acceptance over evidence and delivery receipts',
    canonicalSource: 'HALL_main', projectionOnly: true, position: [-2, 2.4, -22],
    cameraPosition: [-2, 7.5, -29], cameraTarget: [-2, 3, -22],
    actions: [{ id: 'open_results', label: '打开成果档案', labelEn: 'Open results archive', target: 'results' }, commandHallAction]
  },
  {
    id: 'bingbu', anchor: 'ROLE_BINGBU', label: '兵部', labelEn: 'Ministry of War', group: 'ministry',
    duty: '调度与执行；观察真实 Run、路由和执行队列', dutyEn: 'Dispatch and execution over real runs and routing queues',
    canonicalSource: 'HALL_main', projectionOnly: true, position: [2, 2.4, -22],
    cameraPosition: [2, 7.5, -29], cameraTarget: [2, 3, -22], actions: [commandHallAction]
  },
  {
    id: 'xingbu', anchor: 'ROLE_XINGBU', label: '刑部', labelEn: 'Ministry of Justice', group: 'ministry',
    duty: '权限与审计；查看 Effect、审批和恢复边界', dutyEn: 'Permissions and audit over effects, approvals and recovery',
    canonicalSource: 'HALL_main', projectionOnly: true, position: [5, 2.4, -22],
    cameraPosition: [5, 7.5, -29], cameraTarget: [5, 3, -22],
    actions: [{ id: 'open_recovery', label: '打开恢复中心', labelEn: 'Open recovery center', target: 'recovery' }, commandHallAction]
  },
  {
    id: 'gongbu', anchor: 'ROLE_GONGBU', label: '工部', labelEn: 'Ministry of Works', group: 'ministry',
    duty: '工具与产物；查看 Artifact、工具链和可交付成果', dutyEn: 'Tools and artifacts over the toolchain and deliverables',
    canonicalSource: 'HALL_main', projectionOnly: true, position: [8, 2.4, -22],
    cameraPosition: [8, 7.5, -29], cameraTarget: [8, 3, -22],
    actions: [{ id: 'open_results', label: '打开成果档案', labelEn: 'Open results archive', target: 'results' }, commandHallAction]
  }
]

export function systemRoleById(id: SystemRoleId): SystemRoleSpec | undefined {
  return SYSTEM_ROLES.find((role) => role.id === id)
}
