import type { ProjectGoalTaskPrepareInput, ProjectGoalTaskPrepared } from '../../shared/project-workspace-types'
import { listHistory } from '../history'
import { listPendingSessionCreations } from '../session-creation-journal'
import { sessionManager } from '../sessionManager'
import { listTaskSnapshots } from '../task/task-snapshot'
import { ProjectGoalSubmissionService } from './goal-submission-service'

export function prepareProjectGoalTask(input: ProjectGoalTaskPrepareInput, rootDir: string): Promise<ProjectGoalTaskPrepared> {
  return new ProjectGoalSubmissionService(rootDir, {
    whenInitialized: () => sessionManager.whenInitialized(),
    get: (id) => sessionManager.get(id),
    identities: async () => [
      ...sessionManager.list(), ...listHistory(),
      ...(await listTaskSnapshots(rootDir)).map((snapshot) => snapshot.meta),
      ...listPendingSessionCreations().map((draft) => draft.baseMeta)
    ],
    createManaged: (options, lifecycle) => sessionManager.createManaged(options, lifecycle),
    getTaskPlan: (id) => sessionManager.getTaskPlan(id),
    generateTaskPlan: (id, options) => sessionManager.generateTaskPlan(id, options),
    compileMissionTaskPlan: (id, options) => sessionManager.compileMissionTaskPlan(id, options)
  }).prepare(input)
}
