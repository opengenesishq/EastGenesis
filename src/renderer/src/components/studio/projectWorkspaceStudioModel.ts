import type {
  AcceptanceResult,
  AcceptanceResultStatus,
  AcceptanceSpec,
  Goal,
  GoalInput,
  GoalPatch,
  GoalRiskLevel,
  GoalStatus,
  OutboundDataClass,
  ConnectorAuthorizationSubject,
  ConnectorDataDirection,
  ConnectorResourceUsage,
  ProjectConnectorCatalogEntry,
  ProjectResource,
  ProjectResourceEgressPolicy,
  ProjectResourceInput,
  ProjectWorkspaceKind,
  ProjectWorkspaceStatus,
  WorkItemInput,
  WorkItem,
  WorkItemReorderPlacement,
  WorkItemStatus,
  WorkItemType
} from '../../../../shared/types'
import {
  COLLAB_TEXT,
  GOAL_RISK_OPTIONS,
  GOAL_STATUS_LABELS,
  PROJECT_KIND_OPTIONS,
  PROJECT_RESOURCE_OPTIONS,
  PROJECT_STATUS_LABELS,
  RESOURCE_DATA_CLASS_OPTIONS,
  RESOURCE_EGRESS_OPTIONS,
  TEXT,
  WORK_ITEM_STATUSES,
  WORK_ITEM_STATUS_LABELS,
  WORK_ITEM_TYPE_OPTIONS,
  currentLanguage,
  localized,
  type ResourceDraftKind
} from './projectWorkspaceStudioLocale'

export {
  COLLAB_TEXT,
  GOAL_RISK_OPTIONS,
  GOAL_STATUS_LABELS,
  PROJECT_KIND_OPTIONS,
  PROJECT_RESOURCE_OPTIONS,
  PROJECT_STATUS_LABELS,
  RESOURCE_DATA_CLASS_OPTIONS,
  RESOURCE_EGRESS_OPTIONS,
  TEXT,
  WORK_ITEM_STATUSES,
  WORK_ITEM_STATUS_LABELS,
  WORK_ITEM_TYPE_OPTIONS,
  type ResourceDraftKind
}


export type StudioView = 'list' | 'board'
export type StudioCreateForm = 'project' | 'goal' | 'workItem' | null
export type StudioMutationKind = Exclude<StudioCreateForm, null> | 'import'
export type ProjectLifecyclePanel = 'edit' | 'resource' | null
export type ProjectLifecycleMutation = 'update' | 'resource' | 'archive' | 'restore' | 'export' | 'delete' | 'purge'

export type WorkItemControlAction =
  | { kind: 'transition'; status: WorkItemStatus }
  | { kind: 'lease'; operation: 'acquire' | 'renew' | 'release' }

export type GoalControlAction =
  | { kind: 'transition'; status: GoalStatus }
  | { kind: 'archive' }
  | { kind: 'restore' }

export type WorkItemOwnerFilter = 'all' | 'unassigned' | 'human' | 'digital_worker'

export interface WorkItemFilters {
  query: string
  status: 'all' | WorkItemStatus
  goalId: 'all' | 'none' | string
  owner: WorkItemOwnerFilter
}

export interface WorkItemReorderAction {
  targetId: string
  placement: WorkItemReorderPlacement
}

export interface ProjectEditDraft {
  name: string
  kind: ProjectWorkspaceKind
  ownerId: string
  rulesRef: string
}

export interface ProjectResourceDraft {
  kind: ResourceDraftKind
  label: string
  location: string
  dataClass: OutboundDataClass
  egressPolicy: ProjectResourceEgressPolicy
  connectorUsage: ConnectorResourceUsage[]
  connectorId: string
  connectorCapabilities: string
  connectorDataDirection: ConnectorDataDirection
  connectorAuthorizationSubject: ConnectorAuthorizationSubject
  connectorPrincipalId: string
  connectorCredentialRef: string
  connectorScopes: string
  connectorVersion: string
  connectorReconciliation: 'queryable' | 'manual_only'
}

export interface GoalDraft {
  title: string
  objective: string
  background: string
  constraints: string
  successCriteria: string
  acceptance: string
  deliverables: string
  forbiddenActions: string
  riskLevel: GoalRiskLevel
  dueDate: string
  budgetAmount: string
  budgetCurrency: string
  budgetRuns: string
  budgetConcurrentRuns: string
  budgetTokens: string
}

