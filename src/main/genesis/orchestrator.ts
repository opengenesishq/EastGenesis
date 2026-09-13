import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { decomposeTask } from '../agent/task-decomposer'
import { validateTaskDag } from '../agent/dag-scheduler'
import { getCaoGenDrivePolicy } from '../model/drive'
import {
  normalizeCaoGenDriveMode,
  type CaoGenDriveMode,
  type TaskDag,
  type TaskDagRole,
  type TaskDagTask,
  type ToolRiskLevel
} from '../../shared/types'
import type { CodeForgeDeliveryMode } from '../code-forge/delivery'

export const GENESIS_ORCHESTRATE_TOOL_NAME = 'genesis_orchestrate'

export const GENESIS_EXECUTION_BOUNDARY = {
  externalAgentsControlled: false,
  childSessionsCreated: 0,
  worktreesCreated: 0,
  codeForgeDeliveryExecuted: false,
  uiCreated: false,
  statement:
    'A9 Genesis v1 只生成可审查的编排与交付协议；不会真实控制外部子 Agent、不会创建 worktree、不会提交/推送/发布。'
} as const

export type GenesisOrchestrationStatus = 'planned' | 'gated'
export type GenesisIsolationMode = 'planned-isolated-worktrees'
export type GenesisValidationGateKind = 'plan-review' | 'lane-readiness' | 'verification-command' | 'delivery-readiness'

export interface GenesisOrchestrationInput {
  request: string
  cwd: string
  driveMode?: CaoGenDriveMode
  validationCommands?: string[]
  deliveryMode?: CodeForgeDeliveryMode
  maxWorkerLanes?: number
  isolationRoot?: string
  requireHumanConfirmation?: boolean
}

export interface GenesisModeStrategy {
  requestedDriveMode: CaoGenDriveMode
  effectiveDriveMode: CaoGenDriveMode
  orchestrationAllowed: boolean
  schedulerStrategy: string
  defaultPermissionMode: string
  validationDepth: string
  policySummary: string
  reason: string
}

export interface GenesisTaskPlan {
  dag: TaskDag
  layers: string[][]
  strategy: string
  reason: string
  warnings: string[]
}

export interface GenesisLaneTask {
  id: string
  title: string
  role: TaskDagRole
  dependencies: string[]
  prompt: string
}

export interface GenesisWorkerLane {
  id: string
  title: string
  role: TaskDagRole
  taskIds: string[]
  dependencies: string[]
  tasks: GenesisLaneTask[]
  status: 'planned'
  externalAgentControlled: false
}

export interface GenesisLaneIsolation {
  laneId: string
  branch: string
  worktreePath: string
  baseCwd: string
  created: false
}

export interface GenesisIsolationStrategy {
  mode: GenesisIsolationMode
  required: true
  baseCwd: string
  plannedRoot: string
  actualWorktreesCreated: false
  lanes: GenesisLaneIsolation[]
  mergePolicy: string
  cleanupPolicy: string
}

export interface GenesisValidationGate {
  id: string
  kind: GenesisValidationGateKind
  title: string
  command?: string
  required: boolean
  blocksDelivery: boolean
  status: 'planned'
}

export interface GenesisRiskReport {
  level: ToolRiskLevel
  reasons: string[]
  requiresHumanConfirmation: boolean
}

export interface GenesisHumanConfirmationPoint {
  id: string
  title: string
  reason: string
  requiredBefore: 'dispatch' | 'write' | 'verify' | 'delivery'
}

export interface GenesisDeliveryStrategy {
  tool: 'code_forge_delivery'
  requestedMode: CodeForgeDeliveryMode
  recommendedMode: Extract<CodeForgeDeliveryMode, 'report' | 'patch'>
  verificationTool: 'bash'
  verificationCommands: string[]
  requiresCleanWorktree: true
  stageAllDefault: false
  executed: false
  preconditions: string[]
  handoff: string
}

