import type { ProjectWorkspace, ProjectWorkspaceEvent } from '../../shared/project-workspace-types'
import {
  PROJECT_INSTITUTION_MIGRATION_EVENT,
  projectInstitutionTemplate,
  type ProjectInstitutionTemplateRef
} from '../../shared/project-institution-template'
import { openProjectWorkspaceStore } from './store'
import { assertInstitutionMigrationEvents } from './institution-migration'

/** Migration changes future Goals. The first migration covering an existing Goal freezes its prior template. */
export function resolveGoalInstitutionTemplate(
  workspace: ProjectWorkspace,
  events: readonly ProjectWorkspaceEvent[],
  goalId?: string,
  workItemId?: string
): ProjectInstitutionTemplateRef {
  if (!goalId?.trim() && !workItemId?.trim()) throw new Error('机构职责解析缺少原任务身份')
  const migrations = events.filter((event) => event.projectId === workspace.id && event.kind === PROJECT_INSTITUTION_MIGRATION_EVENT)
    .sort((left, right) => left.revision - right.revision)
  assertInstitutionMigrationEvents([workspace], migrations)
  const original = migrations.find((event) => goalId
    ? (event.payload.preservedGoalIds as string[]).includes(goalId)
    : (event.payload.preservedWorkItemIds as string[]).includes(workItemId!))
  const template = original?.payload.fromTemplate as ProjectInstitutionTemplateRef | undefined
  return { ...(template ?? projectInstitutionTemplate(workspace.institutionTemplate).ref) }
}

/** Read the current project and its migration events from one durable snapshot. */
export async function readGoalInstitutionContext(rootDir: string, projectId: string, goalId?: string, workItemId?: string): Promise<{
  workspace: ProjectWorkspace
  template: ProjectInstitutionTemplateRef
}> {
  const state = await (await openProjectWorkspaceStore(rootDir)).getState()
  const workspace = state.workspaces.find((entry) => entry.id === projectId)
  if (!workspace || workspace.status !== 'active') throw new Error('计划所属项目不存在或不可用')
  if (goalId && !state.goals.some((goal) => goal.id === goalId && goal.projectId === projectId)) {
    throw new Error('机构职责与原目标归属不一致')
  }
  if (workItemId && !state.workItems.some((item) => item.id === workItemId && item.projectId === projectId && (!goalId || item.goalId === goalId))) {
    throw new Error('机构职责与原任务归属不一致')
  }
  return { workspace, template: resolveGoalInstitutionTemplate(workspace, state.events, goalId, workItemId) }
}
