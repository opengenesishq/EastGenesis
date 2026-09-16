import type { ProjectWorkspace, ProjectWorkspaceEvent, ProjectWorkspaceState } from '../../shared/project-workspace-types'
import {
  PROJECT_INSTITUTION_MIGRATION_EVENT,
  LEGACY_PROJECT_INSTITUTION_TEMPLATE,
  isProjectInstitutionMigrationEventPayload,
  normalizeProjectInstitutionRoleMappings,
  previewProjectInstitutionMigration,
  projectInstitutionTemplate,
  type ProjectInstitutionMigrationApplyInput,
  type ProjectInstitutionMigrationPreviewInput,
  type ProjectInstitutionMigrationView,
  type ProjectInstitutionRoleMapping
} from '../../shared/project-institution-template'
import { clone, digest, normalizeInstitutionTemplate } from './codec'
import { ProjectWorkspaceError } from './errors'

/** Known migration receipts must remain readable and bound to their owning workspace. */
export function assertInstitutionMigrationEvents(workspaces: readonly ProjectWorkspace[], events: readonly ProjectWorkspaceEvent[]): void {
  const receipts = new Set<string>(), revisions = new Set<string>()
  for (const event of events) {
    if (event?.kind !== PROJECT_INSTITUTION_MIGRATION_EVENT) continue
    const workspace = workspaces.find((item) => item.id === event.projectId)
    if (!workspace || event.entityType !== 'workspace' || event.entityId !== workspace.id ||
      event.schemaVersion !== workspace.schemaVersion || typeof event.id !== 'string' || !event.id.trim() ||
      !Number.isSafeInteger(event.revision) || event.revision > workspace.revision ||
      !Number.isFinite(event.occurredAt) || !isProjectInstitutionMigrationEventPayload(event.payload) ||
      event.revision !== event.payload.expectedWorkspaceRevision + 1) {
      throw new ProjectWorkspaceError('institution_migration_record_invalid', '机构迁移记录损坏或不属于当前项目。')
    }
    const receipt = `${workspace.id}\0${event.payload.previewDigest}`, revision = `${workspace.id}\0${event.revision}`
    if (receipts.has(receipt) || revisions.has(revision)) {
      throw new ProjectWorkspaceError('institution_migration_record_invalid', '机构迁移回执或项目版本重复。')
    }
    receipts.add(receipt); revisions.add(revision)
  }
}

export function normalizeInstitutionMigrationPreviewInput(input: unknown): ProjectInstitutionMigrationPreviewInput {
  const record = migrationRecord(input, ['scope', 'target', 'roleMappings'])
  const target = normalizeInstitutionTemplate(record.target)
  return { scope: 'future_goals', target,
    ...(record.roleMappings === undefined ? {} : { roleMappings: normalizeProjectInstitutionRoleMappings(record.roleMappings, target) }) }
}

export function normalizeInstitutionMigrationApplyInput(input: unknown): ProjectInstitutionMigrationApplyInput {
  const record = migrationRecord(input, ['scope', 'target', 'roleMappings', 'expectedWorkspaceRevision', 'previewDigest'])
  if (!Number.isSafeInteger(record.expectedWorkspaceRevision) || (record.expectedWorkspaceRevision as number) < 1 ||
    typeof record.previewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.previewDigest)) {
    throw new ProjectWorkspaceError('invalid_input', '机构迁移必须绑定有效的项目版本与预览摘要。')
  }
  const target = normalizeInstitutionTemplate(record.target)
  return { scope: 'future_goals', target,
    ...(record.roleMappings === undefined ? {} : { roleMappings: normalizeProjectInstitutionRoleMappings(record.roleMappings, target) }),
    expectedWorkspaceRevision: record.expectedWorkspaceRevision as number, previewDigest: record.previewDigest }
}

