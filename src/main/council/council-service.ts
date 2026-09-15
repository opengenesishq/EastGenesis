import type { CouncilContext, CouncilGetInput, CouncilPreview, CouncilPreviewInput, CouncilRecord, CouncilRuntimeBinding, CouncilStartInput, CouncilStopInput } from '../../shared/council-types'
import type { CreateSessionOptions, SessionMeta, TaskDagExecutionView, TaskDagRuntimeSnapshot, TranscriptEntry } from '../../shared/types'
import { AUTO_MODEL } from '../../shared/types'
import { projectInstitutionTemplate } from '../../shared/project-institution-template'
import { readGoalInstitutionContext } from '../project-workspace/institution-goal-binding'
import { ProjectWorkspaceReadService } from '../project-workspace/canonical-read-service'
import { openProjectWorkspaceCommandService } from '../project-workspace/command-service'
import { getProvider, providerIsReady } from '../providers'
import { resolveProviderRuntimeTarget } from '../provider/providerRuntimeTarget'
import { findConfiguredModelProfile } from '../model/configured-model-profile'
import { estimateNativeRequestUpperCost, nativeBudgetScope, nativeBudgetSnapshot } from '../model/native-request-budget'
import { stableValueDigest } from '../task/tool-idempotency'
import type { SessionInputService } from '../task/session-input-service'
import { councilConnectionDigest, registerCouncilRequestBinding } from './council-request-guard'
import { SupervisorStateStore } from '../task/supervisor-state'
import { getTaskSnapshot, listTaskRuns, listTaskSnapshots, saveTaskSnapshot } from '../task/task-snapshot'

export interface CouncilRuntime {
  ready(): Promise<void>
  meta(id: string): SessionMeta | undefined
  metas(): SessionMeta[]
  transcript(id: string): TranscriptEntry[]
  create(options: CreateSessionOptions, id: string): Promise<SessionMeta>
  inputs(): SessionInputService
  persist(id: string): Promise<void>
  update(execution: TaskDagExecutionView): void
  interrupt(id: string): Promise<unknown>
  reserve(id: string): (() => void) | undefined
  acknowledge(id: string): void
}
type ActiveCouncil = { binding: CouncilRuntimeBinding; execution: TaskDagExecutionView; timer?: ReturnType<typeof setTimeout> }

/** Bounded peer opinions projected through existing DAG snapshots and child Runs. */
export class CouncilService {
  private readonly councils = new Map<string, ActiveCouncil>()
  private readonly operations = new Map<string, Promise<CouncilRecord>>()
  private readonly parentOperations = new Map<string, Promise<unknown>>()
  private hydration: Promise<void> | undefined
  constructor(private readonly rootDir: string, private readonly runtime: CouncilRuntime) {}

  async get(input: CouncilGetInput): Promise<CouncilContext> {
    await this.runtime.ready()
    await this.hydrate()
    checkedId(input.sessionId)
    const meta = this.runtime.meta(input.sessionId)
    const prior = [...this.councils.values()].find(({ binding }) => binding.record.sessionId === input.sessionId)?.binding.record
    const identity = meta ?? (prior && { workspaceId: prior.projectId, goalId: prior.goalId, workItemId: prior.workItemId })
    if (!identity?.workspaceId || !identity.goalId || !identity.workItemId || meta?.parentSessionId) throw new Error('找不到原议事任务身份')
    const { template } = await readGoalInstitutionContext(this.rootDir, identity.workspaceId, identity.goalId, identity.workItemId)
    return { sessionId: input.sessionId, template, institutions: projectInstitutionTemplate(template).roles
      .filter((role) => role.participation === 'on_demand' || role.participation === 'legacy').map((role) => ({ ...role })),
    history: [...this.councils.values()].map(({ binding }) => binding.record)
      .filter((record) => record.sessionId === input.sessionId && (!input.councilId || record.councilId === input.councilId))
      .sort((a, b) => b.startedAt - a.startedAt).map((record) => structuredClone(record)) }
  }

