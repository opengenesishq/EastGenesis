import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Goal,
  GoalInput,
  ProjectMember,
  ProjectInvitation,
  ProjectCollaborationInboxItem,
  ProjectAuthorizationView,
  ProjectSquad,
  ProjectWorkspace,
  ProjectWorkspaceInput,
  WorkItem,
  WorkItemComment,
  WorkItemSharedApproval,
  WorkItemInput
} from '../../../../shared/types'
import { AUTO_MODEL, AUTO_PROVIDER_ID } from '../../../../shared/types'
import { useStore } from '../../store'
import { compareWorkItemsByBoardOrder, errorText, TEXT, type StudioMutationKind } from './projectWorkspaceStudioModel'

export function useWorkspaceSelection(
  active: boolean,
  initialProjectId?: string,
  onProjectChange?: (project: ProjectWorkspace | null) => void
): {
  projects: ProjectWorkspace[]
  selectedProject: ProjectWorkspace | null
  selectedProjectId: string
  loading: boolean
  error: string
  selectProject: (id: string) => void
  refreshProjects: (preferredId?: string) => Promise<void>
} {
  const projects = useStore((state) => state.projectWorkspaces)
  const storeLoading = useStore((state) => state.projectWorkspacesLoading)
  const storeError = useStore((state) => state.projectWorkspacesError)
  const refreshStoredProjects = useStore((state) => state.refreshProjectWorkspaces)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const request = useRef(0)
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  )

  const refreshProjects = useCallback(async (preferredId?: string): Promise<void> => {
    const requestId = ++request.current
    setError('')
    try {
      const next = await refreshStoredProjects()
      if (requestId !== request.current) return
      setSelectedProjectId((current) => chooseProjectId(next, preferredId || current))
      setLoaded(true)
    } catch (cause) {
      if (requestId === request.current) setError(errorText(cause))
    }
  }, [refreshStoredProjects])

  useEffect(() => {
    if (!active) {
      request.current += 1
      return
    }
    if (!loaded) void refreshProjects(initialProjectId)
  }, [active, initialProjectId, loaded, refreshProjects])
  useEffect(() => {
    setSelectedProjectId((current) => chooseProjectId(projects, initialProjectId || current))
  }, [initialProjectId, projects])
  useEffect(() => { onProjectChange?.(selectedProject) }, [onProjectChange, selectedProject])
  useEffect(() => () => { request.current += 1 }, [])

  return {
    projects,
    selectedProject,
    selectedProjectId,
    loading: active && !error && !storeError && (!loaded || storeLoading),
    error: error || storeError || '',
    selectProject: setSelectedProjectId,
    refreshProjects
  }
}

type ProjectCollaborationContents = {
  squads: ProjectSquad[]
  members: ProjectMember[]
  invitations: ProjectInvitation[]
  comments: WorkItemComment[]
  sharedApprovals: WorkItemSharedApproval[]
  collaborationInbox: ProjectCollaborationInboxItem[]
  authorization: ProjectAuthorizationView | null
  collaborationLoading: boolean
  collaborationError: string
  refreshCollaborationContents: () => Promise<void>
}

