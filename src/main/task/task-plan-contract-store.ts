import { randomUUID, createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { isWorkItemType } from '../../shared/project-workspace-types'
import { normalizeAcceptanceSpecs } from '../project-workspace/codec'
import { isProjectInstitutionTemplateRef, projectInstitutionTemplate, type ProjectInstitutionTemplateRef } from '../../shared/project-institution-template'
import {
  TASK_PLAN_SCHEMA_VERSION,
  type TaskPlanApprovalEvent,
  type TaskPlanApprovalInput,
  type TaskPlanDraftInput,
  type TaskPlanMissionSource,
  type TaskPlanRequirementSource,
  type TaskPlanInstitutionResponsibility,
  type TaskPlanExecutionAuthorization,
  type TaskPlanProjectionReceipt,
  type TaskPlanRiskLevel,
  type TaskPlanSessionBinding,
  type TaskPlanSource,
  type TaskPlanStateView,
  type TaskPlanStep,
  type TaskPlanVersion
} from '../../shared/task-plan-types'

interface TaskPlanSessionRecord {
  sessionId: string
  versions: TaskPlanVersion[]
  approvalEvents: TaskPlanApprovalEvent[]
}

interface TaskPlanStoreState {
  schemaVersion: typeof TASK_PLAN_SCHEMA_VERSION
  revision: number
  sessions: Record<string, TaskPlanSessionRecord>
}

export function validateTaskPlanSessionRecord(sessionId: string, value: unknown): void {
  validateSessionRecord(requiredId(sessionId, 'sessionId'), value)
}

const STORE_DIRECTORY = 'task-plans'
const STORE_FILE = 'task-plan-contracts.json'
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const MAX_VERSIONS_PER_SESSION = 100
const MAX_STEPS = 200
const MAX_APPROVAL_EVENTS_PER_SESSION = 500
const MAX_STORE_BYTES = 8 * 1024 * 1024

export class TaskPlanContractStore {
  constructor(private readonly userDataRoot: () => string) {}

  get(sessionId: string): TaskPlanStateView {
    const id = requiredId(sessionId, 'sessionId')
    const record = this.load().sessions[id]
    return stateView(id, record)
  }

  listAll(): TaskPlanStateView[] {
    const state = this.load()
    return Object.keys(state.sessions).sort().map((sessionId) => stateView(sessionId, state.sessions[sessionId]))
  }

  hasPlan(sessionId: string): boolean {
    return this.get(sessionId).currentVersion !== undefined
  }

  /** Removes the private Session-scoped plan record after its owner is deleted. */
  deleteSession(sessionId: string): boolean {
    const id = requiredId(sessionId, 'sessionId')
    const state = this.load()
    if (!state.sessions[id]) return false
    const { [id]: _removed, ...sessions } = state.sessions
    const removedEntries = state.sessions[id].versions.length + state.sessions[id].approvalEvents.length
    this.persist({
      ...state,
      revision: state.revision - removedEntries,
      sessions
    })
    return true
  }

  createVersion(
    bindingInput: TaskPlanSessionBinding,
    draftInput: TaskPlanDraftInput,
    createdBy: 'local-user' | 'agent'
  ): TaskPlanStateView {
    const binding = normalizeBinding(bindingInput)
    const draft = normalizeDraft(draftInput)
    const state = this.load()
    const current = state.sessions[binding.sessionId] ?? {
      sessionId: binding.sessionId,
      versions: [],
      approvalEvents: []
    }
    if (current.versions.length >= MAX_VERSIONS_PER_SESSION) throw new Error('计划版本数量已达上限')
    if (current.versions.length > 0 && !draft.changeReason) throw new Error('新计划版本必须填写变更原因')

    const versionNumber = current.versions.length + 1
    const digest = planDigest(binding, draft)
    const previous = current.versions.at(-1)
    if (previous && canonicalJson(previous.binding) !== canonicalJson(binding)) {
      throw new Error('计划版本不能改变原有 Session/Workspace/Goal/WorkItem 绑定')
    }
    if (previous?.digest === digest) throw new Error('计划内容没有实质变化，未创建重复版本')

    const now = Date.now()
    const nextVersion: TaskPlanVersion = {
      schemaVersion: TASK_PLAN_SCHEMA_VERSION,
      id: randomUUID(),
      binding,
      version: versionNumber,
      digest,
      objective: draft.objective,
      steps: draft.steps,
      expectedArtifacts: draft.expectedArtifacts,
      dataEgress: draft.dataEgress,
      estimatedCostUsd: draft.estimatedCostUsd,
      riskLevel: draft.riskLevel,
      acceptanceCriteria: draft.acceptanceCriteria,
      changeReason: draft.changeReason,
      source: draft.source,
      ...(draft.missionSource ? { missionSource: draft.missionSource } : {}),
      ...(draft.requirementSource ? { requirementSource: draft.requirementSource } : {}),
      ...(draft.institutionTemplate ? { institutionTemplate: draft.institutionTemplate } : {}),
      createdBy,
      createdAt: now
    }
    const approvalEvents = [...current.approvalEvents]
    const active = activeApproval(current)
    if (active) approvalEvents.push(approvalEvent(binding.sessionId, 'superseded', active, '计划产生了新版本', now))
    const nextRecord: TaskPlanSessionRecord = {
      sessionId: binding.sessionId,
      versions: [...current.versions, nextVersion],
      approvalEvents
    }
    const nextState = withSession(state, nextRecord)
    this.persist(nextState)
    return stateView(binding.sessionId, nextRecord)
  }

  approve(
    sessionId: string,
    input: TaskPlanApprovalInput,
    projection?: TaskPlanProjectionReceipt,
    actorId = 'local-user'
  ): TaskPlanStateView {
    const id = requiredId(sessionId, 'sessionId')
    const expected = normalizeApprovalInput(input)
    const state = this.load()
    const record = state.sessions[id]
    const current = record?.versions.at(-1)
    if (!record || !current) throw new Error('当前会话还没有可审批的计划版本')
    assertExpectedVersion(current, expected)
    const normalizedProjection = projection === undefined
      ? undefined
      : normalizeProjectionReceipt(projection, current)
    const active = activeApproval(record)
    if (active?.version === current.version && active.digest === current.digest &&
      canonicalJson(active.projection) === canonicalJson(normalizedProjection)) {
      return stateView(id, record)
    }
    if (record.approvalEvents.length >= MAX_APPROVAL_EVENTS_PER_SESSION) throw new Error('计划审批事件数量已达上限')

    const nextRecord: TaskPlanSessionRecord = {
      ...record,
      approvalEvents: [...record.approvalEvents, {
        schemaVersion: TASK_PLAN_SCHEMA_VERSION,
        id: randomUUID(),
        sessionId: id,
        kind: 'approved',
        version: current.version,
        digest: current.digest,
        actor: 'local-user',
        actorId: normalizeActorId(actorId),
        reason: optionalText(expected.reason, 1_000),
        projection: normalizedProjection,
        occurredAt: Date.now()
      }]
    }
    this.persist(withSession(state, nextRecord))
    return stateView(id, nextRecord)
  }

  revoke(sessionId: string, input: TaskPlanApprovalInput, actorId = 'local-user'): TaskPlanStateView {
    const id = requiredId(sessionId, 'sessionId')
    const expected = normalizeApprovalInput(input)
    const state = this.load()
    const record = state.sessions[id]
    const current = record?.versions.at(-1)
    if (!record || !current) throw new Error('当前会话还没有计划版本')
    assertExpectedVersion(current, expected)
    const active = activeApproval(record)
    if (!active) return stateView(id, record)
    if (record.approvalEvents.length >= MAX_APPROVAL_EVENTS_PER_SESSION) throw new Error('计划审批事件数量已达上限')
    const nextRecord: TaskPlanSessionRecord = {
      ...record,
      approvalEvents: [
        ...record.approvalEvents,
        approvalEvent(id, 'revoked', active, optionalText(expected.reason, 1_000) || '用户撤销审批', Date.now(), actorId)
      ]
    }
    this.persist(withSession(state, nextRecord))
    return stateView(id, nextRecord)
  }

  executionAuthorization(sessionId: string, requirePlan: boolean): TaskPlanExecutionAuthorization {
    const view = this.get(sessionId)
    if (!view.currentVersion) {
      return requirePlan
        ? { required: true, approved: false, reason: '规划策略尚未形成结构化计划，不能切换到执行' }
        : { required: false, approved: true }
    }
    if (view.approvalStatus !== 'approved') {
      return {
        required: true,
        approved: false,
        version: view.currentVersion.version,
        digest: view.currentVersion.digest,
        reason: `计划 v${view.currentVersion.version} 尚未批准或已被后续版本取代`
      }
    }
    return {
      required: true,
      approved: true,
      version: view.approvedVersion,
      digest: view.approvedDigest
    }
  }

  assertExecutionAuthorized(sessionId: string, requirePlan: boolean): TaskPlanExecutionAuthorization {
    const authorization = this.executionAuthorization(sessionId, requirePlan)
    if (!authorization.approved) throw new Error(authorization.reason ?? '当前计划没有执行授权')
    return authorization
  }

  private filePath(): string {
    return path.join(this.userDataRoot(), STORE_DIRECTORY, STORE_FILE)
  }

  private load(): TaskPlanStoreState {
    const file = this.filePath()
    if (!existsSync(file)) return emptyState()
    let parsed: unknown
    try {
      assertPrivateStorePath(file)
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      throw new Error('计划合同存储损坏，已阻止执行')
    }
    return validateStoreState(parsed)
  }

  private persist(state: TaskPlanStoreState): void {
    validateStoreState(state)
    const target = this.filePath()
    const directory = path.dirname(target)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    assertPrivateStoreDirectory(directory)
    if (process.platform !== 'win32') chmodSync(directory, 0o700)
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, target)
      if (process.platform !== 'win32') chmodSync(target, 0o600)
      fsyncDirectory(directory)
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor)
      if (existsSync(temporary)) unlinkSync(temporary)
      throw error
    }
  }
}

