import { createHash } from 'node:crypto'
import type {
  AcceptanceSpec,
  WorkItem,
  WorkItemInput
} from '../../shared/project-workspace-types'
import { isAcceptanceSatisfied } from '../../shared/project-workspace-types'
import type {
  WorkflowAcceptanceInput,
  WorkflowAcceptanceRecord
} from '../../shared/workflow-types'
import { WORKFLOW_ACCEPTANCE_REPAIR_WORK_ITEM_PREFIX } from '../../shared/workflow-repair'
import type { ProjectWorkspaceCommandService } from '../project-workspace/command-service'

const REPAIR_ID_NAMESPACE = 'caogen.workflow-acceptance-repair.v1'

/**
 * Every repair must have a stable execution owner, including source WorkItems
 * that were created before owner assignment became part of the workflow gate.
 * Keeping this in the deterministic repair binding prevents the runtime's
 * first-start owner assignment from creating a restart-only binding conflict.
 */
export const WORKFLOW_REPAIR_DEFAULT_OWNER = {
  type: 'human' as const,
  id: 'local-user',
    displayName: 'EastGenesis Repair Runtime'
}

export type WorkflowAcceptanceRepairErrorCode =
  | 'WORKFLOW_REPAIR_ACCEPTANCE_INVALID'
  | 'WORKFLOW_REPAIR_SOURCE_NOT_FOUND'
  | 'WORKFLOW_REPAIR_PROJECT_BOUNDARY'
  | 'WORKFLOW_REPAIR_GOAL_BOUNDARY'
  | 'WORKFLOW_REPAIR_CONFLICT'
  | 'WORKFLOW_REPAIR_REVISION_CONFLICT'
  | 'WORKFLOW_REPAIR_NOT_FOUND'
  | 'WORKFLOW_REPAIR_INCOMPLETE'

export class WorkflowAcceptanceRepairError extends Error {
  readonly code: WorkflowAcceptanceRepairErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: WorkflowAcceptanceRepairErrorCode,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'WorkflowAcceptanceRepairError'
    this.code = code
    this.details = { ...details }
  }
}

export interface WorkflowAcceptanceRepairCommandPort {
  createWorkItem(
    input: WorkItemInput,
    options?: { expectedRevision?: number; expectedStoreRevision?: number }
  ): Promise<WorkItem>
}

export interface WorkflowAcceptanceRepairReadPort {
  getWorkItem(id: string): Promise<WorkItem | undefined>
}

export interface WorkflowAcceptanceRepairCoordinatorDependencies {
  commands: WorkflowAcceptanceRepairCommandPort
  reader: WorkflowAcceptanceRepairReadPort
  now?: () => number
}

export interface WorkflowAcceptanceRepairResult {
  acceptanceId: string
  failedAcceptanceRevision: number
  repairWorkItemId: string
  repairAcceptanceId: string
  repairWorkItem: WorkItem
  disposition: 'created' | 'existing'
}

export interface WorkflowAcceptanceRepairRecoveryResult {
  recovered: WorkflowAcceptanceRepairResult[]
  failures: Array<{
    acceptanceId: string
    failedAcceptanceRevision: number
    code?: string
    message: string
  }>
}

export interface WorkflowAcceptanceRetestOptions {
  notes?: string
  updatedAt?: number
}

export interface WorkflowAcceptanceRetestPlan {
  previousAcceptance: WorkflowAcceptanceRecord
  acceptanceInput: WorkflowAcceptanceInput
  repairWorkItem: WorkItem
  repairWorkItemId: string
  repairAcceptanceId: string
  failedAcceptanceRevision: number
}

interface RepairContext {
  acceptance: WorkflowAcceptanceRecord
  sourceWorkItem: WorkItem
  repairInput: WorkItemInput & { id: string }
}

/**
 * Coordinates the non-atomic boundary between a committed failed Acceptance
 * review and its canonical repair WorkItem. The deterministic WorkItem id is
 * the recovery record: a retry either proves the same binding or fails closed.
 */
export class WorkflowAcceptanceRepairCoordinator {
  private readonly commands: WorkflowAcceptanceRepairCommandPort
  private readonly reader: WorkflowAcceptanceRepairReadPort
  private readonly now: () => number

  constructor(dependencies: WorkflowAcceptanceRepairCoordinatorDependencies) {
    this.commands = dependencies.commands
    this.reader = dependencies.reader
    this.now = dependencies.now ?? Date.now
  }