export interface GenesisExecutionReport {
  status: GenesisOrchestrationStatus
  executedActions: string[]
  notExecuted: string[]
  reusedModules: string[]
}

export interface GenesisOrchestrationReport {
  id: string
  version: 'a9-genesis-v1'
  status: GenesisOrchestrationStatus
  createdAt: number
  request: string
  cwd: string
  modeStrategy: GenesisModeStrategy
  taskPlan: GenesisTaskPlan
  workerLanes: GenesisWorkerLane[]
  isolation: GenesisIsolationStrategy
  validationGates: GenesisValidationGate[]
  risk: GenesisRiskReport
  humanConfirmationPoints: GenesisHumanConfirmationPoint[]
  deliveryStrategy: GenesisDeliveryStrategy
  truthBoundary: typeof GENESIS_EXECUTION_BOUNDARY
  executionReport: GenesisExecutionReport
  summary: string
}

export async function buildGenesisOrchestration(
  input: GenesisOrchestrationInput
): Promise<GenesisOrchestrationReport> {
  const request = input.request.replace(/\s+/g, ' ').trim()
  if (!request) throw new Error('Genesis request 不能为空')

  const id = `genesis-${randomUUID()}`
  const driveMode = normalizeCaoGenDriveMode(input.driveMode ?? 'genesis')
  const modeStrategy = buildModeStrategy(driveMode)
  const decompose = await decomposeTask({ request, cwd: input.cwd, useModel: false })
  const validation = validateTaskDag(decompose.dag)
  if (!validation.ok || !validation.layers) throw new Error(validation.error ?? 'Genesis DAG 校验失败')

  const taskPlan: GenesisTaskPlan = {
    dag: decompose.dag,
    layers: validation.layers,
    strategy: decompose.strategy,
    reason: decompose.reason,
    warnings: decompose.warnings
  }
  const workerLanes = buildWorkerLanes(decompose.dag, normalizeMaxWorkerLanes(input.maxWorkerLanes))
  const verificationCommands = inferValidationCommands(input.cwd, input.validationCommands)
  const deliveryMode = normalizeDeliveryMode(input.deliveryMode)
  const risk = assessRisk({ request, taskCount: decompose.dag.tasks.length, deliveryMode, verificationCommands })
  const humanConfirmationPoints = confirmationPoints({
    modeStrategy,
    deliveryMode,
    risk,
    force: input.requireHumanConfirmation === true
  })
  const status: GenesisOrchestrationStatus = modeStrategy.orchestrationAllowed ? 'planned' : 'gated'

  return {
    id,
    version: 'a9-genesis-v1',
    status,
    createdAt: Date.now(),
    request,
    cwd: input.cwd,
    modeStrategy,
    taskPlan,
    workerLanes,
    isolation: buildIsolationStrategy({
      id,
      cwd: input.cwd,
      isolationRoot: input.isolationRoot,
      lanes: workerLanes
    }),
    validationGates: buildValidationGates(verificationCommands),
    risk,
    humanConfirmationPoints,
    deliveryStrategy: buildDeliveryStrategy(deliveryMode, verificationCommands),
    truthBoundary: GENESIS_EXECUTION_BOUNDARY,
    executionReport: buildExecutionReport(status),
    summary: buildSummary(status, workerLanes.length, risk.level, deliveryMode)
  }
}

export function formatGenesisOrchestrationReport(report: GenesisOrchestrationReport): string {
  return JSON.stringify(report, null, 2)
}

function buildModeStrategy(driveMode: CaoGenDriveMode): GenesisModeStrategy {
  const policy = getCaoGenDrivePolicy(driveMode)
  const orchestrationAllowed = driveMode === 'command' || driveMode === 'genesis'
  return {
    requestedDriveMode: driveMode,
    effectiveDriveMode: driveMode,
    orchestrationAllowed,
    schedulerStrategy: policy.schedulerStrategy,
    defaultPermissionMode: policy.defaultPermissionMode,
    validationDepth: policy.validationDepth,
    policySummary: policy.toolPolicySummary,
    reason: orchestrationAllowed
      ? `${policy.label} 可生成 Genesis 编排协议；真实调度、写入和交付仍需后续工具与权限闸门。`
      : `${policy.label} 不应默认推动 Genesis 编排；请升级到 Command 或 Genesis 后再进入多 Agent 编排。`
  }
}