function emptyState(): TaskPlanStoreState {
  return { schemaVersion: TASK_PLAN_SCHEMA_VERSION, revision: 0, sessions: {} }
}

function withSession(state: TaskPlanStoreState, record: TaskPlanSessionRecord): TaskPlanStoreState {
  const previous = state.sessions[record.sessionId]
  const previousEntries = (previous?.versions.length ?? 0) + (previous?.approvalEvents.length ?? 0)
  const nextEntries = record.versions.length + record.approvalEvents.length
  return {
    ...state,
    revision: state.revision + (nextEntries - previousEntries),
    sessions: { ...state.sessions, [record.sessionId]: record }
  }
}

function stateView(sessionId: string, record?: TaskPlanSessionRecord): TaskPlanStateView {
  if (!record) return { sessionId, versions: [], approvalEvents: [], approvalStatus: 'not_created' }
  const currentVersion = record.versions.at(-1)
  const active = activeApproval(record)
  return clone({
    sessionId,
    currentVersion,
    versions: record.versions,
    approvalEvents: record.approvalEvents,
    approvalStatus: currentVersion && active?.version === currentVersion.version && active.digest === currentVersion.digest
      ? 'approved'
      : 'pending',
    approvedVersion: active?.version,
    approvedDigest: active?.digest,
    projection: active?.projection
  })
}

