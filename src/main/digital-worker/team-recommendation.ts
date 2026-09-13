import { createHash } from 'node:crypto'
import type {
  DigitalWorkerRoleRecommendation,
  DigitalWorkerTeamRecommendation,
  JsonObject
} from '../../shared/digital-worker-types'
import type { Goal, ProjectWorkspace, WorkItem } from '../../shared/project-workspace-types'
import type { WatercolorCharacterRole } from '../../shared/watercolor-character'

interface TeamRecommendationContext {
  project: ProjectWorkspace
  goals: readonly Goal[]
  workItems: readonly WorkItem[]
  goalId?: string
}

interface RoleDefinition {
  role: WatercolorCharacterRole
  name: string
  purpose: string
  signals: readonly string[]
  methods: readonly string[]
  responsibilities: readonly string[]
  capabilityRefs: readonly string[]
  skillRefs: readonly string[]
  toolPolicy: JsonObject
  outputs: readonly string[]
  acceptance: readonly string[]
}

const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    role: 'researcher',
    name: '研究分析师',
    purpose: '建立可追溯的事实、需求和方案依据',
    signals: ['研究', '调研', '分析', '检索', '行业', '市场', '资料', 'research', 'analysis', 'benchmark'],
    methods: ['先定义问题与证据标准', '交叉核验来源并标注不确定性', '将结论绑定到可复查证据'],
    responsibilities: ['收集并筛选一手资料', '输出证据化洞察与风险', '为后续岗位提供可引用输入'],
    capabilityRefs: ['research', 'source-verification', 'evidence-synthesis'],
    skillRefs: [],
    toolPolicy: { workspaceRead: true, workspaceWrite: false, terminal: false, browser: true, network: true },
    outputs: ['研究简报', '来源清单', '风险与未知项'],
    acceptance: ['关键结论均有来源或明确标记为待验证']
  },
  {
    role: 'planner',
    name: '项目统筹',
    purpose: '把目标拆成可执行、可验收、可恢复的工作闭环',
    signals: ['规划', '计划', '方案', '架构', '策略', '需求', '协调', '项目', 'plan', 'strategy', 'architecture', 'requirement'],
    methods: ['拆解依赖与关键路径', '为每个阶段定义输入、输出和验收', '汇总跨岗位产物并处理冲突'],
    responsibilities: ['维护 Goal 与 WorkItem 边界', '协调岗位交接和升级', '汇总最终交付'],
    capabilityRefs: ['planning', 'work-breakdown', 'coordination'],
    skillRefs: [],
    toolPolicy: { workspaceRead: true, workspaceWrite: true, terminal: false, browser: false, network: false },
    outputs: ['执行计划', '依赖与风险清单', '汇总交付清单'],
    acceptance: ['所有必要工作均有负责人、产出和验收条件']
  },
  {
    role: 'writer',
    name: '内容编辑',
    purpose: '把事实和方案转化为结构清晰、面向目标受众的内容',
    signals: ['写作', '内容', '文案', '文章', '文档', '翻译', '说明', 'copy', 'content', 'write', 'document', 'translation'],
    methods: ['先确定受众与信息层级', '基于已核验事实组织内容', '通过编辑检查保证一致性'],
    responsibilities: ['撰写和编辑目标内容', '维护术语与口径一致', '交付可发布版本'],
    capabilityRefs: ['writing', 'editing', 'content-structure'],
    skillRefs: [],
    toolPolicy: { workspaceRead: true, workspaceWrite: true, terminal: false, browser: false, network: false },
    outputs: ['内容初稿', '编辑定稿', '发布素材'],
    acceptance: ['内容准确、完整，并符合目标受众和交付格式']
  },
  {
    role: 'designer',
    name: '产品设计师',
    purpose: '将目标和约束转化为可用、一致、可实现的体验方案',
    signals: ['设计', '界面', '交互', '视觉', '体验', '原型', 'figma', 'design', 'interface', 'ux', 'ui', 'prototype'],
    methods: ['从关键任务流建立信息架构', '覆盖正常、空、错和加载状态', '以实现约束校验设计可落地性'],
    responsibilities: ['定义用户流程和界面结构', '维护组件与视觉一致性', '提供实现规格和状态说明'],
    capabilityRefs: ['product-design', 'interaction-design', 'visual-system'],
    skillRefs: [],
    toolPolicy: { workspaceRead: true, workspaceWrite: true, terminal: false, browser: true, network: false },
    outputs: ['任务流', '界面方案', '实现规格'],
    acceptance: ['关键流程无阻塞，所有状态有明确且可实现的设计']
  },
  {
    role: 'developer',
    name: '软件工程师',
    purpose: '把已确认方案实现为可编译、可维护的产品能力',
    signals: ['开发', '代码', '软件', '应用', '功能', '接口', '数据库', '编译', '构建', 'api', 'code', 'develop', 'software', 'app', 'build'],
    methods: ['先确认领域合同和现有模式', '按最小完整切片实现', '保留失败边界和可恢复状态'],
    responsibilities: ['实现前后端和持久化能力', '处理边界条件与错误状态', '提供可审查的变更和构建产物'],
    capabilityRefs: ['software-development', 'integration', 'build'],
    skillRefs: [],
    toolPolicy: { workspaceRead: true, workspaceWrite: true, terminal: true, browser: false, network: false },
    outputs: ['产品代码', '迁移或配置变更', '生产构建产物'],
    acceptance: ['实现满足合同且生产构建通过']
  },
  {
    role: 'review-test',
    name: '质量审查',
    purpose: '独立发现缺陷并以 Acceptance 证据判定交付质量',
    signals: ['审查', '审核', '评审', '测试', '验收', '质量', '安全', '核验', 'review', 'test', 'quality', 'security', 'acceptance', 'verify'],
    methods: ['从验收条件反推检查路径', '优先验证高风险和失败分支', '记录可复现问题与证据'],
    responsibilities: ['独立审查实现和产物', '验证 Acceptance 与回归风险', '输出缺陷、复验和放行结论'],
    capabilityRefs: ['review', 'testing', 'acceptance-verification'],
    skillRefs: [],
    toolPolicy: { workspaceRead: true, workspaceWrite: false, terminal: true, browser: true, network: false },
    outputs: ['审查报告', '缺陷与复验记录', '验收结论'],
    acceptance: ['每项放行结论均绑定到可复现证据']
  },
  {
    role: 'operations',
    name: '交付运营',
    purpose: '把通过验收的结果可靠交付并维持可观测运行',
    signals: ['发布', '部署', '交付', '运营', '运维', '监控', '自动化', '安装包', 'release', 'deploy', 'delivery', 'operations', 'monitor', 'package'],
    methods: ['定义交付清单和回滚点', '按环境执行可重复发布', '监控结果并记录异常处置'],
    responsibilities: ['准备安装包或发布物', '维护发布与回滚流程', '跟踪运行状态和用户反馈'],
    capabilityRefs: ['delivery', 'release-operations', 'observability'],
    skillRefs: [],
    toolPolicy: { workspaceRead: true, workspaceWrite: true, terminal: true, browser: true, network: true },
    outputs: ['交付包', '发布与回滚记录', '运行状态报告'],
    acceptance: ['交付物可定位、可校验，并具备明确回滚路径']
  }
]