  async preview(input: CouncilPreviewInput): Promise<CouncilPreview> {
    return (await this.prepare(input)).preview
  }

  start(input: CouncilStartInput): Promise<CouncilRecord> {
    const key = `${input.sessionId}:${input.requestId}`
    const pending = this.operations.get(key)
    if (pending) return pending
    const previous = this.parentOperations.get(input.sessionId) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(() => this.performStart(input)).finally(() => {
      this.operations.delete(key)
      if (this.parentOperations.get(input.sessionId) === operation) this.parentOperations.delete(input.sessionId)
    })
    this.parentOperations.set(input.sessionId, operation)
    this.operations.set(key, operation)
    return operation
  }

  private async prepare(input: CouncilPreviewInput) {
    await this.runtime.ready()
    await this.hydrate()
    checkedId(input.requestId)
    const meta = this.parent(input.sessionId)
    if (typeof input.topic !== 'string' || !input.topic.trim() || input.topic.length > 4000) throw new Error('请输入不超过 4000 字的议题')
    if (!Array.isArray(input.institutionIds) || input.institutionIds.length > 2 ||
        new Set(input.institutionIds).size !== input.institutionIds.length) throw new Error('议事需选择 1 至 2 个不同机构')
    const { template } = await readGoalInstitutionContext(this.rootDir, meta.workspaceId!, meta.goalId!, meta.workItemId!)
    const state = await new ProjectWorkspaceReadService(this.rootDir).getWorkspaceExecutionState(meta.workspaceId!)
    const goal = state.goals.find((item) => item.id === meta.goalId)
    const task = state.workItems.find((item) => item.id === meta.workItemId)
    if (!goal || !task || task.goalId !== goal.id || ['archived', 'completed', 'cancelled', 'failed'].includes(goal.status) ||
        ['done', 'cancelled', 'failed'].includes(task.status)) throw new Error('原目标或任务已结束或归属变化，不能启动议事')
    const recommended = projectInstitutionTemplate(template).roles.filter((role) => role.participation === 'on_demand' || role.participation === 'legacy')
    const institutionIds = input.institutionIds.length ? input.institutionIds :
      [recommended.find((role) => role.id === 'neige') ?? recommended[0], recommended.find((role) => role.id === 'gongbu')]
        .filter((role, index, all) => role && all.findIndex((entry) => entry?.id === role.id) === index).map((role) => role!.id)
    const roles = institutionIds.map((id) => {
      const role = projectInstitutionTemplate(template).roles.find((candidate) => candidate.id === id)
      if (!role || (role.participation !== 'on_demand' && role.participation !== 'legacy')) throw new Error('所选机构不属于原目标的模型议事职责')
      return role
    })
    const provider = getProvider(meta.providerId)
    if (!provider || !providerIsReady(provider) || (provider.engine !== 'openai' && provider.engine !== 'anthropic')) {
      throw new Error('议事需使用已配置可用的原生 OpenAI 或 Anthropic 连接')
    }
    const selectedModel = meta.model === AUTO_MODEL ?
      (meta.modelRoutingDecision?.providerId === provider.id ? meta.modelRoutingDecision.model : undefined) : meta.model
    if (!selectedModel || selectedModel === AUTO_MODEL) throw new Error('原任务尚未确定具体模型，请先在任务中选择可用模型')
    const target = resolveProviderRuntimeTarget(provider, { appId: provider.engine, model: selectedModel })
    const profile = findConfiguredModelProfile(target.model, provider.advancedConfig?.modelProfiles)
    const budget = nativeBudgetSnapshot(meta, {}, this.rootDir)
    const goalRuns = (await new SupervisorStateStore(this.rootDir).listRuns({ projectId: goal.projectId })).filter((run) => run.goalId === goal.id)
    const taskRuns = await listTaskRuns(undefined, this.rootDir)
    const goalRunIds = new Set(goalRuns.map((run) => run.id))
    const goalSpentUsd = goalRuns.reduce((sum, run) => sum + (run.usage?.costUsd ?? 0), 0)
    const budgetContext: CouncilRuntimeBinding['budgetContext'] = {
      parentLimitUsd: nativeBudgetScope(meta, { providerBudgetUsd: provider.budgetUsd }).sessionLimitUsd,
      goalLimitUsd: goal.budget?.amount,
      goalSessionIds: [...new Set(taskRuns.filter((run) => goalRunIds.has(run.id)).map((run) => run.sessionId))], goalSpentUsd
    }
    const blockedReasons: string[] = []
    if (budget.sessionUnknown || budget.monthlyUnknown) blockedReasons.push('现有任务费用存在未知结果，请先核对')
    if (goal.budget?.amount !== undefined && goalRuns.some((run) => !run.usage)) blockedReasons.push('目标已有运行缺少完整费用记录，无法核对总预算')
    const cap = Math.min(0.5, budget.sessionRemainingUsd ?? Infinity, ...(budget.aggregateRemainingUsd ?? []),
      budget.monthlyRemainingUsd ?? Infinity,
      goal.budget?.amount !== undefined && (!goal.budget.currency || goal.budget.currency === 'USD') ? goal.budget.amount - goalSpentUsd : Infinity)
    const totalBudgetUsd = Math.max(0, Math.floor(cap * 1_000_000) / 1_000_000)
    if (totalBudgetUsd <= 0) blockedReasons.push('议事可用预算已用尽')
    if (goal.budget?.amount !== undefined && goal.budget.currency && goal.budget.currency !== 'USD') blockedReasons.push('目标预算币种不是 USD，无法验证模型费用上限')
    const requiredContext = { goal: { id: goal.id, title: goal.title, objective: goal.objective, constraints: goal.constraints,
      successCriteria: goal.successCriteria, forbiddenActions: goal.forbiddenActions, contract: goal.contract },
    task: { id: task.id, title: task.title, description: task.description, artifactRefs: task.artifactRefs, inheritedGoalContract: task.inheritedGoalContract } }
    const conversation = this.runtime.transcript(meta.id).filter(({ event }) => event.kind === 'user-message' || event.kind === 'assistant-message')
    const recentConversation = conversation.slice(-12)
    let omittedCount = conversation.length - recentConversation.length
    let context = JSON.stringify({ ...requiredContext, recentConversation, omittedCount })
    while (context.length > 32_000 && recentConversation.length) {
      recentConversation.shift(); omittedCount++
      context = JSON.stringify({ ...requiredContext, recentConversation, omittedCount })
    }
    if (context.length > 32_000) blockedReasons.push('原目标的完整约束超过议事上下文上限，请先拆分议题；不会截断要求')
    const limits = { rounds: 1 as const, maxParticipants: 2 as const, retries: 0 as const, timeoutMs: 300_000,
      totalBudgetUsd, maxOutputTokens: Math.min(2048, goal.budget?.maxTokens ?? 2048) }
    if (!Number.isSafeInteger(limits.maxOutputTokens) || limits.maxOutputTokens <= 0) blockedReasons.push('目标缺少有效输出额度')
    const share = Math.floor(totalBudgetUsd * 1_000_000 / roles.length) / 1_000_000
    const participants = roles.map((role, index) => ({ institutionId: role.id, institutionName: role.name, duty: role.duty,
      providerId: provider.id, providerName: provider.name, model: target.model, engine: provider.engine as 'openai' | 'anthropic',
      budgetUsd: index === roles.length - 1 ? Number((totalBudgetUsd - share * index).toFixed(6)) : share }))
    if (!profile?.pricing || !profile.contextWindow) blockedReasons.push('锁定模型尚未声明价格或上下文上限，无法核对议事成本')
    if (profile?.verification?.generation === 'failed') blockedReasons.push('锁定模型的生成能力验证失败')
    const estimate = estimateNativeRequestUpperCost({ messages: [{ content: context + input.topic }], max_tokens: limits.maxOutputTokens }, profile?.pricing)
    if (estimate === undefined || participants.some((participant) => estimate > participant.budgetUsd)) blockedReasons.push('已声明价格下的输入与输出费用超过机构预算')
    const connectionDigests = Object.fromEntries(participants.map((participant) => [participant.institutionId, councilConnectionDigest(participant.providerId, participant.model)]))
    const data = { schemaVersion: 1 as const, sessionId: meta.id, requestId: input.requestId, projectId: meta.workspaceId!, goalId: meta.goalId!,
      workItemId: meta.workItemId!, topic: input.topic.trim(), template, participants, limits, blockedReasons }
    const preview: CouncilPreview = { ...data, previewDigest: stableValueDigest({ ...data, context, connectionDigests, budgetContext }) }
    return { preview, context, connectionDigests, budgetContext }
  }