function activeApproval(record: TaskPlanSessionRecord): TaskPlanApprovalEvent | undefined {
  let active: TaskPlanApprovalEvent | undefined
  for (const event of record.approvalEvents) {
    if (event.kind === 'approved') active = event
    else if (active && event.version === active.version && event.digest === active.digest) active = undefined
  }
  return active
}

function approvalEvent(
  sessionId: string,
  kind: 'revoked' | 'superseded',
  active: TaskPlanApprovalEvent,
  reason: string,
  occurredAt: number,
  actorId = kind === 'revoked' ? 'local-user' : 'system'
): TaskPlanApprovalEvent {
  return {
    schemaVersion: TASK_PLAN_SCHEMA_VERSION,
    id: randomUUID(),
    sessionId,
    kind,
    version: active.version,
    digest: active.digest,
    actor: kind === 'revoked' ? 'local-user' : 'system',
    actorId: normalizeActorId(actorId),
    reason,
    occurredAt
  }
}

function normalizeBinding(input: TaskPlanSessionBinding): TaskPlanSessionBinding {
  const sessionId = requiredId(input?.sessionId, 'sessionId')
  const workspaceId = optionalId(input.workspaceId)
  const goalId = optionalId(input.goalId)
  const workItemId = optionalId(input.workItemId)
  if ((goalId || workItemId) && !workspaceId) throw new Error('计划绑定 Goal/WorkItem 时必须绑定 Workspace')
  return { sessionId, workspaceId, goalId, workItemId }
}

