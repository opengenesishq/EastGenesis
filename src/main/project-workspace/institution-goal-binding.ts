import type { ProjectWorkspace, ProjectWorkspaceEvent } from '../../shared/project-workspace-types'
import {
  PROJECT_INSTITUTION_MIGRATION_EVENT,
  projectInstitutionTemplate,
  type ProjectInstitutionTemplateRef,
  type ProjectInstitutionRoleMapping
} from '../../shared/project-institution-template'
import type { ProjectInstitutionContext, ProjectInstitutionContextInput } from '../../shared/project-institution-template'
import type { ProjectWorkspaceState } from '../../shared/project-workspace-types'
import { openProjectWorkspaceStore } from './store'
import { assertInstitutionMigrationEvents, currentInstitutionRoleMappings } from './institution-migration'

export function projectInstitutionContext(state: ProjectWorkspaceState, input: ProjectInstitutionContextInput): ProjectInstitutionContext {
  const workspace = state.workspaces.find(item => item.id === input.projectId && item.status !== 'deleted')
  if (!workspace) throw new Error('机构所属项目不存在或不可用')
  const workItem = input.workItemId ? state.workItems.find(item => item.id === input.workItemId && item.projectId === workspace.id) : undefined
  if (input.workItemId && !workItem) throw new Error('机构职责与原任务归属不一致')
  if (input.goalId && workItem && workItem.goalId !== input.goalId) throw new Error('机构职责与原目标归属不一致')
  const goalId = input.goalId ?? workItem?.goalId
  if (goalId && !state.goals.some(goal => goal.id === goalId && goal.projectId === workspace.id)) throw new Error('机构职责与原目标归属不一致')
  const settings = goalId || workItem
    ? resolveGoalInstitutionSettings(workspace, state.events, goalId, workItem?.id)
    : { template: projectInstitutionTemplate(workspace.institutionTemplate).ref,
        roleMappings: currentInstitutionRoleMappings(workspace, state.events) }
  const recordedRoleIds = [...new Set(state.workItems.filter(item => item.projectId === workspace.id &&
    (goalId ? item.goalId === goalId : workItem ? item.id === workItem.id : true)).flatMap(item => item.role ? [item.role] : []))].sort()
  return { projectId: workspace.id, ...(goalId ? { goalId } : {}), ...(workItem ? { workItemId: workItem.id } : {}),
    workspaceRevision: workspace.revision, ...settings, recordedRoleIds }
}

/** Migration changes future Goals. The first migration covering an existing Goal freezes its prior template. */
export function resolveGoalInstitutionTemplate(
  workspace: ProjectWorkspace,
  events: readonly ProjectWorkspaceEvent[],
  goalId?: string,
  workItemId?: string
): ProjectInstitutionTemplateRef {
  return resolveGoalInstitutionSettings(workspace, events, goalId, workItemId).template
}

export function resolveGoalInstitutionSettings(
  workspace: ProjectWorkspace,
  events: readonly ProjectWorkspaceEvent[],
  goalId?: string,
  workItemId?: string
): { template: ProjectInstitutionTemplateRef; roleMappings: ProjectInstitutionRoleMapping[] } {
  if (!goalId?.trim() && !workItemId?.trim()) throw new Error('机构职责解析缺少原任务身份')
  const migrations = events.filter((event) => event.projectId === workspace.id && event.kind === PROJECT_INSTITUTION_MIGRATION_EVENT)
    .sort((left, right) => left.revision - right.revision)
  assertInstitutionMigrationEvents([workspace], migrations)
  const original = migrations.find((event) => goalId
    ? (event.payload.preservedGoalIds as string[]).includes(goalId)
    : (event.payload.preservedWorkItemIds as string[]).includes(workItemId!))
  const template = original?.payload.fromTemplate as ProjectInstitutionTemplateRef | undefined
  const roleMappings = original ? (original.payload.fromRoleMappings ?? []) as ProjectInstitutionRoleMapping[]
    : currentInstitutionRoleMappings(workspace, migrations)
  return { template: { ...(template ?? projectInstitutionTemplate(workspace.institutionTemplate).ref) },
    roleMappings: roleMappings.map(mapping => ({ ...mapping })) }
}

/** Read the current project and its migration events from one durable snapshot. */
export async function readGoalInstitutionContext(rootDir: string, projectId: string, goalId?: string, workItemId?: string): Promise<{
  workspace: ProjectWorkspace
  template: ProjectInstitutionTemplateRef
  roleMappings: ProjectInstitutionRoleMapping[]
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
  return { workspace, ...resolveGoalInstitutionSettings(workspace, state.events, goalId, workItemId) }
}
