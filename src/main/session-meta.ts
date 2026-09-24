import { randomUUID } from 'node:crypto'
import type {
  CaoGenDriveMode,
  EngineKind,
  PermissionModeId,
  SessionMeta,
  SessionRoutingScope,
  TaskStrategy,
  UsageTotals
} from '../shared/types'
import type { SideChatBinding } from '../shared/side-chat-types'

function normalizeBudget(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
}

export function newSessionMeta(opts: {
  cwd: string
  driveMode?: CaoGenDriveMode
  parentSessionId?: string
  orchestrationId?: string
  childTaskId?: string
  childRole?: string
  isolated?: boolean
  sourceCwd?: string
  projectId?: string
  unassigned?: boolean
  repoRoot?: string
  worktreePath?: string
  branch?: string
  baseBranch?: string | null
  baseSha?: string
  worktreeState?: 'active' | 'removed'
  model: string
  providerId: string
  routingScope?: SessionRoutingScope
  budgetUsd?: number
  resumeSessionAt?: string
  engine?: EngineKind
  taskStrategy: TaskStrategy
  /**
   * 权限模式（派生只读）。
   * 收编后此字段由 derivePermissionModeFromStrategy(taskStrategy) 派生，
   * 不再接受用户或模型直接设置。调用方应使用 derivePermissionModeFromStrategy。
   */
  permissionMode: PermissionModeId
  title?: string
  sideChat?: SideChatBinding
}): SessionMeta {
  return {
    id: randomUUID(),
    sideChat: opts.sideChat,
    title: opts.title || '新会话',
    cwd: opts.cwd,
    driveMode: opts.driveMode,
    parentSessionId: opts.parentSessionId,
    orchestrationId: opts.orchestrationId,
    childTaskId: opts.childTaskId,
    childRole: opts.childRole,
    isolated: opts.isolated,
    sourceCwd: opts.sourceCwd,
    projectId: opts.projectId,
    unassigned: opts.unassigned,
    repoRoot: opts.repoRoot,
    worktreePath: opts.worktreePath,
    branch: opts.branch,
    baseBranch: opts.baseBranch,
    baseSha: opts.baseSha,
    worktreeState: opts.worktreeState,
    model: opts.model,
    providerId: opts.providerId,
    routingScope: opts.routingScope,
    budgetUsd: normalizeBudget(opts.budgetUsd),
    resumeSessionAt: opts.resumeSessionAt,
    engine: opts.engine,
    taskStrategy: opts.taskStrategy,
    permissionMode: opts.permissionMode,
    status: 'starting',
    costUsd: 0,
    usage: emptyUsage(),
    contextTokens: 0,
    contextPressure: 'normal',
    createdAt: Date.now()
  }
}