function normalizeDraft(input: TaskPlanDraftInput): Omit<TaskPlanVersion, 'schemaVersion' | 'id' | 'binding' | 'version' | 'digest' | 'createdBy' | 'createdAt'> {
  if (!input || typeof input !== 'object') throw new Error('计划草案无效')
  const objective = requiredText(input.objective, '计划目标', 20_000)
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > MAX_STEPS) {
    throw new Error(`计划步骤必须为 1-${MAX_STEPS} 项`)
  }
  const steps = input.steps.map((step, index) => normalizeStep(step, index))
  assertStepGraph(steps)
  const institutionTemplate = normalizePlanInstitutionTemplate(input.institutionTemplate, steps)
  const acceptanceCriteria = stringList(input.acceptanceCriteria, 'Acceptance', 200, 2_000, true)
  return {
    objective,
    steps,
    expectedArtifacts: stringList(input.expectedArtifacts, '预期产物', 200, 2_000),
    dataEgress: stringList(input.dataEgress, '数据外发', 100, 2_000),
    estimatedCostUsd: cost(input.estimatedCostUsd),
    riskLevel: riskLevel(input.riskLevel),
    acceptanceCriteria,
    changeReason: optionalText(input.changeReason, 1_000) ?? '',
    source: source(input.source),
    ...(input.missionSource !== undefined ? { missionSource: normalizeMissionSource(input.missionSource) } : {}),
    ...(input.requirementSource !== undefined ? { requirementSource: normalizeRequirementSource(input.requirementSource) } : {}),
    ...(institutionTemplate ? { institutionTemplate } : {})
  }
}

function normalizeMissionSource(input: TaskPlanMissionSource): TaskPlanMissionSource {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['goalRevision', 'inputDigest', 'missionDigest'].includes(key)) ||
      !Number.isSafeInteger(input.goalRevision) || input.goalRevision < 1 ||
      !/^[0-9a-f]{64}$/.test(input.inputDigest) || !/^[0-9a-f]{64}$/.test(input.missionDigest)) {
    throw new Error('Mission 计划来源无效')
  }
  return { goalRevision: input.goalRevision, inputDigest: input.inputDigest, missionDigest: input.missionDigest }
}

function normalizeRequirementSource(input: TaskPlanRequirementSource): TaskPlanRequirementSource {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['eventId', 'goalRevision', 'contractDigest'].includes(key)) ||
      !/^goal-requirement:[a-f0-9]{64}$/.test(input.eventId) ||
      !Number.isSafeInteger(input.goalRevision) || input.goalRevision < 1 ||
      !/^[a-f0-9]{64}$/.test(input.contractDigest)) throw new Error('交付要求计划来源无效')
  return { eventId: input.eventId, goalRevision: input.goalRevision, contractDigest: input.contractDigest }
}