function useProjectCollaborationContents(active: boolean, projectId: string): ProjectCollaborationContents {
  const [squads, setSquads] = useState<ProjectSquad[]>([])
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([])
  const [comments, setComments] = useState<WorkItemComment[]>([])
  const [sharedApprovals, setSharedApprovals] = useState<WorkItemSharedApproval[]>([])
  const [collaborationInbox, setCollaborationInbox] = useState<ProjectCollaborationInboxItem[]>([])
  const [authorization, setAuthorization] = useState<ProjectAuthorizationView | null>(null)
  const [collaborationLoading, setCollaborationLoading] = useState(false)
  const [collaborationError, setCollaborationError] = useState('')
  const collaborationRequest = useRef(0)

  const refreshCollaborationContents = useCallback(async (): Promise<void> => {
    if (!projectId) return
    const requestId = ++collaborationRequest.current
    setCollaborationLoading(true)
    setCollaborationError('')
    try {
      const [nextSquads, nextMembers, nextInvitations, nextComments, nextApprovals, nextInbox, nextAuthorization] = await Promise.all([
        window.agentDesk.listProjectSquads(projectId, { includeArchived: true }),
        window.agentDesk.listProjectMembers(projectId, { includeArchived: true }),
        window.agentDesk.listProjectInvitations(projectId, { includeArchived: true }),
        window.agentDesk.listProjectComments(projectId),
        window.agentDesk.listProjectSharedApprovals(projectId),
        window.agentDesk.listProjectCollaborationInbox(projectId, { includeHandled: true }),
        window.agentDesk.getProjectAuthorization(projectId)
      ])
      if (requestId !== collaborationRequest.current) return
      setSquads(nextSquads.sort((left, right) => left.name.localeCompare(right.name)))
      setMembers(nextMembers.sort((left, right) => (left.principal.displayName || left.principal.id).localeCompare(right.principal.displayName || right.principal.id)))
      setInvitations(nextInvitations.sort((left, right) => right.createdAt - left.createdAt))
      setComments(nextComments.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)))
      setSharedApprovals(nextApprovals.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id)))
      setCollaborationInbox(nextInbox)
      setAuthorization(nextAuthorization)
    } catch (cause) {
      if (requestId === collaborationRequest.current) setCollaborationError(errorText(cause))
    } finally {
      if (requestId === collaborationRequest.current) setCollaborationLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    collaborationRequest.current += 1
    setCollaborationError('')
    setCollaborationLoading(false)
    setSquads([])
    setMembers([])
    setInvitations([])
    setComments([])
    setSharedApprovals([])
    setCollaborationInbox([])
    setAuthorization(null)
  }, [active, projectId])
  useEffect(() => () => { collaborationRequest.current += 1 }, [])

  return {
    squads,
    members,
    invitations,
    comments,
    sharedApprovals,
    collaborationInbox,
    authorization,
    collaborationLoading,
    collaborationError,
    refreshCollaborationContents
  }
}