const GOAL_STATUS_PRIORITY: Readonly<Record<string, number>> = {
  running: 0,
  waiting_approval: 1,
  verifying: 2,
  planned: 3,
  draft: 4,
  blocked: 5,
  failed: 6,
  completed: 7,
  cancelled: 8,
  archived: 9
}

export function recommendDigitalWorkerTeam(context: TeamRecommendationContext): DigitalWorkerTeamRecommendation {
  const goal = selectGoal(context)
  const goalWorkItems = context.workItems.filter((item) =>
    item.projectId === context.project.id && item.goalId === goal.id)
  const corpus = recommendationCorpus(goal, goalWorkItems)
  const matches = new Map<WatercolorCharacterRole, string[]>()
  for (const definition of ROLE_DEFINITIONS) {
    matches.set(definition.role, definition.signals.filter((signal) => containsSignal(corpus, signal)))
  }

  const selected = new Set<WatercolorCharacterRole>(
    ROLE_DEFINITIONS.filter((definition) => (matches.get(definition.role)?.length ?? 0) > 0)
      .map((definition) => definition.role)
  )
  let fallbackRole: WatercolorCharacterRole | undefined
  if (selected.size === 0) {
    fallbackRole = 'planner'
    selected.add(fallbackRole)
  }
  if (selected.has('developer')) selected.add('review-test')
  if (goal.riskLevel === 'high' || goal.riskLevel === 'critical') selected.add('review-test')
  if (selected.size > 1) selected.add('planner')

  const selectedDefinitions = ROLE_DEFINITIONS.filter((definition) => selected.has(definition.role)).slice(0, 8)
  const dataScope = recommendationDataScope(context.project, goal)
  const budgetPolicies = recommendationBudgetPolicies(goal, selectedDefinitions.length)
  const roles = selectedDefinitions.map((definition, index) => buildRoleRecommendation(
    definition,
    goal,
    matches.get(definition.role) ?? [],
    dataScope,
    budgetPolicies[index],
    fallbackRole === definition.role,
    selected.has('developer') && definition.role === 'review-test'
  ))
  const coordinator = roles.find((role) => role.watercolorRole === 'planner') ?? roles[0]
  const draft = {
    schemaVersion: 1 as const,
    projectId: context.project.id,
    goalId: goal.id,
    source: {
      goalId: goal.id,
      goalTitle: goal.title,
      goalStatus: goal.status,
      objective: goal.objective,
      workItemCount: goalWorkItems.length
    },
    coordinatorRoleId: coordinator.id,
    roles
  }
  return {
    ...draft,
    digest: createHash('sha256').update(JSON.stringify(draft)).digest('hex')
  }
}