function normalizeStep(input: TaskPlanDraftInput['steps'][number], index: number): TaskPlanStep {
  if (!input || typeof input !== 'object') throw new Error(`计划步骤 ${index + 1} 无效`)
  return {
    id: requiredId(input.id, `步骤 ${index + 1} ID`),
    title: requiredText(input.title, `步骤 ${index + 1} 标题`, 500),
    description: optionalText(input.description, 10_000) ?? '',
    dependsOn: stringList(input.dependsOn, `步骤 ${index + 1} 依赖`, MAX_STEPS, 200),
    expectedArtifacts: stringList(input.expectedArtifacts, `步骤 ${index + 1} 产物`, 50, 2_000),
    dataEgress: stringList(input.dataEgress, `步骤 ${index + 1} 外发`, 50, 2_000),
    estimatedCostUsd: cost(input.estimatedCostUsd),
    riskLevel: riskLevel(input.riskLevel),
    // Omit absent extensions so existing version and approval digests stay valid.
    ...(input.role === undefined ? {} : { role: requiredId(input.role, '步骤岗位') }),
    ...(input.executionRole === undefined ? {} : { executionRole: normalizeExecutionRole(input.executionRole) }),
    ...(input.workItemType === undefined ? {} : { workItemType: normalizeStepWorkItemType(input.workItemType) }),
    ...(input.acceptanceSpec === undefined ? {} : { acceptanceSpec: normalizeStepAcceptance(input.acceptanceSpec) }),
    ...(input.institution === undefined ? {} : { institution: normalizeStepInstitution(input.institution) })
  }
}

function normalizeStepInstitution(value: TaskPlanInstitutionResponsibility): TaskPlanInstitutionResponsibility {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !['id', 'label', 'duty'].includes(key))) throw new Error('计划步骤机构职责无效')
  return {
    id: requiredId(value.id, '计划步骤机构 ID'),
    label: requiredText(value.label, '计划步骤机构名称', 200),
    duty: requiredText(value.duty, '计划步骤机构职责', 2_000)
  }
}

function normalizePlanInstitutionTemplate(value: ProjectInstitutionTemplateRef | undefined, steps: TaskPlanStep[]): ProjectInstitutionTemplateRef | undefined {
  if (value === undefined) {
    if (steps.some((step) => step.institution !== undefined)) throw new Error('计划机构职责缺少模板版本')
    return undefined
  }
  if (!isProjectInstitutionTemplateRef(value)) throw new Error('计划机构模板版本无效')
  const roles = projectInstitutionTemplate(value).roles
  if (steps.some((step) => !step.institution || !roles.some((role) => role.id === step.institution!.id))) {
    throw new Error('计划步骤机构职责与模板不匹配')
  }
  return { ...value }
}

function normalizeExecutionRole(value: unknown): NonNullable<TaskPlanStep['executionRole']> {
  if (typeof value !== 'string' || !['frontend', 'backend', 'qa', 'docs', 'devops', 'review', 'general'].includes(value)) {
    throw new Error('计划步骤执行角色无效')
  }
  return value as NonNullable<TaskPlanStep['executionRole']>
}

function normalizeStepWorkItemType(value: unknown): NonNullable<TaskPlanStep['workItemType']> {
  if (!isWorkItemType(value)) throw new Error('计划步骤 WorkItem 类型无效')
  return value
}

function normalizeStepAcceptance(value: NonNullable<TaskPlanStep['acceptanceSpec']>): NonNullable<TaskPlanStep['acceptanceSpec']> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) throw new Error('计划步骤验收条件必须为 1-200 项')
  return normalizeAcceptanceSpecs(value, '计划步骤验收条件')
}

function assertStepGraph(steps: TaskPlanStep[]): void {
  const byId = new Map<string, TaskPlanStep>()
  for (const step of steps) {
    if (byId.has(step.id)) throw new Error(`计划步骤 ID 重复: ${step.id}`)
    byId.set(step.id, step)
  }
  for (const step of steps) {
    if (step.dependsOn.includes(step.id)) throw new Error(`计划步骤不能依赖自身: ${step.id}`)
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`计划步骤依赖不存在: ${dependency}`)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('计划步骤依赖形成循环')
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const step of steps) visit(step.id)
}

function planDigest(
  binding: TaskPlanSessionBinding,
  draft: ReturnType<typeof normalizeDraft>
): string {
  const material = {
    binding,
    objective: draft.objective,
    steps: draft.steps,
    expectedArtifacts: draft.expectedArtifacts,
    dataEgress: draft.dataEgress,
    estimatedCostUsd: draft.estimatedCostUsd,
    riskLevel: draft.riskLevel,
    acceptanceCriteria: draft.acceptanceCriteria,
    ...(draft.missionSource ? { missionSource: draft.missionSource } : {}),
    ...(draft.requirementSource ? { requirementSource: draft.requirementSource } : {}),
    ...(draft.institutionTemplate ? { institutionTemplate: draft.institutionTemplate } : {})
  }
  return `sha256:${createHash('sha256').update(canonicalJson(material)).digest('hex')}`
}

