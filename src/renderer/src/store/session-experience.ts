import type { CreateSessionOptions, HistoryEntry, SessionMeta } from '../../../shared/types'
import { nextStudioSessionNonce } from './project-workspace-actions'

type SessionOwnership = Pick<
  SessionMeta,
  'workspaceId' | 'projectId' | 'goalId' | 'workItemId' | 'experienceModeOverride'
>

export function sessionExperienceMode(meta: SessionOwnership): 'assistant' | 'studio' {
  // A session may retain a legacy path-based projectId for tool context while
  // still belonging to the Assistant entry. The explicit creation projection
  // is authoritative for the surface shown after reload or session switching.
  if (meta.experienceModeOverride) return meta.experienceModeOverride
  return meta.workspaceId || meta.projectId || meta.goalId || meta.workItemId ? 'studio' : 'assistant'
}

export function sessionProjectionPatch(currentNonce: number, meta: SessionOwnership): {
  experienceMode: 'assistant' | 'studio'
  studioSessionNavigationNonce: number
} {
  const experienceMode = sessionExperienceMode(meta)
  return {
    experienceMode,
    studioSessionNavigationNonce: nextStudioSessionNonce(currentNonce, experienceMode)
  }
}

export function historyResumeOptions(entry: HistoryEntry): CreateSessionOptions {
  return {
    businessLineId: entry.businessLineId,
    cwd: entry.cwd,
    projectId: entry.projectId,
    workspaceId: entry.workspaceId,
    goalId: entry.goalId,
    workItemId: entry.workItemId,
    unassigned: entry.unassigned,
    personalWorkspaceId: entry.personalWorkspaceId,
    experienceModeOverride: entry.experienceModeOverride,
    model: entry.model,
    providerId: entry.providerId,
    routingScope: entry.routingScope,
    engine: entry.engine,
    taskStrategy: entry.taskStrategy,
    resumeSdkSessionId: entry.sdkSessionId,
    resumeSessionAt: entry.resumeSessionAt,
    title: entry.title
  }
}
