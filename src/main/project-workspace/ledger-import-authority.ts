import type { WorkflowEventInput, WorkflowEventRecord } from '../../shared/workflow-types'
import { isDigest, isId, isRecord, positiveRevision } from './ledger-migration-errors'
import { PROJECT_WORKSPACE_MIGRATION_EVENT_KIND } from './ledger-migration-continuity'

export const PROJECT_WORKSPACE_IMPORT_AUTHORITY_EVENT_KIND = 'workflow.project-workspace.imported'
export const PROJECT_WORKSPACE_IMPORT_AUTHORITY_FORMAT = 'caogen.project-workspace-import-authority.v1'

export interface ProjectWorkspaceImportAuthorityWorkItem {
  id: string
  revision: number
  digest: string
}

export interface ProjectWorkspaceImportAuthorityInput {
  projectId: string
  aggregateDigest: string
  workspaceRevision: number
  occurredAt: number
  workItems: readonly ProjectWorkspaceImportAuthorityWorkItem[]
}

export interface ProjectWorkspaceImportAuthorityEvent {
  event: WorkflowEventInput
  scope: { projectId: string }
}

/** Build destination-local authority metadata for a sealed Project import. */
export function buildProjectWorkspaceImportAuthorityEvent(
  input: ProjectWorkspaceImportAuthorityInput
): ProjectWorkspaceImportAuthorityEvent {
  const workItems = input.workItems
    .map((item) => ({ ...item }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return {
    event: {
      eventId: `workflow:project-workspace:${input.projectId}:import:${input.aggregateDigest}`,
      streamId: `project-workspace:${input.projectId}`,
      entityType: 'system',
      entityId: input.projectId,
      kind: PROJECT_WORKSPACE_IMPORT_AUTHORITY_EVENT_KIND,
      payload: {
        format: PROJECT_WORKSPACE_IMPORT_AUTHORITY_FORMAT,
        projectId: input.projectId,
        aggregateDigest: input.aggregateDigest,
        workspaceRevision: input.workspaceRevision,
        workItems
      },
      occurredAt: input.occurredAt,
      correlationId: `project-import:${input.aggregateDigest}`
    },
    scope: { projectId: input.projectId }
  }
}

/** Local authority events describe the destination and are never portable source audit. */
export function isLocalProjectWorkspaceAuthorityEvent(value: unknown): boolean {
  return isRecord(value) && (
    value.kind === PROJECT_WORKSPACE_MIGRATION_EVENT_KIND ||
    value.kind === PROJECT_WORKSPACE_IMPORT_AUTHORITY_EVENT_KIND ||
    value.kind === 'workflow.task-handoff.imported'
  )
}

export function projectWorkspaceAuthorityOwnsWorkItem(
  event: WorkflowEventRecord,
  projectId: string,
  workItemId: string
): boolean {
  // A handoff grants projection authority only over its declared task closure,
  // never over a sealed copy of the whole source Project.
  if (event.kind === 'workflow.task-handoff.imported') {
    const payload = event.payload
    return event.entityType === 'system' && event.entityId === projectId && event.projectId === projectId &&
      payload.format === 'caogen.task-handoff-authority.v1' && payload.projectId === projectId &&
      isId(payload.sessionId) && isDigest(payload.bundleDigest) && isId(payload.sourceHostId) &&
      Array.isArray(payload.workItems) && payload.workItems.every(isImportWorkItemBinding) &&
      payload.workItems.some(item => item.id === workItemId)
  }
  if (event.kind === PROJECT_WORKSPACE_MIGRATION_EVENT_KIND && event.entityId === projectId) {
    return payloadOwnsWorkItem(event.payload.workItems, workItemId)
  }
  if (event.kind !== PROJECT_WORKSPACE_IMPORT_AUTHORITY_EVENT_KIND ||
      event.entityType !== 'system' || event.entityId !== projectId || event.projectId !== projectId) {
    return false
  }
  const payload = event.payload
  if (payload.format !== PROJECT_WORKSPACE_IMPORT_AUTHORITY_FORMAT || payload.projectId !== projectId ||
      !isDigest(payload.aggregateDigest) || !positiveRevision(payload.workspaceRevision) ||
      !Array.isArray(payload.workItems) || !payload.workItems.every(isImportWorkItemBinding)) {
    return false
  }
  return payload.workItems.some((item) => item.id === workItemId)
}

function payloadOwnsWorkItem(value: unknown, workItemId: string): boolean {
  return Array.isArray(value) && value.some((item) => isRecord(item) && item.id === workItemId)
}

function isImportWorkItemBinding(value: unknown): value is ProjectWorkspaceImportAuthorityWorkItem {
  return isRecord(value) && isId(value.id) && positiveRevision(value.revision) && isDigest(value.digest)
}