  async ensureRepairWorkItem(
    acceptance: WorkflowAcceptanceRecord
  ): Promise<WorkflowAcceptanceRepairResult> {
    const context = await this.resolveRepairContext(acceptance)
    const existing = await this.reader.getWorkItem(context.repairInput.id)
    if (existing) return repairResult(context, assertRepairBinding(context, existing), 'existing')

    try {
      const created = await this.commands.createWorkItem(context.repairInput)
      return repairResult(context, assertRepairBinding(context, created), 'created')
    } catch (error) {
      if (!hasErrorCode(error, 'already_exists')) throw error
      const concurrent = await this.reader.getWorkItem(context.repairInput.id)
      if (!concurrent) {
        throw repairError(
          'WORKFLOW_REPAIR_CONFLICT',
          `repair WorkItem ${context.repairInput.id} was reported as existing but cannot be read`,
          context.acceptance
        )
      }
      return repairResult(context, assertRepairBinding(context, concurrent), 'existing')
    }
  }

  /** Compatibility name for the post-review handler integration point. */
  createRepairForFailedAcceptance(
    acceptance: WorkflowAcceptanceRecord
  ): Promise<WorkflowAcceptanceRepairResult> {
    return this.ensureRepairWorkItem(acceptance)
  }

  /**
   * Recovery entry point for failed reviews that committed before the repair
   * command ran. Callers supply the authoritative current Ledger projection;
   * this coordinator never writes the Ledger directly.
   */
  async recoverMissingRepairs(
    failedAcceptances: readonly WorkflowAcceptanceRecord[]
  ): Promise<WorkflowAcceptanceRepairRecoveryResult> {
    const recovered: WorkflowAcceptanceRepairResult[] = []
    const failures: WorkflowAcceptanceRepairRecoveryResult['failures'] = []
    const ordered = [...failedAcceptances].sort(compareFailedAcceptances)
    const seen = new Set<string>()
    for (const acceptance of ordered) {
      try {
        assertFailedAcceptance(acceptance)
        const key = failedAcceptanceKey(acceptance)
        if (seen.has(key)) continue
        seen.add(key)
        recovered.push(await this.ensureRepairWorkItem(acceptance))
      } catch (error) {
        failures.push({
          acceptanceId: acceptance?.id ?? 'unknown',
          failedAcceptanceRevision: acceptance?.revision ?? 0,
          ...(errorCode(error) ? { code: errorCode(error) } : {}),
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return { recovered, failures }
  }

  /** Compatibility name matching other restart coordinators. */
  recoverPending(
    failedAcceptances: readonly WorkflowAcceptanceRecord[]
  ): Promise<WorkflowAcceptanceRepairRecoveryResult> {
    return this.recoverMissingRepairs(failedAcceptances)
  }

  /**
   * Retest is authorized only by a completed, canonically bound repair item.
   * The returned revision keeps the Acceptance identity/history while clearing
   * evidence and authority fields for the new verification round.
   */
  async planRetest(
    acceptance: WorkflowAcceptanceRecord,
    options: WorkflowAcceptanceRetestOptions = {}
  ): Promise<WorkflowAcceptanceRetestPlan> {
    const context = await this.resolveRepairContext(acceptance)
    const repairWorkItem = await this.reader.getWorkItem(context.repairInput.id)
    if (!repairWorkItem) {
      throw repairError(
        'WORKFLOW_REPAIR_NOT_FOUND',
        `acceptance ${acceptance.id} cannot be retested before its repair WorkItem exists`,
        acceptance,
        { repairWorkItemId: context.repairInput.id }
      )
    }
    assertRepairBinding(context, repairWorkItem)
    assertRepairCompleted(acceptance, repairWorkItem)
    const updatedAt = normalizeRetestTimestamp(options.updatedAt ?? this.now(), acceptance)
    return {
      previousAcceptance: clone(acceptance),
      acceptanceInput: buildVerifyingAcceptance(acceptance, options.notes, updatedAt),
      repairWorkItem: clone(repairWorkItem),
      repairWorkItemId: repairWorkItem.id,
      repairAcceptanceId: workflowAcceptanceRepairAcceptanceId(repairWorkItem.id),
      failedAcceptanceRevision: acceptance.revision
    }
  }

  /** Compatibility name for a handler that persists the returned input. */
  prepareRetest(
    acceptance: WorkflowAcceptanceRecord,
    options: WorkflowAcceptanceRetestOptions = {}
  ): Promise<WorkflowAcceptanceRetestPlan> {
    return this.planRetest(acceptance, options)
  }

  private async resolveRepairContext(acceptance: WorkflowAcceptanceRecord): Promise<RepairContext> {
    assertFailedAcceptance(acceptance)
    const workItemId = acceptance.workItemId as string
    const sourceWorkItem = await this.reader.getWorkItem(workItemId)
    if (!sourceWorkItem) {
      throw repairError(
        'WORKFLOW_REPAIR_SOURCE_NOT_FOUND',
        `failed acceptance ${acceptance.id} references missing WorkItem ${workItemId}`,
        acceptance
      )
    }
    assertSourceOwnership(acceptance, sourceWorkItem)
    return {
      acceptance: clone(acceptance),
      sourceWorkItem: clone(sourceWorkItem),
      repairInput: buildRepairWorkItemInput(acceptance, sourceWorkItem)
    }
  }
}

export async function openWorkflowAcceptanceRepairCoordinator(
  rootDir?: string
): Promise<WorkflowAcceptanceRepairCoordinator> {
  const [{ createProjectWorkspaceCommandService }, { openProjectWorkspaceStore }] = await Promise.all([
    import('../project-workspace/command-service.js'),
    import('../project-workspace/store.js')
  ])
  const store = await openProjectWorkspaceStore(rootDir)
  const commands: ProjectWorkspaceCommandService = createProjectWorkspaceCommandService(store, {
    rootDir: store.rootDir
  })
  await commands.reconcileShadowProjection()
  return new WorkflowAcceptanceRepairCoordinator({ commands, reader: store })
}

export function workflowAcceptanceRepairWorkItemId(
  acceptanceId: string,
  failedAcceptanceRevision: number
): string {
  const id = requiredText(acceptanceId, 'acceptance id')
  if (!Number.isSafeInteger(failedAcceptanceRevision) || failedAcceptanceRevision < 1) {
    throw new WorkflowAcceptanceRepairError(
      'WORKFLOW_REPAIR_ACCEPTANCE_INVALID',
      'failed acceptance revision must be a positive safe integer',
      { acceptanceId: id, failedAcceptanceRevision }
    )
  }
  return `${WORKFLOW_ACCEPTANCE_REPAIR_WORK_ITEM_PREFIX}${sha256(`${REPAIR_ID_NAMESPACE}\0${id}\0${failedAcceptanceRevision}`)}`
}

export function workflowAcceptanceRepairAcceptanceId(repairWorkItemId: string): string {
  const id = requiredText(repairWorkItemId, 'repair WorkItem id')
  return `workflow-repair-acceptance:${sha256(`${REPAIR_ID_NAMESPACE}\0acceptance\0${id}`)}`
}

export function assertWorkflowAcceptanceRetestPlanCurrent(
  current: WorkflowAcceptanceRecord | null,
  plan: WorkflowAcceptanceRetestPlan
): void {
  const expected = plan.previousAcceptance
  if (current?.id === expected.id && current.status === 'failed' &&
      current.revision === plan.failedAcceptanceRevision) return
  throw new WorkflowAcceptanceRepairError(
    'WORKFLOW_REPAIR_REVISION_CONFLICT',
    `acceptance ${expected.id} changed after its repair was authorized for retest`,
    {
      acceptanceId: expected.id,
      expectedRevision: plan.failedAcceptanceRevision,
      actualRevision: current?.revision,
      actualStatus: current?.status
    }
  )
}

function buildRepairWorkItemInput(
  acceptance: WorkflowAcceptanceRecord,
  sourceWorkItem: WorkItem
): WorkItemInput & { id: string } {
  const repairWorkItemId = workflowAcceptanceRepairWorkItemId(acceptance.id, acceptance.revision)
  return {
    id: repairWorkItemId,
    projectId: sourceWorkItem.projectId,
    ...(sourceWorkItem.goalId === undefined ? {} : { goalId: sourceWorkItem.goalId }),
    parentId: sourceWorkItem.id,
    type: 'custom',
    title: `Repair failed acceptance ${acceptance.id} revision ${acceptance.revision}`,
    description: [
      `Canonical repair for failed Acceptance ${acceptance.id} revision ${acceptance.revision}.`,
      `Original WorkItem: ${sourceWorkItem.id}.`
    ].join(' '),
    status: 'ready',
    owner: clone(sourceWorkItem.owner ?? WORKFLOW_REPAIR_DEFAULT_OWNER),
    acceptanceSpec: acceptance.criteria.map((criterion, index) => ({
      id: repairCriterionId(acceptance, index),
      criterion,
      required: true
    }))
  }
}

function assertFailedAcceptance(acceptance: WorkflowAcceptanceRecord): void {
  if (!acceptance || typeof acceptance !== 'object') {
    throw new WorkflowAcceptanceRepairError(
      'WORKFLOW_REPAIR_ACCEPTANCE_INVALID',
      'failed acceptance is required'
    )
  }
  const acceptanceId = requiredText(acceptance.id, 'acceptance id')
  if (acceptance.status !== 'failed') {
    throw repairError(
      'WORKFLOW_REPAIR_ACCEPTANCE_INVALID',
      `acceptance ${acceptanceId} must be failed before creating or retesting a repair`,
      acceptance,
      { actualStatus: acceptance.status }
    )
  }
  if (!acceptance.projectId || !acceptance.workItemId) {
    throw repairError(
      'WORKFLOW_REPAIR_ACCEPTANCE_INVALID',
      `failed acceptance ${acceptanceId} must own a project-scoped WorkItem`,
      acceptance
    )
  }
  if (!Number.isSafeInteger(acceptance.revision) || acceptance.revision < 1) {
    throw repairError(
      'WORKFLOW_REPAIR_ACCEPTANCE_INVALID',
      `failed acceptance ${acceptanceId} has an invalid revision`,
      acceptance
    )
  }
  if (!Array.isArray(acceptance.criteria) || acceptance.criteria.length === 0 ||
      acceptance.criteria.some((criterion) => typeof criterion !== 'string' || !criterion.trim())) {
    throw repairError(
      'WORKFLOW_REPAIR_ACCEPTANCE_INVALID',
      `failed acceptance ${acceptanceId} has invalid criteria`,
      acceptance
    )
  }
}

function assertSourceOwnership(acceptance: WorkflowAcceptanceRecord, source: WorkItem): void {
  if (acceptance.projectId !== source.projectId) {
    throw repairError(
      'WORKFLOW_REPAIR_PROJECT_BOUNDARY',
      `acceptance ${acceptance.id} crosses the source WorkItem project boundary`,
      acceptance,
      { sourceProjectId: source.projectId }
    )
  }
  if (acceptance.goalId !== source.goalId) {
    throw repairError(
      'WORKFLOW_REPAIR_GOAL_BOUNDARY',
      `acceptance ${acceptance.id} crosses the source WorkItem Goal boundary`,
      acceptance,
      { sourceGoalId: source.goalId }
    )
  }
}

function assertRepairBinding(context: RepairContext, actual: WorkItem): WorkItem {
  const expected = repairBinding(context.repairInput)
  const observed = repairBinding(actual)
  const mismatchedFields = Object.keys(expected).filter((field) =>
    JSON.stringify(expected[field as keyof typeof expected]) !==
    JSON.stringify(observed[field as keyof typeof observed])
  ).filter((field) => !isLegacyOwnerlessRepairBinding(field, expected, observed))
  if (mismatchedFields.length > 0) {
    throw repairError(
      'WORKFLOW_REPAIR_CONFLICT',
      `repair WorkItem ${context.repairInput.id} conflicts with failed acceptance ${context.acceptance.id}`,
      context.acceptance,
      { repairWorkItemId: context.repairInput.id, mismatchedFields }
    )
  }
  return clone(actual)
}

/**
 * Repairs created before the deterministic runtime owner was introduced may
 * have no owner at all. Treat that one absence as compatible only when the
 * current binding expects the default owner; every explicit owner mismatch
 * remains a conflict.
 */
function isLegacyOwnerlessRepairBinding(
  field: string,
  expected: ReturnType<typeof repairBinding>,
  observed: ReturnType<typeof repairBinding>
): boolean {
  return field === 'owner' && observed.owner === null &&
    expected.owner?.type === WORKFLOW_REPAIR_DEFAULT_OWNER.type &&
    expected.owner.id === WORKFLOW_REPAIR_DEFAULT_OWNER.id
}

function repairBinding(item: WorkItem | (WorkItemInput & { id: string })): {
  id: string
  projectId: string
  goalId: string | null
  parentId: string | null
  type: string
  title: string
  description: string | null
  owner: { type: 'human' | 'digital_worker'; id: string } | null
  acceptanceSpec: AcceptanceSpec[]
} {
  return {
    id: item.id,
    projectId: item.projectId,
    goalId: item.goalId ?? null,
    parentId: item.parentId ?? null,
    type: item.type ?? 'custom',
    title: item.title,
    description: item.description ?? null,
    owner: repairOwnerBinding(item.owner),
    acceptanceSpec: (item.acceptanceSpec ?? []).map((criterion) => ({
      id: criterion.id,
      criterion: criterion.criterion,
      required: criterion.required !== false
    }))
  }
}

function repairOwnerBinding(owner: WorkItemInput['owner']): {
  type: 'human' | 'digital_worker'
  id: string
} | null {
  if (!owner) return null
  if (typeof owner === 'string') return { type: 'digital_worker', id: owner }
  return { type: owner.type, id: owner.id }
}

function assertRepairCompleted(acceptance: WorkflowAcceptanceRecord, repair: WorkItem): void {
  const acceptanceSatisfied = isAcceptanceSatisfied(repair.acceptance)
  const passedEvidenceValid = repair.acceptance?.status !== 'passed' || repair.acceptance.evidenceRefs.length > 0
  const waiverValid = repair.acceptance?.status !== 'waived' || Boolean(repair.acceptance.waiverReason?.trim())
  if (repair.status === 'done' && acceptanceSatisfied && passedEvidenceValid && waiverValid) return
  throw repairError(
    'WORKFLOW_REPAIR_INCOMPLETE',
    `acceptance ${acceptance.id} cannot be retested before repair WorkItem ${repair.id} is complete`,
    acceptance,
    {
      repairWorkItemId: repair.id,
      repairStatus: repair.status,
      repairAcceptanceStatus: repair.acceptance?.status
    }
  )
}

function buildVerifyingAcceptance(
  acceptance: WorkflowAcceptanceRecord,
  notes: string | undefined,
  updatedAt: number
): WorkflowAcceptanceInput {
  return {
    id: acceptance.id,
    ...(acceptance.projectId === undefined ? {} : { projectId: acceptance.projectId }),
    ...(acceptance.goalId === undefined ? {} : { goalId: acceptance.goalId }),
    ...(acceptance.workItemId === undefined ? {} : { workItemId: acceptance.workItemId }),
    criteria: [...acceptance.criteria],
    ...(acceptance.criterionPolicies === undefined ? {} : {
      criterionPolicies: acceptance.criterionPolicies.map((policy) => ({
        ...policy,
        allowedSources: [...policy.allowedSources]
      }))
    }),
    status: 'verifying',
    evidenceRefs: [],
    ...(normalizeOptionalNotes(notes) ?? acceptance.notes
      ? { notes: normalizeOptionalNotes(notes) ?? acceptance.notes }
      : {}),
    revision: acceptance.revision + 1,
    createdAt: acceptance.createdAt,
    updatedAt
  }
}

function repairResult(
  context: RepairContext,
  repairWorkItem: WorkItem,
  disposition: WorkflowAcceptanceRepairResult['disposition']
): WorkflowAcceptanceRepairResult {
  return {
    acceptanceId: context.acceptance.id,
    failedAcceptanceRevision: context.acceptance.revision,
    repairWorkItemId: repairWorkItem.id,
    repairAcceptanceId: workflowAcceptanceRepairAcceptanceId(repairWorkItem.id),
    repairWorkItem: clone(repairWorkItem),
    disposition
  }
}

function repairCriterionId(acceptance: WorkflowAcceptanceRecord, criterionIndex: number): string {
  return `workflow-repair-criterion:${sha256(
    `${REPAIR_ID_NAMESPACE}\0${acceptance.id}\0${acceptance.revision}\0${criterionIndex}`
  )}`
}

function failedAcceptanceKey(acceptance: WorkflowAcceptanceRecord): string {
  return `${acceptance.id}\0${acceptance.revision}`
}

function compareFailedAcceptances(left: WorkflowAcceptanceRecord, right: WorkflowAcceptanceRecord): number {
  return left.id.localeCompare(right.id) || left.revision - right.revision
}

function normalizeRetestTimestamp(value: number, acceptance: WorkflowAcceptanceRecord): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw repairError(
      'WORKFLOW_REPAIR_ACCEPTANCE_INVALID',
      `acceptance ${acceptance.id} retest timestamp must be a non-negative safe integer`,
      acceptance,
      { updatedAt: value }
    )
  }
  return Math.max(value, acceptance.updatedAt)
}

function normalizeOptionalNotes(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkflowAcceptanceRepairError(
      'WORKFLOW_REPAIR_ACCEPTANCE_INVALID',
      `${label} is required`
    )
  }
  return value.trim()
}

function repairError(
  code: WorkflowAcceptanceRepairErrorCode,
  message: string,
  acceptance: WorkflowAcceptanceRecord,
  details: Record<string, unknown> = {}
): WorkflowAcceptanceRepairError {
  return new WorkflowAcceptanceRepairError(code, message, {
    acceptanceId: acceptance.id,
    failedAcceptanceRevision: acceptance.revision,
    projectId: acceptance.projectId,
    goalId: acceptance.goalId,
    sourceWorkItemId: acceptance.workItemId,
    ...details
  })
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error &&
    (error as { code?: unknown }).code === code)
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
