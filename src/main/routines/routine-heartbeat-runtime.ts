import { sessionManager } from '../sessionManager'
import { getSessionInputService } from '../task/session-input-runtime'
import { listTaskRuns } from '../task/task-snapshot'
import { readTranscriptEntriesStrict } from '../transcript'
import { showDesktopNotification } from '../desktopNotify'
import { getSettings } from '../settings'
import { buildRoutineRunNotification } from './personal-os'
import { persistRoutineResultEvidence } from './routine-result-artifact'
import { RoutineHeartbeatService } from './routine-heartbeat-service'
import { checkGoalContinuation } from './goal-continuation-runtime'
import { reserveGoalContinuationTurn, settleGoalContinuationTurn } from './goal-continuation-progress'

const services = new Map<string, RoutineHeartbeatService>()
export function routineHeartbeatService(routineRoot: string, workspaceRoot: string): RoutineHeartbeatService {
  const key = `${routineRoot}\0${workspaceRoot}`
  let service = services.get(key)
  if (service) return service
  service = new RoutineHeartbeatService(routineRoot, {
    ownershipRoot: workspaceRoot,
    goalCheck: (routine, record) => checkGoalContinuation(workspaceRoot, routine, record),
    goalReserve: record => reserveGoalContinuationTurn(routineRoot, record),
    goalSettle: record => settleGoalContinuationTurn(routineRoot, record),
    meta: (id) => sessionManager.get(id)?.meta,
    inputs: getSessionInputService(workspaceRoot),
    runs: async (id) => {
      await sessionManager.persistTaskRunLifecycleBarrier(id)
      return listTaskRuns(id, workspaceRoot)
    },
    result: (sessionId, messageId) => {
      const meta = sessionManager.get(sessionId)?.meta
      const transcript = meta?.sdkSessionId ? readTranscriptEntriesStrict(meta.sdkSessionId) : sessionManager.getTranscript(sessionId)
      const index = transcript.findIndex(({ event }) => event.kind === 'user-message' && event.messageId === messageId)
      if (index < 0) return undefined
      for (const entry of transcript.slice(index + 1)) {
        if (entry.event.kind === 'user-message') return undefined
        if (entry.event.kind === 'turn-result') return { text: entry.event.resultText ?? '', isError: entry.event.isError, observedAt: entry.occurredAt }
      }
      return undefined
    },
    persistResult: (record, run, text) => persistRoutineResultEvidence(workspaceRoot, workspaceRoot, record, run.id, text, run.finishedAt ?? run.updatedAt),
    notify: (routine, record) => {
      const notification = buildRoutineRunNotification(routine, record, getSettings())
      if (notification) showDesktopNotification(notification)
    }
  })
  services.set(key, service)
  return service
}