function validateStoreState(value: unknown): TaskPlanStoreState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('计划合同存储格式无效')
  const state = value as Partial<TaskPlanStoreState>
  if (state.schemaVersion !== TASK_PLAN_SCHEMA_VERSION || !Number.isInteger(state.revision) || (state.revision ?? -1) < 0) {
    throw new Error('计划合同存储版本或修订号无效')
  }
  if (!state.sessions || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) {
    throw new Error('计划合同会话索引无效')
  }
  let revision = 0
  for (const [sessionId, record] of Object.entries(state.sessions)) {
    validateSessionRecord(sessionId, record)
    const session = record as TaskPlanSessionRecord
    revision += session.versions.length + session.approvalEvents.length
  }
  if (revision !== state.revision) throw new Error('计划合同存储修订号不一致')
  return state as TaskPlanStoreState
}

function validateSessionRecord(sessionId: string, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('计划合同会话记录无效')
  const record = value as TaskPlanSessionRecord
  if (record.sessionId !== sessionId || !Array.isArray(record.versions) || !Array.isArray(record.approvalEvents)) {
    throw new Error('计划合同会话记录结构无效')
  }
  if (record.versions.length > MAX_VERSIONS_PER_SESSION || record.approvalEvents.length > MAX_APPROVAL_EVENTS_PER_SESSION) {
    throw new Error('计划合同会话记录超过数量限制')
  }
  const byVersion = validateVersionHistory(sessionId, record.versions)
  validateApprovalHistory(sessionId, record.approvalEvents, byVersion)
}

function validateVersionHistory(sessionId: string, versions: TaskPlanVersion[]): Map<number, TaskPlanVersion> {
  let expectedVersion = 1
  const byVersion = new Map<number, TaskPlanVersion>()
  let initialBinding: TaskPlanSessionBinding | undefined
  for (const version of versions) {
    const { binding, draft } = validatePlanVersion(sessionId, version, expectedVersion)
    if (!initialBinding) initialBinding = binding
    else if (canonicalJson(initialBinding) !== canonicalJson(binding)) throw new Error('计划版本绑定历史不一致')
    byVersion.set(version.version, version)
    expectedVersion += 1
  }
  return byVersion
}

function validatePlanVersion(sessionId: string, version: TaskPlanVersion, expectedVersion: number) {
  if (version.schemaVersion !== TASK_PLAN_SCHEMA_VERSION || version.version !== expectedVersion) {
    throw new Error('计划版本历史不连续')
  }
  const binding = normalizeBinding(version.binding)
  if (binding.sessionId !== sessionId) throw new Error('计划版本会话绑定不一致')
  const draft = normalizeDraft(version)
  if (canonicalJson(planVersionMaterial(version)) !== canonicalJson(planVersionMaterial(draft))) {
    throw new Error('计划版本字段未规范化，已阻止执行')
  }
  if (expectedVersion > 1 && !draft.changeReason) throw new Error('计划版本变更原因缺失')
  if (planDigest(binding, draft) !== version.digest || !DIGEST_PATTERN.test(version.digest)) {
    throw new Error('计划版本摘要校验失败，已阻止执行')
  }
  validatePlanVersionMetadata(version)
  return { binding, draft }
}

function validatePlanVersionMetadata(version: TaskPlanVersion): void {
  const validCreator = version.createdBy === 'local-user' || version.createdBy === 'agent'
  if (typeof version.id !== 'string' || !version.id || !Number.isFinite(version.createdAt) ||
    version.createdAt <= 0 || !validCreator) {
    throw new Error('计划版本元数据无效')
  }
}

function validateApprovalHistory(
  sessionId: string,
  events: TaskPlanApprovalEvent[],
  byVersion: Map<number, TaskPlanVersion>
): void {
  for (const event of events) validateApprovalEvent(sessionId, event, byVersion.get(event.version))
}