  private async performStart(input: CouncilStartInput): Promise<CouncilRecord> {
    await this.runtime.ready()
    await this.hydrate()
    const councilId = `council-${stableValueDigest({ sessionId: input.sessionId, requestId: input.requestId }).slice(0, 32)}`
    const existing = this.councils.get(councilId)
    if (existing) {
      if (existing.binding.record.previewDigest !== input.previewDigest || existing.binding.record.topic !== input.topic.trim() ||
          (input.institutionIds.length > 0 && stableValueDigest(input.institutionIds) !== stableValueDigest(existing.binding.record.participants.map((entry) => entry.institutionId)))) {
        throw new Error('相同议事请求标识不能用于不同预览')
      }
      return structuredClone(existing.binding.record)
    }
    const { preview, context, connectionDigests, budgetContext } = await this.prepare(input)
    if (preview.previewDigest !== input.previewDigest) throw new Error('议题、原任务、预算或模型已变化，请重新预览')
    if (preview.blockedReasons.length) throw new Error(preview.blockedReasons.join('；'))
    if ([...this.councils.values()].some(({ binding }) => binding.record.sessionId === input.sessionId &&
        ['preparing', 'running', 'needs_reconciliation'].includes(binding.record.phase))) throw new Error('此任务已有议事进行中或结果待核对')
    const releases: Array<() => void> = []
    for (const _ of preview.participants) {
      const release = this.runtime.reserve(input.sessionId)
      if (!release) { releases.forEach((done) => done()); throw new Error('执行资源已满，请等待其他子任务结束') }
      releases.push(release)
    }
    const now = Date.now()
    const record: CouncilRecord = { ...preview, councilId, phase: 'preparing', startedAt: now, deadlineAt: now + preview.limits.timeoutMs,
      opinions: preview.participants.map((participant, index) => ({ institutionId: participant.institutionId, sessionId: `${councilId}-${index + 1}`, status: 'pending' })) }
    const tasks = record.participants.map((participant, index) => ({ id: participant.institutionId, title: `${participant.institutionName}议事`,
      description: participant.duty, dependencies: [], role: 'review' as const,
      prompt: opinionPrompt(record, participant.institutionId, context), workItemId: `${record.opinions[index].sessionId}-review` }))
    const execution: TaskDagExecutionView = { id: councilId, parentSessionId: input.sessionId,
      dag: { id: councilId, title: `议事：${record.topic}`, source: 'council-v1', complexity: tasks.length > 1 ? 'multi' : 'single', createdAt: now, tasks },
      status: 'running', maxRetries: 0, startedAt: now, layers: [tasks.map((task) => task.id)],
      tasks: tasks.map((task, index) => ({ task, status: 'waiting', attempts: 0, sessionIds: [record.opinions[index].sessionId] })) }
    const active: ActiveCouncil = { binding: { schemaVersion: 1, record, context, connectionDigests, budgetContext, requestClaims: [] }, execution }
    this.councils.set(councilId, active)
    registerCouncilRequestBinding(active.binding, () => this.persist(active), () => this.runtime.metas())
    try {
      await this.persist(active)
      this.arm(active)
      const commands = await openProjectWorkspaceCommandService(this.rootDir)
      const parent = this.parent(input.sessionId)
      for (let index = 0; index < tasks.length; index++) {
        this.assertDispatchable(record)
        const participant = record.participants[index]
        const opinion = record.opinions[index]
        await commands.createWorkItem({ id: tasks[index].workItemId, projectId: record.projectId, goalId: record.goalId,
          parentId: record.workItemId, type: 'review', role: participant.institutionId, title: tasks[index].title,
          description: record.topic, businessLineId: parent.businessLineId })
        this.assertDispatchable(record)
        await this.runtime.create({ cwd: parent.cwd, workspaceId: record.projectId, goalId: record.goalId,
          workItemId: tasks[index].workItemId, parentSessionId: parent.id, orchestrationId: councilId,
          childTaskId: participant.institutionId, childRole: `council:${participant.institutionId}`, isolated: false,
          model: participant.model, providerId: participant.providerId, routingScope: 'fixed', budgetUsd: participant.budgetUsd,
          taskStrategy: 'view', title: tasks[index].title }, opinion.sessionId)
        this.assertDispatchable(record)
        const inputs = this.runtime.inputs()
        const receiptId = `goal-start-${councilId}`
        await inputs.queue(opinion.sessionId, receiptId, { text: tasks[index].prompt })
        this.assertDispatchable(record)
        opinion.status = 'running'
        record.phase = 'running'
        execution.tasks[index].status = 'running'
        execution.tasks[index].attempts = 1
        execution.tasks[index].startedAt = Date.now()
        await this.persist(active)
        this.assertDispatchable(record)
        const receipt = await inputs.apply(opinion.sessionId, receiptId)
        releases[index]()
        if (receipt.phase !== 'applied') {
          if (String(record.phase) === 'stopped') break
          opinion.status = 'needs_reconciliation'; opinion.error = receipt.error
          record.phase = 'needs_reconciliation'
          execution.tasks[index].status = 'failed'; execution.tasks[index].error = receipt.error
          await this.persist(active)
          break
        }
        this.runtime.acknowledge(opinion.sessionId)
      }
      await this.persist(active)
    } catch (error) {
      if (!['stopped', 'completed'].includes(record.phase)) {
        record.error = error instanceof Error ? error.message : String(error)
        record.phase = 'needs_reconciliation'
      }
      await this.persist(active)
    } finally { releases.forEach((release) => release()) }
    return structuredClone(record)
  }

