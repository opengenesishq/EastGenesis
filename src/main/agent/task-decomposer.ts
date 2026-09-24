import { randomUUID } from 'node:crypto'
import type {
  TaskDag,
  TaskDagComplexity,
  TaskDagRole,
  TaskDagTask,
  TaskDecomposeInput,
  TaskDecomposeResult
} from '../../shared/types'
import { validateTaskDag } from './dag-scheduler'

const COMPLEXITY_SIGNALS = [
  /完整|全流程|端到端|跨模块|多模块|多个文件|三.*文件|3\s*个文件/i,
  /前端|UI|界面|组件|React|Tailwind/i,
  /后端|API|IPC|数据库|服务|接口/i,
  /测试|验证|验收|QA|E2E|smoke|typecheck|构建/i,
  /登录|认证|权限|注册|会话|token/i,
  /Genesis|DAG|编排|多\s*Agent|子\s*Agent|worktree|隔离执行/i
]

interface TaskTemplate {
  id: string
  title: string
  description: string
  dependencies: string[]
  role: TaskDagRole
}

export interface ModelDagTaskPayload {
  id: string
  title: string
  description: string
  dependencies: string[]
  role: TaskDagRole
}

export interface ModelDagPayload {
  title?: string
  tasks: ModelDagTaskPayload[]
}

export interface ModelDagDecomposer {
  decompose(input: TaskDecomposeInput): Promise<ModelDagPayload>
}

export interface TaskDecomposeOptions {
  modelDecomposer?: ModelDagDecomposer
}

function normalizeRequest(input: TaskDecomposeInput): string {
  return (input.request ?? '').replace(/\s+/g, ' ').trim()
}

function estimateComplexity(request: string): { complexity: TaskDagComplexity; score: number; reason: string } {
  const score = COMPLEXITY_SIGNALS.reduce((total, re) => total + (re.test(request) ? 1 : 0), 0)
  if (score >= 3) {
    return { complexity: 'multi', score, reason: `命中 ${score} 个跨模块复杂度信号` }
  }
  return { complexity: 'single', score, reason: `仅命中 ${score} 个复杂度信号,按单任务处理` }
}

function taskPrompt(source: string, task: TaskTemplate): string {
  return [
    `你是 EastGenesis DAG 子 Agent,角色: ${task.role}。`,
    '',
    `父需求: ${source}`,
    `子任务: ${task.title}`,
    `任务说明: ${task.description}`,
    task.dependencies.length > 0 ? `依赖任务: ${task.dependencies.join(', ')}` : '依赖任务: 无',
    '',
    '执行要求:',
    '1. 只围绕本子任务推进,不要擅自扩大范围。',
    '2. 修改前先核对现有文件和项目规范;新增 TypeScript 必须有明确类型。',
    '3. 完成后给出已修改文件、验证命令、剩余风险和给下游任务的交接信息。'
  ].join('\n')
}

function toTask(source: string, template: TaskTemplate): TaskDagTask {
  return { ...template, prompt: taskPrompt(source, template) }
}

function loginTemplates(): TaskTemplate[] {
  return [
    {
      id: 'backend-auth',
      title: '后端认证能力',
      description: '梳理并实现登录/会话相关 IPC、API、状态持久化和错误处理,保证不破坏现有会话能力。',
      dependencies: [],
      role: 'backend'
    },
    {
      id: 'frontend-auth',
      title: '前端登录界面',
      description: '复用现有设计体系实现登录入口、表单状态、错误提示和已登录态展示。',
      dependencies: [],
      role: 'frontend'
    },
    {
      id: 'qa-auth-flow',
      title: '登录全流程验证',
      description: '覆盖前端、后端和回归路径,补充 smoke/E2E 或可重复验证脚本。',
      dependencies: ['backend-auth', 'frontend-auth'],
      role: 'qa'
    }
  ]
}

function fullStackTemplates(request: string): TaskTemplate[] {
  const needsUi = /前端|UI|界面|组件|React|Tailwind|页面/i.test(request)
  const needsBackend = /后端|API|IPC|数据库|服务|接口|主进程/i.test(request)
  const templates: TaskTemplate[] = []

  if (needsBackend || !needsUi) {
    templates.push({
      id: 'backend-core',
      title: '后端与数据流',
      description: '实现主进程/服务端数据模型、IPC/API 接口和兼容性开关,并保持旧路径不变。',
      dependencies: [],
      role: 'backend'
    })
  }
  if (needsUi || !needsBackend) {
    templates.push({
      id: 'frontend-ui',
      title: '前端交互与可视化',
      description: '复用现有组件库和样式变量完成 UI 接入、状态展示和响应式适配。',
      dependencies: [],
      role: 'frontend'
    })
  }

  const dependencyIds = templates.map((task) => task.id)
  templates.push({
    id: 'qa-validation',
    title: '验证与回归',
    description: '运行类型检查、构建和目标 smoke;补充缺失测试并记录证据。',
    dependencies: dependencyIds,
    role: 'qa'
  })
  return templates
}