/** State is one persisted snapshot (or the locked mutation snapshot), never a collection of timed reads. */
export function buildInstitutionMigrationPreview(
  state: ProjectWorkspaceState,
  workspace: ProjectWorkspace,
  input: ProjectInstitutionMigrationPreviewInput
): ProjectInstitutionMigrationView {
  const goals = state.goals.filter((goal) => goal.projectId === workspace.id).sort((left, right) => left.id.localeCompare(right.id))
  const workItems = state.workItems.filter((item) => item.projectId === workspace.id).sort((left, right) => left.id.localeCompare(right.id))
  const comparison = previewProjectInstitutionMigration({ institutionTemplate: workspace.institutionTemplate, target: input.target, workItems })
  const fromTemplate = projectInstitutionTemplate(workspace.institutionTemplate).ref
  const currentRoleMappings = currentInstitutionRoleMappings(workspace, state.events)
  // A template change starts with compatible mappings only; the preview makes removals explicit.
  const roleMappings = input.roleMappings ?? currentRoleMappings.filter(mapping =>
    comparison.target.roles.some(role => role.id === mapping.institutionId && role.participation !== 'user'))
  const candidates = new Map([...comparison.current.roles, ...projectInstitutionTemplate(LEGACY_PROJECT_INSTITUTION_TEMPLATE).roles]
    .filter(role => role.participation !== 'user').map(role => [role.id, { id: role.id, label: role.name, recordedWorkCount: 0 }]))
  for (const [id, label] of [['research', '研究'], ['build', '工程'], ['document', '文档'], ['verify', '验收']]) {
    candidates.set(id, { id, label, recordedWorkCount: 0 })
  }
  for (const mapping of [...currentRoleMappings, ...roleMappings]) {
    if (!candidates.has(mapping.sourceRoleId)) candidates.set(mapping.sourceRoleId,
      { id: mapping.sourceRoleId, label: mapping.sourceRoleId, recordedWorkCount: 0 })
  }
  for (const item of workItems) {
    if (!item.role) continue
    const candidate = candidates.get(item.role) ?? { id: item.role, label: item.role, recordedWorkCount: 0 }
    candidate.recordedWorkCount += 1
    candidates.set(item.role, candidate)
  }
  const identity = { schemaVersion: 1, projectId: workspace.id, scope: input.scope,
    expectedWorkspaceRevision: workspace.revision, fromTemplate, toTemplate: input.target,
    fromRoleMappings: currentRoleMappings, toRoleMappings: roleMappings,
    preservedGoals: goals, preservedWorkItems: workItems }
  return { ...comparison, schemaVersion: 1, projectId: workspace.id, scope: input.scope,
    expectedWorkspaceRevision: workspace.revision, previewDigest: digest(identity),
    preservedGoalIds: goals.map((goal) => goal.id), preservedWorkItemIds: workItems.map((item) => item.id),
    recordedGoalCount: goals.length, currentRoleMappings, roleMappings,
    roleCandidates: [...candidates.values()].sort((a, b) => a.id.localeCompare(b.id)),
    canApply: fromTemplate.templateId !== input.target.templateId || digest(currentRoleMappings) !== digest(roleMappings) }
}

/** Mapping history lives with the existing migration receipts, not with task identities or permissions. */
export function currentInstitutionRoleMappings(workspace: ProjectWorkspace, events: readonly ProjectWorkspaceEvent[]): ProjectInstitutionRoleMapping[] {
  const migrations = events.filter(event => event.projectId === workspace.id && event.kind === PROJECT_INSTITUTION_MIGRATION_EVENT)
    .sort((a, b) => a.revision - b.revision)
  assertInstitutionMigrationEvents([workspace], migrations)
  return clone((migrations.at(-1)?.payload.toRoleMappings ?? []) as ProjectInstitutionRoleMapping[])
}

/** A retry returns its committed receipt; it never reapplies an older template after another migration. */
export function institutionMigrationReplay(
  state: ProjectWorkspaceState,
  projectId: string,
  input: ProjectInstitutionMigrationApplyInput
): ProjectWorkspaceEvent | undefined {
  const events = state.events.filter((event) => event.projectId === projectId && event.kind === PROJECT_INSTITUTION_MIGRATION_EVENT)
  for (const event of events) {
    if (event.entityType !== 'workspace' || event.entityId !== projectId ||
      !isProjectInstitutionMigrationEventPayload(event.payload) || event.revision !== event.payload.expectedWorkspaceRevision + 1) {
      throw new ProjectWorkspaceError('institution_migration_record_invalid', '机构迁移记录损坏，已停止继续迁移。')
    }
  }
  const matches = events.filter((event) => event.payload.previewDigest === input.previewDigest)
  if (matches.length > 1) throw new ProjectWorkspaceError('institution_migration_record_invalid', '机构迁移预览对应多个回执。')
  const event = matches[0]
  if (!event) return undefined
  const payload = event.payload
  if (payload.expectedWorkspaceRevision !== input.expectedWorkspaceRevision ||
    digest(payload.toTemplate) !== digest(input.target) || payload.scope !== input.scope ||
    (input.roleMappings !== undefined && digest(payload.toRoleMappings ?? []) !== digest(input.roleMappings))) {
    throw new ProjectWorkspaceError('institution_migration_request_conflict', '同一机构迁移预览不能更改目标模板、角色映射、范围或项目版本。')
  }
  return clone(event)
}

function migrationRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key)) || (input as Record<string, unknown>).scope !== 'future_goals') {
    throw new ProjectWorkspaceError('invalid_input', '机构迁移范围必须为 future_goals，且只能包含规定字段。')
  }
  return input as Record<string, unknown>
}