export interface WorkItemDraft {
  title: string
  description: string
  goalId: string
  type: WorkItemType
  priority: string
  ownerType: 'human' | 'digital_worker'
  ownerId: string
  ownerName: string
  dueDate: string
  parentId: string
  dependencyIds: string[]
  acceptance: string
}

export interface AcceptancePresentation {
  status: AcceptanceResultStatus | 'unset'
  label: string
}


export const GOAL_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  draft: ['planned', 'cancelled'],
  planned: ['running', 'cancelled'],
  running: ['waiting_approval', 'blocked', 'verifying', 'cancelled'],
  waiting_approval: ['running', 'blocked'],
  blocked: ['running', 'failed', 'cancelled'],
  verifying: ['completed', 'running', 'blocked', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
  archived: []
}

export const DEFAULT_WORK_ITEM_FILTERS: WorkItemFilters = {
  query: '',
  status: 'all',
  goalId: 'all',
  owner: 'all'
}

/** Keep the renderer action surface aligned with the main-process state machine. */
export const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  backlog: ['ready', 'cancelled'],
  ready: ['running', 'cancelled'],
  running: ['waiting_approval', 'blocked', 'verifying', 'cancelled'],
  waiting_approval: ['running', 'blocked'],
  blocked: ['ready', 'failed', 'cancelled'],
  verifying: ['done', 'failed', 'ready'],
  done: [],
  failed: [],
  cancelled: []
}

export const EMPTY_GOAL_DRAFT: GoalDraft = {
  title: '', objective: '', background: '', constraints: '', successCriteria: '', acceptance: '', deliverables: '',
  forbiddenActions: '', riskLevel: 'medium', dueDate: '', budgetAmount: '', budgetCurrency: 'USD',
  budgetRuns: '', budgetConcurrentRuns: '', budgetTokens: ''
}

export const EMPTY_WORK_ITEM_DRAFT: WorkItemDraft = {
  title: '', description: '', goalId: '', type: 'custom', priority: '0', ownerType: 'human',
  ownerId: '', ownerName: '', dueDate: '', parentId: '', dependencyIds: [], acceptance: ''
}

export function goalInputFromDraft(projectId: string, draft: GoalDraft): GoalInput {
  return {
    projectId,
    title: draft.title.trim(),
    contract: goalContractFromDraft(draft)
  }
}

export function goalDraftFromGoal(goal: Goal): GoalDraft {
  return {
    title: goal.title,
    objective: goal.objective,
    background: goal.background ?? '',
    constraints: goal.constraints.join('\n'),
    successCriteria: goal.successCriteria.filter((item) => !item.startsWith('交付物：')).join('\n'),
    acceptance: goal.acceptance.map((item) => item.criterion).join('\n'),
    deliverables: goal.successCriteria.filter((item) => item.startsWith('交付物：')).map((item) => item.slice('交付物：'.length)).join('\n'),
    forbiddenActions: goal.forbiddenActions.join('\n'),
    riskLevel: goal.riskLevel,
    dueDate: dateInputValue(goal.dueAt),
    budgetAmount: goal.budget?.amount === undefined ? '' : String(goal.budget.amount),
    budgetCurrency: goal.budget?.currency ?? 'USD',
    budgetRuns: goal.budget?.maxRuns === undefined ? '' : String(goal.budget.maxRuns),
    budgetConcurrentRuns: goal.budget?.maxConcurrentRuns === undefined
      ? ''
      : String(goal.budget.maxConcurrentRuns),
    budgetTokens: goal.budget?.maxTokens === undefined ? '' : String(goal.budget.maxTokens)
  }
}

export function goalPatchFromDraft(goal: Goal, draft: GoalDraft): GoalPatch {
  return {
    title: draft.title.trim(),
    contract: goalContractFromDraft(draft, goal.acceptance)
  }
}

function goalContractFromDraft(draft: GoalDraft, existingAcceptance: Goal['acceptance'] = []): NonNullable<GoalInput['contract']> {
  const budgetAmount = optionalNumber(draft.budgetAmount)
  const maxRuns = optionalNumber(draft.budgetRuns)
  const maxConcurrentRuns = optionalNumber(draft.budgetConcurrentRuns)
  const maxTokens = optionalNumber(draft.budgetTokens)
  const budget = budgetAmount === undefined && maxRuns === undefined &&
      maxConcurrentRuns === undefined && maxTokens === undefined
    ? undefined
    : {
        amount: budgetAmount,
        currency: draft.budgetCurrency.trim().toUpperCase() || undefined,
        maxRuns,
        maxConcurrentRuns,
        maxTokens
      }
  return {
    objective: draft.objective.trim(),
    background: optionalText(draft.background),
    constraints: splitLines(draft.constraints),
    successCriteria: [...splitLines(draft.successCriteria), ...splitLines(draft.deliverables).map((item) => `交付物：${item}`)],
    acceptance: acceptanceSpecs(draft.acceptance, 'goal', existingAcceptance),
    forbiddenActions: splitLines(draft.forbiddenActions),
    riskLevel: draft.riskLevel,
    dueAt: dateToTimestamp(draft.dueDate),
    budget
  }
}

