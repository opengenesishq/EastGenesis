import type { CaoGenDriveMode, PermissionModeId, SessionMeta, TaskStrategy } from '../../shared/types'
import { normalizeToolName } from './tool-idempotency'

export const DEFAULT_TASK_STRATEGY: TaskStrategy = 'execute'

const VIEW_TOOLS = new Set([
  'inspect_media', 'inspect_office_artifact', 'plan_office_revision',
  'read_file',
  'view',
  'list_dir',
  'search_symbol',
  'search_code',
  'find_file',
  'get_dependencies',
  'git_status',
  'git_diff',
  'memory_search',
  'web_fetch',
  'web_search',
  'browser_wait_for',
  'browser_read',
  'browser_screenshot',
  'browser_automation_status',
  'gui_list_windows',
  'gui_screenshot',
  'list_skills',
  'load_skill'
])

const PLAN_TOOLS = new Set([
  ...VIEW_TOOLS,
  'task_decompose',
  'genesis_orchestrate',
  'route_model',
  'draft_skill'
])

export interface TaskStrategyToolDecision {
  allow: boolean
  message?: string
}

export function isTaskStrategy(value: unknown): value is TaskStrategy {
  return value === 'view' || value === 'plan' || value === 'execute'
}

export function normalizeTaskStrategy(value: unknown): TaskStrategy {
  return isTaskStrategy(value) ? value : DEFAULT_TASK_STRATEGY
}

export function requireTaskStrategy(value: unknown): TaskStrategy {
  if (!isTaskStrategy(value)) throw new Error('任务策略必须是 view、plan 或 execute')
  return value
}

export function requireExecuteTaskStrategy(meta: SessionMeta, action: string): void {
  if (meta.taskStrategy === 'execute') return
  const label = meta.taskStrategy === 'view' ? '查看' : '规划'
  throw new Error(`${label}策略不允许${action}；请先明确切换到执行。`)
}

export function requirePlanningTaskStrategy(meta: SessionMeta, action: string): void {
  if (meta.taskStrategy !== 'view') return
  throw new Error(`查看策略不允许${action}；请先切换到规划或执行。`)
}

export function decideTaskStrategyTool(
  strategyInput: unknown,
  toolName: string,
  toolInput: unknown
): TaskStrategyToolDecision {
  const strategy = normalizeTaskStrategy(strategyInput)
  if (strategy === 'execute') return { allow: true }

  const name = normalizeToolName(toolName)
  const allowed = strategy === 'view' ? VIEW_TOOLS : PLAN_TOOLS
  if (allowed.has(name)) return { allow: true }
  if (strategy === 'plan' && isDryRunSearchReplace(name, toolInput)) return { allow: true }

  return {
    allow: false,
    message: strategy === 'view'
      ? '查看策略只允许读取和分析，已阻止写入、命令、外部创建和其他持久副作用。'
      : '规划策略只允许读取和生成可审查计划，批准并切换到执行前不得运行计划步骤。'
  }
}

export function taskStrategySystemPrompt(strategyInput: unknown): string {
  const strategy = normalizeTaskStrategy(strategyInput)
  if (strategy === 'view') {
    return '当前任务策略是“查看”。只能读取、搜索和分析；不得修改文件、执行命令、操作桌面、调用有副作用的连接器、创建外部对象或启动子任务。'
  }
  if (strategy === 'plan') {
    return '当前任务策略是“规划”。只能读取和分析，并输出可审查的步骤、依赖、预计产物、数据外发、成本、风险和验收条件；用户批准并切换到“执行”前，不得运行计划步骤或产生持久副作用。'
  }
  return '当前任务策略是“执行”。可以在权限、预算、隐私、Effect 对账和验收合同范围内使用工具完成任务。'
}

export function taskStrategySystemAppend(
  strategy: unknown,
  ...parts: Array<string | null | undefined>
): string {
  return [parts[0], taskStrategySystemPrompt(strategy), ...parts.slice(1)]
    .filter((part): part is string => Boolean(part?.trim()))
    .join('\n\n')
}

export function updateTaskStrategyMeta(
  meta: SessionMeta,
  strategy: TaskStrategy,
  emit: (meta: SessionMeta) => void
): void {
  meta.taskStrategy = strategy
  meta.permissionMode = derivePermissionModeFromStrategy(strategy)
  emit({ ...meta })
}

/**
 * TaskStrategy → PermissionMode 派生函数（单一来源）。
 *
 * 收编后 SessionMeta.permissionMode 不再接受用户/模型直接设置，
 * 统一由此函数从 TaskStrategy 派生。
 *
 * @param strategy 当前任务策略
 * @param driveMode 可选，DriveMode 执行档位。P0 不参与派生（Q-6 决议），
 *                  保留参数签名供 P2 评估"execute 是否受 DriveMode 调节"时使用。
 * @returns 派生的 PermissionModeId
 *
 * 映射表(P0-2):
 *   view    → default    (preflight 已拦截所有非只读工具，default 对只读放行)
 *   plan    → default    (preflight 已拦截写操作，default 对只读+dry_run 放行)
 *   execute → acceptEdits(编辑类自动放行，高危逐次询问)
 */
export function derivePermissionModeFromStrategy(
  strategy: TaskStrategy,
  driveMode?: CaoGenDriveMode
): PermissionModeId {
  // P0: driveMode 不参与派生（Q-6 决议: execute 统一 acceptEdits，
  // DriveMode 风险控制走 permissionDenylistRules，不改 permissionMode）
  void driveMode // 显式标注 P0 不使用，避免 lint 警告

  if (strategy === 'execute') return 'acceptEdits'
  // view 和 plan 均派生为 default
  return 'default'
}

export interface PermissionModeMigrationResult {
  /** 派生后的 permissionMode（总是由 taskStrategy 计算） */
  mode: PermissionModeId
  /** 旧值是否为用户手设的 bypassPermissions（被降级为 acceptEdits） */
  downgradedFromBypass: boolean
  /** 旧值是否为已废弃的 'plan'（被重新派生覆盖） */
  migratedFromPlan: boolean
}

/**
 * 老会话恢复时，根据旧 permissionMode 和当前 taskStrategy 计算迁移结果。
 *
 * 迁移规则(Q-5 决议):
 *   - 始终按 taskStrategy 重新派生，旧值不保留
 *   - bypassPermissions → 派生值（若 strategy=execute 则 acceptEdits），标记 downgradedFromBypass
 *   - 'plan' → 派生值，标记 migratedFromPlan
 *   - 其他值(default/acceptEdits) → 派生值（可能与旧值相同），不标记
 *
 * downgradedFromBypass 标记供 P1-3 顶部一次性提示使用。
 */
export function migrateLegacyPermissionMode(
  oldMode: PermissionModeId | undefined,
  strategy: TaskStrategy
): PermissionModeMigrationResult {
  const mode = derivePermissionModeFromStrategy(strategy)
  return {
    mode,
    downgradedFromBypass: oldMode === 'bypassPermissions',
    migratedFromPlan: oldMode === 'plan'
  }
}

function isDryRunSearchReplace(name: string, input: unknown): boolean {
  return name === 'search_replace' && Boolean(
    input && typeof input === 'object' && !Array.isArray(input) &&
    (input as Record<string, unknown>).dry_run === true
  )
}