  async stop(input: CouncilStopInput): Promise<CouncilRecord> {
    await this.runtime.ready()
    return this.stopBound(input)
  }

  async stopForParent(sessionId: string): Promise<void> {
    for (const { binding } of this.councils.values()) if (binding.record.sessionId === sessionId &&
      !['completed', 'stopped'].includes(binding.record.phase)) await this.stopBound({ sessionId, councilId: binding.record.councilId })
  }

  private async stopBound(input: CouncilStopInput): Promise<CouncilRecord> {
    const active = this.councils.get(input.councilId)
    if (!active || active.binding.record.sessionId !== input.sessionId) throw new Error('议事不属于此任务')
    const { record } = active.binding
    if (record.phase === 'completed' || record.phase === 'stopped') return structuredClone(record)
    record.phase = 'stopped'; record.completedAt = Date.now()
    clearTimeout(active.timer)
    // Save the stop before interrupting any in-flight request.
    await this.persist(active)
    await Promise.allSettled(record.opinions.map((opinion) => this.runtime.interrupt(opinion.sessionId)))
    for (let index = 0; index < record.opinions.length; index++) {
      const opinion = record.opinions[index]
      if (opinion.status === 'pending' || opinion.status === 'running') {
        opinion.status = 'failed'; opinion.error = '议事已停止；已发送请求的未知费用保留待核对'
        Object.assign(active.execution.tasks[index], { status: 'failed', completedAt: record.completedAt, error: opinion.error })
      }
    }
    this.archive(active)
    await this.persist(active)
    return structuredClone(record)
  }