function normalizeMaxWorkerLanes(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 8
  return Math.max(1, Math.min(12, Math.floor(value)))
}

function buildWorkerLanes(dag: TaskDag, maxLanes: number): GenesisWorkerLane[] {
  const lanes: GenesisWorkerLane[] = []
  for (const task of dag.tasks) {
    let lane = lanes.find((item) => item.role === task.role && item.tasks.length < 3)
    if (!lane && lanes.length < maxLanes) {
      lane = {
        id: `lane-${lanes.length + 1}-${task.role}`,
        title: `${roleLabel(task.role)} lane`,
        role: task.role,
        taskIds: [],
        dependencies: [],
        tasks: [],
        status: 'planned',
        externalAgentControlled: false
      }
      lanes.push(lane)
    }
    const target = lane ?? leastLoadedLane(lanes)
    target.taskIds.push(task.id)
    target.tasks.push(toLaneTask(task))
    target.dependencies = unique([...target.dependencies, ...task.dependencies.filter((id) => !target.taskIds.includes(id))])
  }
  return lanes
}

function leastLoadedLane(lanes: GenesisWorkerLane[]): GenesisWorkerLane {
  const sorted = [...lanes].sort((a, b) => a.tasks.length - b.tasks.length)
  const lane = sorted[0]
  if (!lane) throw new Error('Genesis worker lane 初始化失败')
  return lane
}

function toLaneTask(task: TaskDagTask): GenesisLaneTask {
  return {
    id: task.id,
    title: task.title,
    role: task.role,
    dependencies: [...task.dependencies],
    prompt: task.prompt
  }
}

function buildIsolationStrategy(input: {
  id: string
  cwd: string
  isolationRoot?: string
  lanes: GenesisWorkerLane[]
}): GenesisIsolationStrategy {
  const shortId = input.id.replace(/^genesis-/, '').slice(0, 8)
  const plannedRoot = path.resolve(input.isolationRoot ?? path.join(tmpdir(), 'caogen-genesis-worktrees', shortId))
  return {
    mode: 'planned-isolated-worktrees',
    required: true,
    baseCwd: input.cwd,
    plannedRoot,
    actualWorktreesCreated: false,
    lanes: input.lanes.map((lane) => {
      const slug = slugify(lane.id)
      return {
        laneId: lane.id,
        branch: `caogen/genesis-${shortId}-${slug}`,
        worktreePath: path.join(plannedRoot, slug),
        baseCwd: input.cwd,
        created: false
      }
    }),
    mergePolicy: '所有 lane 必须先通过验证 gate，再由主 Agent 审查 diff；禁止未审查自动合并。',
    cleanupPolicy: '只有交付报告确认可清理后才移除隔离 worktree；失败 lane 保留给人工排查。'
  }
}

function inferValidationCommands(cwd: string, explicit: string[] | undefined): string[] {
  const provided = unique((explicit ?? []).map((item) => item.trim()).filter(Boolean))
  if (provided.length > 0) return provided

  const scripts = readPackageScripts(cwd)
  const commands: string[] = []
  for (const scriptName of ['typecheck', 'build', 'test:model-router', 'test:dag']) {
    if (scripts.has(scriptName)) commands.push(`npm run ${scriptName}`)
  }
  return commands.length > 0 ? commands : ['git diff --check']
}

