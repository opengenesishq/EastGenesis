import type { ProjectGoalTaskPrepareInput, ProjectGoalTaskPrepared, ProjectGoalTaskStartInput, ProjectGoalTaskStarted } from '../../shared/project-workspace-types'
import { listHistory } from '../history'
import { listPendingSessionCreations } from '../session-creation-journal'
import { sessionManager } from '../sessionManager'
import { listTaskSnapshots } from '../task/task-snapshot'
import { ProjectGoalSubmissionService, type ProjectGoalSubmissionRuntime } from './goal-submission-service'
import { ProjectGoalStartService } from './goal-start-service'
import { getSessionInputService } from '../task/session-input-runtime'
import { withAssignmentOwnerWriteAccess } from '../assignment-owner-coordinator'

export async function prepareProjectGoalTask(input: ProjectGoalTaskPrepareInput, rootDir: string): Promise<ProjectGoalTaskPrepared> {
  await sessionManager.whenInitialized()
  return new ProjectGoalSubmissionService(rootDir, goalRuntime(rootDir)).prepare(input)
}

export async function startProjectGoalTask(input: ProjectGoalTaskStartInput, rootDir: string): Promise<ProjectGoalTaskStarted> {
  await sessionManager.whenInitialized()
  return new ProjectGoalStartService(rootDir, {
    ...goalRuntime(rootDir),
    prepare: (preparedInput) => prepareProjectGoalTask(preparedInput, rootDir),
    withTaskWriteAccess: (operation) => withAssignmentOwnerWriteAccess(rootDir, operation),
    inputs: getSessionInputService(rootDir)
  }).start(input)
}

function goalRuntime(rootDir: string): ProjectGoalSubmissionRuntime {
  return {
    withTaskWriteAccess: (operation) => withAssignmentOwnerWriteAccess(rootDir, operation),
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
  }
}