  async complete(sessionId: string, result: { ok: boolean; resultText?: string; error?: string }): Promise<boolean> {
    const active = [...this.councils.values()].find(({ binding }) => binding.record.opinions.some((opinion) => opinion.sessionId === sessionId))
    if (!active) return false
    const { record } = active.binding
    const index = record.opinions.findIndex((opinion) => opinion.sessionId === sessionId)
    if (record.phase === 'stopped' || record.phase === 'completed') return true
    const opinion = record.opinions[index]
    opinion.status = result.ok ? 'completed' : 'failed'; opinion.conclusion = result.resultText?.slice(0, 32_000); opinion.error = result.error
    Object.assign(active.execution.tasks[index], { status: result.ok ? 'success' : 'failed', completedAt: Date.now(), resultText: opinion.conclusion, error: result.error })
    if (record.opinions.every((entry) => entry.status === 'completed' || entry.status === 'failed')) {
      record.phase = 'completed'; record.completedAt = Date.now(); clearTimeout(active.timer); this.archive(active)
    }
    await this.persist(active)
    return true
  }

  /** Restored dispatches are reconciled only; no child or prompt is recreated. */
  async restore(snapshot: TaskDagRuntimeSnapshot, execution: TaskDagExecutionView): Promise<void> {
    if (!snapshot.council || this.councils.has(execution.id)) return
    const active: ActiveCouncil = { binding: structuredClone(snapshot.council), execution: structuredClone(execution) }
    this.councils.set(execution.id, active)
    registerCouncilRequestBinding(active.binding, () => this.persist(active), () => this.runtime.metas())
    const { record } = active.binding
    if (record.phase === 'completed' || record.phase === 'stopped') return
    record.phase = 'needs_reconciliation'
    record.error = '应用重启：已保留子任务与提交标识，请核对已发送结果；不会自动重发'
    for (const opinion of record.opinions) {
      if (opinion.status === 'completed' || opinion.status === 'failed') continue
      const result = [...this.runtime.transcript(opinion.sessionId)].reverse().find(({ event }) => event.kind === 'turn-result')?.event
      if (result?.kind === 'turn-result') await this.complete(opinion.sessionId, { ok: !result.isError, resultText: result.resultText, error: result.isError ? result.resultText : undefined })
      else { opinion.status = 'needs_reconciliation'; opinion.error = '原始子任务执行结果待核对' }
    }
    if (String(record.phase) !== 'completed') this.archive(active)
    await this.persist(active)
  }

