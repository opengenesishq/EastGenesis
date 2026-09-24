import { join } from 'node:path'
import { sessionManager } from '../sessionManager'
import { listWorkflowLedger } from '../task/workflow-ledger-api'
import { listRoutineRuns } from './routine-runner'
import { RoutineInboxService } from './routine-inbox-service'

const services = new Map<string,RoutineInboxService>()
export function getRoutineInboxService(root: string): RoutineInboxService {
  let service = services.get(root)
  if (!service) {
    service = new RoutineInboxService(root, {
      runs: () => listRoutineRuns(join(root, 'routines')),
      meta: id => sessionManager.get(id)?.meta,
      ledger: run => listWorkflowLedger({ runId: run.workflowRunId, sessionId: run.sessionId,
        projectId: run.projectId, goalId: run.goalId, workItemId: run.workItemId, limit: 200 }, root)
    })
    services.set(root, service)
  }
  return service
}