function validateApprovalEvent(
  sessionId: string,
  event: TaskPlanApprovalEvent,
  version: TaskPlanVersion | undefined
): void {
  if (!validApprovalReference(sessionId, event, version)) approvalHistoryError()
  if (!validApprovalShape(event)) approvalHistoryError()
  if (event.projection !== undefined) normalizeProjectionReceipt(event.projection, version!)
  if (!validApprovalActor(event.actor)) approvalHistoryError()
  if (event.kind === 'approved' && event.actor !== 'local-user') approvalHistoryError()
  if (event.kind === 'superseded' && event.actor !== 'system') approvalHistoryError()
}

function normalizeProjectionReceipt(
  input: TaskPlanProjectionReceipt,
  version: TaskPlanVersion
): TaskPlanProjectionReceipt {
  assertProjectionReceiptShape(input)
  const workspaceId = optionalId(input.workspaceId)
  const goalId = optionalId(input.goalId)
  const parentWorkItemId = optionalId(input.parentWorkItemId)
  if (input.mode === 'conversation') {
    return normalizeConversationProjection(input, version, workspaceId, goalId, parentWorkItemId)
  }
  return normalizeCanonicalProjection(input, version, workspaceId, goalId, parentWorkItemId)
}

function assertProjectionReceiptShape(input: TaskPlanProjectionReceipt): void {
  const valid = [
    Boolean(input),
    typeof input === 'object',
    input.schemaVersion === TASK_PLAN_SCHEMA_VERSION,
    input.mode === 'conversation' || input.mode === 'canonical',
    Number.isFinite(input.projectedAt),
    input.projectedAt > 0,
    Array.isArray(input.steps)
  ].every(Boolean)
  if (!valid) throw new Error('计划 canonical 投影回执无效')
}

function normalizeConversationProjection(
  input: TaskPlanProjectionReceipt,
  version: TaskPlanVersion,
  workspaceId: string | undefined,
  goalId: string | undefined,
  parentWorkItemId: string | undefined
): TaskPlanProjectionReceipt {
  if ([workspaceId, goalId, parentWorkItemId, input.steps.length > 0, version.binding.workspaceId].some(Boolean)) {
    throw new Error('对话计划投影回执与绑定不一致')
  }
  return {
    schemaVersion: TASK_PLAN_SCHEMA_VERSION,
    mode: 'conversation',
    steps: [],
    projectedAt: input.projectedAt
  }
}

function normalizeCanonicalProjection(
  input: TaskPlanProjectionReceipt,
  version: TaskPlanVersion,
  workspaceId: string | undefined,
  goalId: string | undefined,
  parentWorkItemId: string | undefined
): TaskPlanProjectionReceipt {
  if (!workspaceId || !parentWorkItemId || workspaceId !== version.binding.workspaceId ||
    goalId !== version.binding.goalId || parentWorkItemId !== version.binding.workItemId) {
    throw new Error('计划 canonical 投影回执与绑定不一致')
  }
  const expectedSteps = new Set(version.steps.map((step) => step.id))
  const seenSteps = new Set<string>()
  const seenWorkItems = new Set<string>()
  const steps = input.steps.map((step) => {
    const stepId = requiredId(step?.stepId, 'projection stepId')
    const workItemId = requiredId(step?.workItemId, 'projection workItemId')
    if (!expectedSteps.has(stepId) || seenSteps.has(stepId) || seenWorkItems.has(workItemId)) {
      throw new Error('计划 canonical 投影步骤回执无效')
    }
    seenSteps.add(stepId)
    seenWorkItems.add(workItemId)
    return { stepId, workItemId }
  })
  if (seenSteps.size !== expectedSteps.size) throw new Error('计划 canonical 投影步骤不完整')
  return {
    schemaVersion: TASK_PLAN_SCHEMA_VERSION,
    mode: 'canonical',
    workspaceId,
    goalId,
    parentWorkItemId,
    steps,
    projectedAt: input.projectedAt
  }
}

function validApprovalReference(
  sessionId: string,
  event: TaskPlanApprovalEvent,
  version: TaskPlanVersion | undefined
): boolean {
  return Boolean(version) && event.digest === version?.digest && event.sessionId === sessionId
}