function readPackageScripts(cwd: string): Set<string> {
  const packagePath = path.join(cwd, 'package.json')
  if (!existsSync(packagePath)) return new Set()
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts?: Record<string, unknown> }
    return new Set(Object.entries(parsed.scripts ?? {}).filter(([, value]) => typeof value === 'string').map(([key]) => key))
  } catch {
    return new Set()
  }
}

function buildValidationGates(commands: string[]): GenesisValidationGate[] {
  return [
    {
      id: 'gate-plan-review',
      kind: 'plan-review',
      title: '主 Agent 审查 Genesis 计划、DAG 分层、隔离策略和风险点',
      required: true,
      blocksDelivery: true,
      status: 'planned'
    },
    {
      id: 'gate-lane-readiness',
      kind: 'lane-readiness',
      title: '每条 worker lane 明确输入、依赖、权限和交接格式后才允许派发',
      required: true,
      blocksDelivery: true,
      status: 'planned'
    },
    ...commands.map((command, index) => ({
      id: `gate-verify-${index + 1}`,
      kind: 'verification-command' as const,
      title: `运行验证命令 ${index + 1}`,
      command,
      required: true,
      blocksDelivery: true,
      status: 'planned' as const
    })),
    {
      id: 'gate-delivery-readiness',
      kind: 'delivery-readiness',
      title: 'Code Forge 交付前复核 diff、验证结果、冲突风险和人工确认',
      required: true,
      blocksDelivery: true,
      status: 'planned'
    }
  ]
}

function assessRisk(input: {
  request: string
  taskCount: number
  deliveryMode: CodeForgeDeliveryMode
  verificationCommands: string[]
}): GenesisRiskReport {
  const reasons: string[] = []
  let score = 0
  if (input.taskCount > 1) {
    score += 1
    reasons.push('多 lane/DAG 编排需要隔离和合并审查')
  }
  if (input.deliveryMode === 'commit' || input.deliveryMode === 'pr') {
    score += 2
    reasons.push(`交付模式 ${input.deliveryMode} 可能产生持久 Git 结果`)
  }
  if (/生产|上线|发布|release|prod|数据库|migration|权限|安全|token|secret|auth/i.test(input.request)) {
    score += 2
    reasons.push('需求包含生产、发布、数据、权限或安全风险信号')
  }
  if (/并行|多 Agent|多Agent|worktree|子 Agent|DAG|编排/i.test(input.request)) {
    score += 1
    reasons.push('需求明确涉及多 Agent/隔离编排')
  }
  if (input.verificationCommands.some((command) => /\b(electron-builder|dist|deploy|push|release)\b/i.test(command))) {
    score += 1
    reasons.push('验证命令包含构建发布或外部副作用风险信号')
  }
  if (reasons.length === 0) reasons.push('常规 Genesis 计划风险')

  const level: ToolRiskLevel = score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low'
  return {
    level,
    reasons,
    requiresHumanConfirmation: level !== 'low'
  }
}

function confirmationPoints(input: {
  modeStrategy: GenesisModeStrategy
  deliveryMode: CodeForgeDeliveryMode
  risk: GenesisRiskReport
  force: boolean
}): GenesisHumanConfirmationPoint[] {
  const points: GenesisHumanConfirmationPoint[] = []
  if (!input.modeStrategy.orchestrationAllowed) {
    points.push({
      id: 'confirm-drive-upgrade',
      title: '切换到 Command 或 Genesis',
      reason: input.modeStrategy.reason,
      requiredBefore: 'dispatch'
    })
  }
  points.push({
    id: 'confirm-dispatch',
    title: '确认是否真实启动子 Agent / DAG 调度',
    reason: 'A9 v1 只规划；真实 task_dispatch_dag 必须另行确认。',
    requiredBefore: 'dispatch'
  })
  points.push({
    id: 'confirm-isolated-worktrees',
    title: '确认隔离 worktree 创建策略',
    reason: '隔离执行会占用本机路径和分支命名空间，需确认根目录、分支命名和清理策略。',
    requiredBefore: 'dispatch'
  })
  if (input.risk.requiresHumanConfirmation || input.force) {
    points.push({
      id: 'confirm-write-and-verify',
      title: '确认写入、命令和验证范围',
      reason: `风险等级 ${input.risk.level}: ${input.risk.reasons.join('; ')}`,
      requiredBefore: 'write'
    })
  }
  if (input.deliveryMode === 'commit' || input.deliveryMode === 'pr') {
    points.push({
      id: 'confirm-code-forge-delivery',
      title: '确认 Code Forge 持久交付',
      reason: `${input.deliveryMode} 模式会提交或准备发布工程结果，必须在 diff 和验证通过后再执行。`,
      requiredBefore: 'delivery'
    })
  }
  return points
}

