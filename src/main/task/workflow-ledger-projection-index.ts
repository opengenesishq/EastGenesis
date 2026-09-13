import type { WorkflowEventRecord } from '../../shared/workflow-types'

export interface ProjectionEventIndex {
  entityKinds: Map<string, WorkflowEventRecord>
  runProjections: Map<string, WorkflowEventRecord>
  evidenceLinks: Map<string, WorkflowEventRecord>
}

export function buildProjectionEventIndex(events: readonly WorkflowEventRecord[]): ProjectionEventIndex {
  const entityKinds = new Map<string, WorkflowEventRecord>()
  const runProjections = new Map<string, WorkflowEventRecord>()
  const evidenceLinks = new Map<string, WorkflowEventRecord>()
  for (const event of events) {
    if (event.entityType !== 'system') {
      entityKinds.set(projectionEntityKindKey(event.entityType, event.entityId, event.kind), event)
    }
    if (event.entityType === 'run' && isRunProjectionEvent(event)) runProjections.set(event.entityId, event)
    if (event.kind === 'evidence.linked' && typeof event.payload.id === 'string') {
      evidenceLinks.set(event.payload.id, event)
    }
  }
  return { entityKinds, runProjections, evidenceLinks }
}

export function latestEntityEvent(
  projectionEvents: ProjectionEventIndex,
  entityType: WorkflowEventRecord['entityType'],
  entityId: string,
  kinds: readonly string[]
): WorkflowEventRecord | undefined {
  let latest: WorkflowEventRecord | undefined
  for (const kind of kinds) {
    const candidate = projectionEvents.entityKinds.get(projectionEntityKindKey(entityType, entityId, kind))
    if (candidate && (!latest || candidate.seq > latest.seq)) latest = candidate
  }
  return latest
}

export function isRunProjectionEvent(event: WorkflowEventRecord): boolean {
  if (event.kind === 'run.projected' || event.kind === 'run.recovered') return true
  const payload = event.payload
  return typeof payload.runId === 'string' && typeof payload.workItemId === 'string' &&
    typeof payload.taskId === 'string' && typeof payload.status === 'string' &&
    typeof payload.revision === 'number' && typeof payload.attempt === 'number'
}

function projectionEntityKindKey(
  entityType: WorkflowEventRecord['entityType'],
  entityId: string,
  kind: string
): string {
  return `${entityType}\u0000${entityId}\u0000${kind}`
}