export function workItemInputFromDraft(projectId: string, draft: WorkItemDraft): WorkItemInput {
  const ownerId = draft.ownerId.trim()
  return {
    projectId,
    title: draft.title.trim(),
    description: optionalText(draft.description),
    goalId: optionalText(draft.goalId),
    type: draft.type,
    priority: Number(draft.priority) || 0,
    owner: ownerId ? { type: draft.ownerType, id: ownerId, displayName: optionalText(draft.ownerName) } : undefined,
    dueAt: dateToTimestamp(draft.dueDate),
    parentId: optionalText(draft.parentId),
    dependencyIds: draft.dependencyIds,
    acceptanceSpec: splitLines(draft.acceptance).length > 0
      ? acceptanceSpecs(draft.acceptance, 'work-item')
      : undefined
  }
}

export function acceptancePresentation(
  specificationCount: number,
  result?: AcceptanceResult
): AcceptancePresentation {
  if (result?.status === 'passed') return { status: 'passed', label: TEXT.acceptancePassed }
  if (result?.status === 'failed') return { status: 'failed', label: TEXT.acceptanceFailed }
  if (result?.status === 'waived') return { status: 'waived', label: TEXT.acceptanceWaived }
  if (result?.status === 'pending' || specificationCount > 0) {
    return { status: 'pending', label: `${TEXT.acceptancePending} · ${TEXT.acceptanceItems(specificationCount)}` }
  }
  return { status: 'unset', label: TEXT.acceptanceUnset }
}

export function projectKindLabel(kind: ProjectWorkspaceKind): string {
  return PROJECT_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind
}

export function projectEditDraft(project: {
  name: string
  kind: ProjectWorkspaceKind
  ownerId?: string
  rulesRef?: string
}): ProjectEditDraft {
  return {
    name: project.name,
    kind: project.kind,
    ownerId: project.ownerId ?? '',
    rulesRef: project.rulesRef ?? ''
  }
}

export function resourceInputFromDraft(draft: ProjectResourceDraft): ProjectResourceInput {
  const label = optionalText(draft.label)
  const location = draft.location.trim()
  const policy = {
    dataClass: draft.dataClass,
    egressPolicy: draft.dataClass === 'S3' ? 'deny' as const : draft.egressPolicy
  }
  if (draft.kind === 'connector') {
    return {
      kind: 'connector',
      label,
      uri: location,
      ...policy,
      connector: {
        schemaVersion: 1,
        connectorId: draft.connectorId.trim() || 'generic',
        usage: draft.connectorUsage,
        capabilities: splitCommaSeparated(draft.connectorCapabilities),
        dataDirection: draft.connectorDataDirection,
        authorization: {
          subject: draft.connectorAuthorizationSubject,
          principalId: draft.connectorPrincipalId.trim(),
          ...(optionalText(draft.connectorCredentialRef) === undefined ? {} : { credentialRef: optionalText(draft.connectorCredentialRef) }),
          scopes: splitCommaSeparated(draft.connectorScopes),
          status: 'active'
        },
        version: draft.connectorVersion.trim(),
        revocation: { behavior: 'deny_new_operations', purgeCachedData: true },
        writePolicy: { effect: 'required', reconciliation: draft.connectorReconciliation }
      }
    }
  }
  return { kind: draft.kind, label, path: location, ...policy }
}

export function connectorCatalogEntry(id: string, catalog: readonly ProjectConnectorCatalogEntry[]): ProjectConnectorCatalogEntry {
  return catalog.find((entry) => entry.id === id) ?? catalog[catalog.length - 1]
}

function splitCommaSeparated(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean))]
}

export function resourceDataClass(resource: ProjectResource): OutboundDataClass {
  return resource.dataClass ?? (resource.kind === 'connector' || resource.kind === 'url' ? 'S1' : 'S2')
}