function buildDeliveryStrategy(
  deliveryMode: CodeForgeDeliveryMode,
  verificationCommands: string[]
): GenesisDeliveryStrategy {
  const recommendedMode = deliveryMode === 'report' ? 'report' : 'patch'
  const persistentHandoff = deliveryMode === 'commit'
    ? '验证和 Code Forge patch 完成后，依次调用 git_stage/git_stage_all 与 git_commit。'
    : deliveryMode === 'pr'
      ? '验证和 Code Forge patch 完成后，依次调用 git_stage/git_stage_all、git_commit、git_push 与 git_create_pr。'
      : ''
  return {
    tool: 'code_forge_delivery',
    requestedMode: deliveryMode,
    recommendedMode,
    verificationTool: 'bash',
    verificationCommands,
    requiresCleanWorktree: true,
    stageAllDefault: false,
    executed: false,
    preconditions: [
      '所有 worker lane 已完成并交接 diff/验证结果',
      '主 Agent 已审查每个 lane 的改动和冲突风险',
      '所有 validation gates 均通过',
      '用户已确认需要的交付模式'
    ],
    handoff: [
      '先逐条使用显式 bash 工具执行 verificationCommands，并审查每条命令的独立结果。',
      `验证通过后调用 code_forge_delivery mode=${recommendedMode} 生成结构化交付产物；不得把验证命令传给 Code Forge。`,
      persistentHandoff
    ].filter(Boolean).join(' ')
  }
}

function buildExecutionReport(status: GenesisOrchestrationStatus): GenesisExecutionReport {
  return {
    status,
    executedActions: [
      'decomposeTask(useModel=false)',
      'validateTaskDag',
      'assemble worker lane plan',
      'assemble isolation/validation/delivery protocol'
    ],
    notExecuted: [
      'task_dispatch_dag',
      'task_decompose_and_dispatch_dag',
      'git worktree add',
      'code_forge_delivery',
      'external sub-agent control',
      'UI creation'
    ],
    reusedModules: [
      'src/main/model/drive.ts',
      'src/main/agent/task-decomposer.ts',
      'src/main/agent/dag-scheduler.ts',
      'src/main/code-forge/delivery.ts'
    ]
  }
}

function buildSummary(
  status: GenesisOrchestrationStatus,
  laneCount: number,
  riskLevel: ToolRiskLevel,
  deliveryMode: CodeForgeDeliveryMode
): string {
  return `Genesis A9 ${status}: ${laneCount} 条 worker lane, 风险 ${riskLevel}, 交付模式 ${deliveryMode}; 未真实控制外部子 Agent。`
}

function normalizeDeliveryMode(value: CodeForgeDeliveryMode | undefined): CodeForgeDeliveryMode {
  return value === 'patch' || value === 'commit' || value === 'pr' || value === 'report' ? value : 'report'
}

function roleLabel(role: TaskDagRole): string {
  switch (role) {
    case 'frontend':
      return 'Frontend'
    case 'backend':
      return 'Backend'
    case 'qa':
      return 'QA'
    case 'docs':
      return 'Docs'
    case 'devops':
      return 'DevOps'
    case 'review':
      return 'Review'
    default:
      return 'General'
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'lane'
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}