export function useProjectContents(active: boolean, projectId: string): {
  goals: Goal[]
  workItems: WorkItem[]
  squads: ProjectSquad[]
  members: ProjectMember[]
  invitations: ProjectInvitation[]
  comments: WorkItemComment[]
  sharedApprovals: WorkItemSharedApproval[]
  collaborationInbox: ProjectCollaborationInboxItem[]
  authorization: ProjectAuthorizationView | null
  loading: boolean
  error: string
  collaborationLoading: boolean
  collaborationError: string
  refreshContents: () => Promise<void>
  refreshCollaborationContents: () => Promise<void>
} {
  const [goals, setGoals] = useState<Goal[]>([])
  const [workItems, setWorkItems] = useState<WorkItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(0)
  const loadedProjectId = useRef('')
  const collaboration = useProjectCollaborationContents(active, projectId)

  const refreshContents = useCallback(async (): Promise<void> => {
    if (!projectId) return
    const requestId = ++request.current
    setLoading(true)
    setError('')
    try {
      const contents = await window.agentDesk.listProjectWorkspaceContents(projectId, {
        goals: { includeArchived: true },
        workItems: {}
      })
      const nextGoals = contents.goals
      const nextWorkItems = contents.workItems
      if (requestId !== request.current) return
      setGoals(nextGoals.sort((left, right) => right.updatedAt - left.updatedAt))
      setWorkItems(nextWorkItems.sort(compareWorkItemsByBoardOrder))
      loadedProjectId.current = projectId
    } catch (cause) {
      if (requestId === request.current) setError(errorText(cause))
    } finally {
      if (requestId === request.current) setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    request.current += 1
    setError('')
    if (!active) {
      setLoading(false)
      return
    }
    if (!projectId) {
      loadedProjectId.current = ''
      setLoading(false)
      setGoals([])
      setWorkItems([])
      return
    }
    if (loadedProjectId.current !== projectId) {
      setGoals([])
      setWorkItems([])
      void refreshContents()
    }
  }, [active, projectId, refreshContents])
  useEffect(() => () => { request.current += 1 }, [])

  return {
    goals,
    workItems,
    ...collaboration,
    loading,
    error,
    refreshContents
  }
}

export function useStudioCreateActions({
  onSuccess,
  refreshContents,
  refreshProjects
}: {
  onSuccess: () => void
  refreshContents: () => Promise<void>
  refreshProjects: (preferredId?: string) => Promise<void>
}): {
  busy: StudioMutationKind | null
  error: string
  announcement: string
  clearFeedback: () => void
  importProject: (file: File) => Promise<void>
  createProject: (input: ProjectWorkspaceInput) => Promise<void>
  createGoal: (input: GoalInput) => Promise<void>
  createWorkItem: (input: WorkItemInput) => Promise<void>
} {
  const [busy, setBusy] = useState<StudioMutationKind | null>(null)
  const [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')

  const run = useCallback(async <T,>(
    kind: StudioMutationKind,
    action: () => Promise<T>,
    after: (result: T) => Promise<void>,
    successMessage: string
  ): Promise<void> => {
    setBusy(kind)
    setError('')
    setAnnouncement('')
    try {
      const result = await action()
      await after(result)
      setAnnouncement(successMessage)
      onSuccess()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(null)
    }
  }, [onSuccess])

  const createProject = useCallback(async (input: ProjectWorkspaceInput): Promise<void> => {
    setBusy('project')
    setError('')
    setAnnouncement('')
    try {
      const created = await window.agentDesk.createProjectWorkspaceWithTemplate(input)
      await refreshProjects(created.id)
      setAnnouncement(TEXT.projectCreated)
      onSuccess()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(null)
    }
  }, [onSuccess, refreshProjects])
  const importProject = useCallback((file: File) => run(
    'import',
    async () => window.agentDesk.importProjectWorkspaceData(await file.text()),
    (result) => refreshProjects(result.projectId),
    TEXT.projectImported
  ), [refreshProjects, run])
  const createGoal = useCallback((input: GoalInput) => run(
    'goal', () => window.agentDesk.createProjectGoal(input), async () => refreshContents(), TEXT.goalCreated
  ), [refreshContents, run])
  const createWorkItem = useCallback((input: WorkItemInput) => run(
    'workItem', () => window.agentDesk.createProjectWorkItem(input), async () => refreshContents(), TEXT.workItemCreated
  ), [refreshContents, run])
  const clearFeedback = useCallback(() => { setError(''); setAnnouncement('') }, [])

  return { busy, error, announcement, clearFeedback, importProject, createProject, createGoal, createWorkItem }
}

export function useProjectGoalTaskStart(refreshContents: () => Promise<void>): {
  busy: boolean
  error: string
  announcement: string
  start: (projectId: string, objective: string) => Promise<boolean>
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const locked = useRef(false)
  const retry = useRef<{ key: string; requestId: string; sessionId?: string } | null>(null)

  const start = useCallback(async (projectId: string, rawObjective: string): Promise<boolean> => {
    const objective = rawObjective.trim()
    if (!objective || locked.current) return false
    locked.current = true
    setBusy(true)
    setError('')
    setAnnouncement('')
    const key = `${projectId}\0${objective}`
    if (retry.current?.key !== key) retry.current = { key, requestId: newGoalTaskRequestId() }
    try {
      const result = await window.agentDesk.createProjectGoalTask({
        requestId: retry.current.requestId,
        projectId,
        objective
      })
      await refreshContents()
      const sessionId = retry.current.sessionId ?? await useStore.getState().createSession({
          cwd: '',
          workspaceId: projectId,
          goalId: result.goal.id,
          workItemId: result.workItem.id,
          model: AUTO_MODEL,
          providerId: AUTO_PROVIDER_ID,
          routingScope: 'global',
          initialPrompt: objective,
          taskStrategy: 'plan',
          title: result.workItem.title
        })
      retry.current.sessionId = sessionId
      useStore.getState().selectSession(sessionId)
      const plan = await useStore.getState().generateTaskPlan(sessionId, { objective })
      if (!plan?.currentVersion) throw new Error('工作流草案未生成，任务与会话已保留，可重试')
      retry.current = null
      setAnnouncement(TEXT.goalTaskStarted)
      return true
    } catch (cause) {
      setError(errorText(cause))
      return false
    } finally {
      locked.current = false
      setBusy(false)
    }
  }, [refreshContents])

  return { busy, error, announcement, start }
}

function newGoalTaskRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `goal-task-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function chooseProjectId(projects: ProjectWorkspace[], preferredId?: string): string {
  if (preferredId && projects.some((project) => project.id === preferredId)) return preferredId
  return projects[0]?.id ?? ''
}