function selectGoal(context: TeamRecommendationContext): Goal {
  const projectGoals = context.goals.filter((goal) => goal.projectId === context.project.id)
  if (context.goalId) {
    const requested = projectGoals.find((goal) => goal.id === context.goalId)
    if (!requested) throw new Error(`Goal does not belong to project: ${context.goalId}`)
    return requested
  }
  const selected = [...projectGoals].sort((left, right) => {
    const priority = (GOAL_STATUS_PRIORITY[left.status] ?? 99) - (GOAL_STATUS_PRIORITY[right.status] ?? 99)
    if (priority !== 0) return priority
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
    return left.id.localeCompare(right.id)
  })[0]
  if (!selected) throw new Error(`Project does not have a Goal: ${context.project.id}`)
  return selected
}

function recommendationCorpus(goal: Goal, workItems: readonly WorkItem[]): string {
  return [
    goal.title,
    goal.objective,
    goal.background ?? '',
    ...goal.constraints,
    ...goal.successCriteria,
    ...goal.acceptance.map((item) => item.criterion),
    ...workItems.map((item) => item.title)
  ].join('\n').toLocaleLowerCase('zh-CN')
}

function containsSignal(corpus: string, signal: string): boolean {
  const normalized = signal.toLocaleLowerCase('zh-CN')
  if (!/^[a-z0-9 -]+$/u.test(normalized)) return corpus.includes(normalized)
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '\\s+')
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'u').test(corpus)
}

function recommendationDataScope(project: ProjectWorkspace, goal: Goal): JsonObject {
  const allowedResources = project.resources.filter((resource) =>
    resource.egressPolicy !== 'deny' && resource.dataClass !== 'S3' && resource.dataClass !== 'S4')
  const allowedResourceIds = allowedResources.map((resource) => resource.id)
  const allowedDataClasses = [...new Set(
    allowedResources
      .map((resource) => resource.dataClass)
      .filter((dataClass): dataClass is NonNullable<typeof dataClass> => Boolean(dataClass))
  )]
  return {
    mode: 'project-scoped',
    requireExplicitScope: goal.riskLevel === 'high' || goal.riskLevel === 'critical',
    allowedResourceIds,
    allowedDataClasses,
    deniedDataClasses: ['S3', 'S4']
  }
}

function recommendationBudgetPolicies(goal: Goal, roleCount: number): JsonObject[] {
  const count = Math.max(1, roleCount)
  const tokenAllocations = goal.budget?.maxTokens === undefined
    ? undefined
    : distributeInteger(goal.budget.maxTokens, count)
  const runAllocations = goal.budget?.maxRuns === undefined
    ? undefined
    : distributeInteger(goal.budget.maxRuns, count)
  const concurrencyAllocations = goal.budget?.maxConcurrentRuns === undefined
    ? undefined
    : distributeInteger(goal.budget.maxConcurrentRuns, count)
  return Array.from({ length: count }, (_, index) => {
    const policy: JsonObject = { mode: 'inherit-goal', sourceGoalId: goal.id }
    if (goal.budget?.currency) policy.currency = goal.budget.currency
    if (goal.budget?.amount !== undefined) {
      const base = Math.floor((goal.budget.amount * 100) / count) / 100
      const allocated = index === count - 1
        ? Math.round((goal.budget.amount - base * (count - 1)) * 100) / 100
        : base
      policy.maxAmount = allocated
    }
    if (tokenAllocations) policy.maxTokens = tokenAllocations[index]
    if (runAllocations) policy.maxRuns = runAllocations[index]
    if (concurrencyAllocations) policy.maxConcurrentRuns = concurrencyAllocations[index]
    return policy
  })
}

function distributeInteger(total: number, count: number): number[] {
  const normalized = Math.max(0, Math.floor(total))
  const base = Math.floor(normalized / count)
  const remainder = normalized % count
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0))
}

function buildRoleRecommendation(
  definition: RoleDefinition,
  goal: Goal,
  matchedSignals: readonly string[],
  dataScope: JsonObject,
  budgetPolicy: JsonObject,
  isFallback: boolean,
  isDevelopmentReview: boolean
): DigitalWorkerRoleRecommendation {
  const rationale = matchedSignals.length > 0
    ? `目标信号：${matchedSignals.slice(0, 6).join('、')}`
    : isDevelopmentReview
      ? '开发工作需要独立审查与验收闭环'
      : isFallback
        ? '目标未命中特定专业信号，采用最小统筹岗位承接和拆解'
        : '目标风险等级要求独立质量审查'
  const acceptance = uniqueStrings([
    ...definition.acceptance,
    ...goal.acceptance.filter((item) => item.required !== false).map((item) => item.criterion),
    ...goal.successCriteria
  ]).slice(0, 6)
  return {
    id: `recommended-role:${definition.role}`,
    watercolorRole: definition.role,
    name: definition.name,
    purpose: `${definition.purpose}：${goal.title}`,
    rationale,
    methods: [...definition.methods],
    responsibilities: [...definition.responsibilities],
    capabilityRefs: [...definition.capabilityRefs],
    skillRefs: [...definition.skillRefs],
    toolPolicy: { ...definition.toolPolicy },
    dataScope: { ...dataScope },
    budgetPolicy: { ...budgetPolicy },
    outputs: [...definition.outputs],
    acceptance,
    escalationPolicy: { target: 'project-owner', afterFailures: 2 }
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}
