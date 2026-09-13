import type { TaskSnapshotRecord } from '../../shared/types'
import { mergeTaskRunRecords } from './task-run'

export function mergeTaskSnapshots(
  current: TaskSnapshotRecord,
  incoming: TaskSnapshotRecord
): TaskSnapshotRecord {
  const preferred = compareSnapshotFreshness(current, incoming) >= 0 ? current : incoming
  const other = preferred === current ? incoming : current
  // A Session can start a fresh Run before its first user-message event is
  // emitted.  In that short window both snapshots have the same transcript
  // cursor, so revision/time ordering would incorrectly keep the previous
  // terminal Run (revision 9) over the new queued Run (revision 1).  Prefer
  // the active Run when replacing a terminal one; stale terminal snapshots
  // remain unable to overwrite an in-flight Run.
  const run = chooseSnapshotRun(current.run, incoming.run, preferred.run, other.run)
  return {
    ...preferred,
    createdAt: current.createdAt,
    updatedAt: Math.max(current.updatedAt, incoming.updatedAt, run?.updatedAt ?? 0),
    ...(run ? { run } : {})
  }
}

function chooseSnapshotRun(
  current: TaskSnapshotRecord['run'],
  incoming: TaskSnapshotRecord['run'],
  preferred: TaskSnapshotRecord['run'],
  other: TaskSnapshotRecord['run']
): TaskSnapshotRecord['run'] {
  if (!current || !incoming || current.id === incoming.id) {
    return preferred && other && preferred.id === other.id
      ? mergeTaskRunRecords(preferred, other)
      : preferred ?? other
  }
  if (isTerminalRun(current.status) && !isTerminalRun(incoming.status)) return incoming
  if (!isTerminalRun(current.status) && isTerminalRun(incoming.status)) return current
  return preferred
}

function isTerminalRun(status: NonNullable<TaskSnapshotRecord['run']>['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function compareSnapshotFreshness(left: TaskSnapshotRecord, right: TaskSnapshotRecord): number {
  const leftCursor = left.execution.cursor?.seq ?? left.execution.lastSeq
  const rightCursor = right.execution.cursor?.seq ?? right.execution.lastSeq
  if (leftCursor !== rightCursor) return leftCursor - rightCursor
  const leftRevision = left.run?.revision ?? 0
  const rightRevision = right.run?.revision ?? 0
  if (leftRevision !== rightRevision) return leftRevision - rightRevision
  return left.updatedAt - right.updatedAt
}