export function resourceEgressPolicy(resource: ProjectResource): ProjectResourceEgressPolicy {
  if (resourceDataClass(resource) === 'S3') return 'deny'
  return resource.egressPolicy ?? 'allow'
}

export function resourceEgressLabel(resource: ProjectResource): string {
  const policy = resourceEgressPolicy(resource)
  if (policy === 'deny') return localized('禁止外发', 'Egress blocked')
  if (policy === 'local_only') return localized('仅本机', 'Local only')
  return localized('允许外发', 'Egress allowed')
}

export function resourceKindLabel(resource: ProjectResource): string {
  if (resource.kind === 'directory' && resource.metadata?.resourceType === 'repository') {
    return TEXT.resourceRepository
  }
  if (resource.kind === 'repository') return TEXT.resourceRepository
  if (resource.kind === 'directory') return TEXT.resourceDirectory
  if (resource.kind === 'file_set') return TEXT.resourceFileSet
  if (resource.kind === 'connector') return TEXT.resourceConnector
  if (resource.kind === 'knowledge_base') return localized('知识库', 'Knowledge base')
  if (resource.kind === 'url') return localized('网址', 'URL')
  return localized('其他', 'Other')
}

export function resourceLocation(resource: ProjectResource): string {
  return resource.path ?? resource.uri ?? ''
}

export function workItemTypeLabel(type: WorkItemType): string {
  return WORK_ITEM_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type
}

export function compareWorkItemsByBoardOrder(left: WorkItem, right: WorkItem): number {
  const leftOrder = Number.isFinite(left.boardOrder) ? left.boardOrder! : left.createdAt
  const rightOrder = Number.isFinite(right.boardOrder) ? right.boardOrder! : right.createdAt
  if (leftOrder !== rightOrder) return leftOrder - rightOrder
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
  return left.id.localeCompare(right.id)
}

export function projectWorkItems(items: readonly WorkItem[], filters: WorkItemFilters): WorkItem[] {
  const query = filters.query.trim().toLocaleLowerCase()
  return items
    .filter((item) => filters.status === 'all' || item.status === filters.status)
    .filter((item) => filters.goalId === 'all' || (filters.goalId === 'none' ? !item.goalId : item.goalId === filters.goalId))
    .filter((item) => filters.owner === 'all' || (filters.owner === 'unassigned' ? !item.owner : item.owner?.type === filters.owner))
    .filter((item) => {
      if (!query) return true
      return [item.id, item.title, item.description, item.owner?.id, item.owner?.displayName]
        .some((value) => value?.toLocaleLowerCase().includes(query))
    })
    .sort(compareWorkItemsByBoardOrder)
}

export function formatDate(timestamp?: number): string {
  if (timestamp === undefined) return TEXT.noDueDate
  return new Intl.DateTimeFormat(currentLanguage() === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(timestamp)
}

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : typeof error === 'string' ? error.trim() : ''
  const normalized = message.toLowerCase()
  if (normalized.includes('stale_revision')) return localized('内容已被更新，请刷新后再试', 'The content changed. Refresh and try again.')
  if (normalized.includes('cross_project')) return localized('所选内容不属于当前项目', 'The selected content does not belong to this project.')
  if (normalized.includes('contract_violation')) return localized('工作项与目标约定不一致', 'The work item does not match the goal contract.')
  if (normalized.includes('not_found')) return localized('没有找到所选内容，请刷新后再试', 'The selected content was not found. Refresh and try again.')
  if (normalized.includes('invalid_input')) return localized('请检查填写内容后再试', 'Check the entered information and try again.')
  if (normalized.includes('already_exists')) return localized('已经存在相同内容', 'The same content already exists.')
  if (message) return message
  return TEXT.unknownError
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
}

function acceptanceSpecs(value: string, prefix: string, existing: AcceptanceSpec[] = []): AcceptanceSpec[] {
  const seed = globalThis.crypto.randomUUID()
  return splitLines(value).map((criterion, index) => ({
    id: existing[index]?.id ?? `${prefix}-${seed}-${index + 1}`,
    criterion,
    required: existing[index]?.required !== false
  }))
}

function optionalText(value: string): string | undefined {
  const normalized = value.trim()
  return normalized || undefined
}

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function dateToTimestamp(value: string): number | undefined {
  if (!value) return undefined
  const parsed = new Date(`${value}T23:59:59`)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.getTime()
}

function dateInputValue(timestamp?: number): string {
  if (timestamp === undefined) return ''
  const date = new Date(timestamp)
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
