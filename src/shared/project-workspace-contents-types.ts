import type { Goal, WorkItem } from './project-workspace-types'

export interface ProjectWorkspaceListOptions {
  includeArchived?: boolean
  includeDeleted?: boolean
  goalId?: string
}

export interface ProjectWorkspaceContentsOptions {
  goals?: ProjectWorkspaceListOptions
  workItems?: ProjectWorkspaceListOptions
}

export interface ProjectWorkspaceContents {
  projectId: string
  goals: Goal[]
  workItems: WorkItem[]
}