function genericComplexTemplates(): TaskTemplate[] {
  return [
    {
      id: 'architecture',
      title: '架构与影响面核查',
      description: '阅读现有实现,明确需要修改的模块、类型边界、兼容开关和验收命令。',
      dependencies: [],
      role: 'review'
    },
    {
      id: 'implementation',
      title: '核心实现',
      description: '在架构核查基础上完成主要代码变更,复用现有模式并避免破坏旧功能。',
      dependencies: ['architecture'],
      role: 'general'
    },
    {
      id: 'verification',
      title: '集成验证',
      description: '执行全流程测试、收集失败项并给出修复或升级主 Agent 的建议。',
      dependencies: ['implementation'],
      role: 'qa'
    }
  ]
}

function simpleTemplate(): TaskTemplate[] {
  return [
    {
      id: 'single-agent',
      title: '单 Agent 直接处理',
      description: '需求复杂度不足以启动 DAG 编排,由一个 Agent 直接完成实现与验证。',
      dependencies: [],
      role: 'general'
    }
  ]
}

function templatesFor(request: string, complexity: TaskDagComplexity): TaskTemplate[] {
  if (complexity === 'single') return simpleTemplate()
  if (/登录|认证|注册|会话|token/i.test(request)) return loginTemplates()
  if (/前端|UI|界面|组件|React|Tailwind|后端|API|IPC|数据库|测试|QA|E2E|smoke/i.test(request)) {
    return fullStackTemplates(request)
  }
  return genericComplexTemplates()
}

function dagTitle(request: string): string {
  const title = request.replace(/[。.!?！？].*$/, '').slice(0, 42)
  return title || 'DAG 编排任务'
}

function createDag(request: string, complexity: TaskDagComplexity, tasks: TaskDagTask[], title?: string): TaskDag {
  return {
    id: `dag-${randomUUID()}`,
    title: title?.trim() || dagTitle(request),
    source: request,
    complexity,
    createdAt: Date.now(),
    tasks
  }
}

function validateOrThrow(dag: TaskDag): void {
  const validation = validateTaskDag(dag)
  if (!validation.ok) throw new Error(validation.error)
}

function localDecompose(request: string, estimate: ReturnType<typeof estimateComplexity>): TaskDecomposeResult {
  const tasks = templatesFor(request, estimate.complexity).map((template) => toTask(request, template))
  const dag = createDag(request, estimate.complexity, tasks)
  validateOrThrow(dag)
  return {
    dag,
    strategy: 'local-heuristic',
    reason: estimate.reason,
    warnings:
      estimate.complexity === 'single'
        ? ['当前需求未达到自动并行阈值,仍可手动派发为 DAG。']
        : []
  }
}

function modelTasksToDagTasks(source: string, payload: ModelDagPayload): TaskDagTask[] {
  return payload.tasks.map((task) =>
    toTask(source, {
      id: task.id,
      title: task.title,
      description: task.description,
      dependencies: task.dependencies,
      role: task.role
    })
  )
}

export async function decomposeTask(
  input: TaskDecomposeInput,
  options: TaskDecomposeOptions = {}
): Promise<TaskDecomposeResult> {
  const request = normalizeRequest(input)
  if (!request) throw new Error('需求不能为空')

  const estimate = estimateComplexity(request)
  if (estimate.complexity === 'multi' && input.useModel !== false && options.modelDecomposer) {
    try {
      const payload = await options.modelDecomposer.decompose({ ...input, request })
      const dag = createDag(request, 'multi', modelTasksToDagTasks(request, payload), payload.title)
      validateOrThrow(dag)
      return {
        dag,
        strategy: 'model',
        reason: `${estimate.reason};已使用强推理模型拆解 DAG`,
        warnings: []
      }
    } catch (err) {
      if (isModelAttemptPersistenceFailure(err)) throw err
      if (isRoutingBoundaryFailure(err)) throw err
      const fallback = localDecompose(request, estimate)
      return {
        ...fallback,
        warnings: [
          ...fallback.warnings,
          `强推理模型拆解失败,已回退本地启发式:${err instanceof Error ? err.message : String(err)}`
        ]
      }
    }
  }

  return localDecompose(request, estimate)
}

function isRoutingBoundaryFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'FrozenRoutingPolicyError' || /^DAG\b/i.test(error.message)
    || /canonical Run|冻结模型|冻结 Provider|routing target|DAG protocol|local_only/i.test(error.message)
}

function isModelAttemptPersistenceFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'ModelAttemptPersistenceError') return false
  const record = error as Error & { phase?: unknown; operationStarted?: unknown }
  return (record.phase === 'start' || record.phase === 'complete') &&
    typeof record.operationStarted === 'boolean'
}