function validApprovalShape(event: TaskPlanApprovalEvent): boolean {
  return event.schemaVersion === TASK_PLAN_SCHEMA_VERSION && validApprovalKind(event.kind) &&
    typeof event.id === 'string' && Boolean(event.id) &&
    Number.isFinite(event.occurredAt) && event.occurredAt > 0 &&
    (event.actorId === undefined || Boolean(normalizeActorId(event.actorId)))
}

function normalizeActorId(value: unknown): string {
  const actorId = typeof value === 'string' ? value.trim() : ''
  if (!actorId || actorId.length > 200 || /[\u0000-\u001f\u007f]/.test(actorId)) {
    throw new Error('计划审批主体身份无效')
  }
  return actorId
}

function validApprovalActor(actor: unknown): actor is TaskPlanApprovalEvent['actor'] {
  return actor === 'local-user' || actor === 'system'
}

function validApprovalKind(value: unknown): value is TaskPlanApprovalEvent['kind'] {
  return value === 'approved' || value === 'revoked' || value === 'superseded'
}

function approvalHistoryError(): never {
  throw new Error('计划审批历史校验失败，已阻止执行')
}

function planVersionMaterial(value: ReturnType<typeof normalizeDraft> | TaskPlanVersion) {
  return {
    objective: value.objective,
    steps: value.steps,
    expectedArtifacts: value.expectedArtifacts,
    dataEgress: value.dataEgress,
    estimatedCostUsd: value.estimatedCostUsd,
    riskLevel: value.riskLevel,
    acceptanceCriteria: value.acceptanceCriteria,
    changeReason: value.changeReason,
    source: value.source,
    ...(value.missionSource ? { missionSource: value.missionSource } : {}),
    ...(value.requirementSource ? { requirementSource: value.requirementSource } : {}),
    ...(value.institutionTemplate ? { institutionTemplate: value.institutionTemplate } : {})
  }
}

function assertExpectedVersion(version: TaskPlanVersion, input: TaskPlanApprovalInput): void {
  if (input.version !== version.version || input.digest !== version.digest) {
    throw new Error('计划审批目标已变化，请重新审查当前版本')
  }
}

function normalizeApprovalInput(input: TaskPlanApprovalInput): TaskPlanApprovalInput {
  if (!input || !Number.isInteger(input.version) || input.version < 1 || !DIGEST_PATTERN.test(input.digest ?? '')) {
    throw new Error('计划审批版本或摘要无效')
  }
  return { version: input.version, digest: input.digest, reason: optionalText(input.reason, 1_000) }
}

function requiredId(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > 200 || /[\u0000-\u001f]/.test(text)) throw new Error(`${label} 无效`)
  return text
}

function optionalId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredId(value, '计划绑定 ID')
}

function requiredText(value: unknown, label: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max) throw new Error(`${label} 无效`)
  return text
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length > max) throw new Error('计划文本超过长度限制')
  return text || undefined
}

function stringList(
  value: unknown,
  label: string,
  maxItems: number,
  maxLength: number,
  required = false
): string[] {
  if (value === undefined && !required) return []
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} 列表无效`)
  const normalized = [...new Set(value.map((item) => requiredText(item, label, maxLength)))]
  if (required && normalized.length === 0) throw new Error(`${label} 至少需要一项`)
  return normalized
}

function cost(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new Error('计划成本估算无效')
  }
  return Number(value.toFixed(6))
}

function riskLevel(value: unknown): TaskPlanRiskLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical' ? value : 'medium'
}

function source(value: unknown): TaskPlanSource {
  return value === 'genesis' ? 'genesis' : 'manual'
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined
  try {
    descriptor = openSync(directory, 'r')
    fsyncSync(descriptor)
  } catch {
    // The file itself is durable on platforms that do not support directory fsync.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function assertPrivateStorePath(file: string): void {
  assertPrivateStoreDirectory(path.dirname(file))
  const info = lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STORE_BYTES) {
    throw new Error('计划合同存储文件无效')
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error('计划合同存储权限无效')
  }
}

function assertPrivateStoreDirectory(directory: string): void {
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('计划合同存储目录无效')
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error('计划合同存储目录权限无效')
  }
}