  snapshots(sessionId: string): TaskDagRuntimeSnapshot[] {
    return [...this.councils.values()].filter(({ binding }) => binding.record.sessionId === sessionId || binding.record.opinions.some((opinion) => opinion.sessionId === sessionId))
      .map(({ binding }) => ({ executionId: binding.record.councilId, parentSessionId: binding.record.sessionId, capturedAt: Date.now(),
        dispatchOptions: { taskTimeoutMs: binding.record.limits.timeoutMs, isolated: false, permissionMode: 'default' },
        runningTasks: binding.record.opinions.filter((opinion) => opinion.status === 'running').map((opinion) => ({ taskId: opinion.institutionId, sessionId: opinion.sessionId })),
        council: structuredClone(binding) }))
  }

  private parent(id: string): SessionMeta {
    checkedId(id)
    const meta = this.runtime.meta(id)
    if (!meta || meta.status === 'closed' || !meta.workspaceId || !meta.goalId || !meta.workItemId || meta.parentSessionId) throw new Error('请先打开原目标任务，再召集议事')
    return meta
  }
  private hydrate(): Promise<void> {
    if (!this.hydration) this.hydration = (async () => {
      const latest = new Map<string, { runtime: TaskDagRuntimeSnapshot; execution: TaskDagExecutionView }>()
      for (const snapshot of await listTaskSnapshots(this.rootDir)) for (const runtime of snapshot.dagRuntimes ?? []) {
        if (!runtime.council) continue
        const execution = snapshot.dagExecutions.find((entry) => entry.id === runtime.executionId)
        if (execution && (!latest.has(runtime.executionId) || latest.get(runtime.executionId)!.runtime.capturedAt < runtime.capturedAt)) {
          latest.set(runtime.executionId, { runtime, execution })
        }
      }
      for (const { runtime, execution } of latest.values()) await this.restore(runtime, execution)
    })().catch((error) => { this.hydration = undefined; throw error })
    return this.hydration
  }
  loadSnapshots(): Promise<void> { return this.hydrate() }
  private async persist(active: ActiveCouncil) {
    this.runtime.update(structuredClone(active.execution))
    const id = active.binding.record.sessionId
    if (this.runtime.meta(id)) await this.runtime.persist(id)
    else {
      const stored = await getTaskSnapshot(id, this.rootDir)
      if (!stored) throw new Error('议事原任务快照缺失，无法保存核对结果')
      await saveTaskSnapshot({ ...stored, updatedAt: Date.now(),
        dagExecutions: [...stored.dagExecutions.filter((entry) => entry.id !== active.execution.id), structuredClone(active.execution)],
        dagRuntimes: [...(stored.dagRuntimes ?? []).filter((entry) => entry.executionId !== active.execution.id),
          ...this.snapshots(id).filter((entry) => entry.executionId === active.execution.id)] }, this.rootDir, { projectWorkflow: false })
    }
  }
  private arm(active: ActiveCouncil) {
    active.timer = setTimeout(() => { void this.stopBound({ sessionId: active.binding.record.sessionId, councilId: active.binding.record.councilId }).catch(() => undefined) },
      Math.max(1, active.binding.record.deadlineAt - Date.now()))
    active.timer.unref?.()
  }
  private assertDispatchable(record: CouncilRecord) {
    if (!['preparing', 'running'].includes(record.phase) || Date.now() >= record.deadlineAt) throw new Error('议事已停止、超过截止时间或有提交结果待核对')
  }
  private archive(active: ActiveCouncil) {
    const { record } = active.binding
    record.report = [`# 议事：${record.topic}`, '', '单轮意见原文归档；不同意见保留，由用户裁决。',
      ...record.opinions.flatMap((opinion, index) => ['', `## ${record.participants[index].institutionName}`, opinion.conclusion ?? opinion.error ?? '尚未形成结论'])].join('\n')
    active.execution.summary = record.report
    if (record.phase === 'completed' || record.phase === 'stopped') {
      active.execution.status = record.opinions.every((opinion) => opinion.status === 'completed') ? 'success' : 'failed'
      active.execution.completedAt = record.completedAt
    }
  }
}

function checkedId(id: string) { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error('议事请求标识无效') }
function opinionPrompt(record: CouncilRecord, institutionId: string, context: string) {
  const participant = record.participants.find((entry) => entry.institutionId === institutionId)!
  return `你代表${participant.institutionName}，职责：${participant.duty}。本次只做一轮独立意见审阅。禁止工具、委派、实际操作或请求续轮。\n` +
    `只依据提供事实，分别写出“结论”“依据”“异议与缺失事实”“建议由用户决定的事项”；缺少证据必须明确说明。\n议题：${record.topic}\n原目标和任务上下文：\n${context}`
}
