import { useEffect, useMemo } from 'react'
import { AUTO_MODEL, caogenDrivePolicyView } from '../../../../shared/types'
import type {
  AppSettings,
  CaoGenDriveMode,
  Project,
  ProviderView
} from '../../../../shared/types'
import { useStore } from '../../store'
import type { WelcomeDraftState, WelcomeRoutingMode } from '../../store/welcome-draft'
import { resolveWelcomeComputeSelection } from './welcome-session-projection'

export const NEW_PROJECT = '__new_project__'
export const UNASSIGNED = '__unassigned__'

interface WelcomeDraftControllerOptions {
  projects: Project[]
  providers: ProviderView[]
  requestedProjectId: string | null
  settings: AppSettings
  preferInitialProject?: boolean
}

function resolveProjectDraft(
  availableProjects: Project[],
  storedProjectChoice: string | null,
  storedCwd: string | null,
  initialProject: Project | undefined,
  projectsLoaded: boolean
): { projectChoice: string; cwd: string } {
  if (!projectsLoaded) {
    return { projectChoice: storedProjectChoice ?? UNASSIGNED, cwd: storedCwd ?? '' }
  }
  const storedProjectMissing = storedProjectChoice !== null
    && storedProjectChoice !== NEW_PROJECT
    && storedProjectChoice !== UNASSIGNED
    && !availableProjects.some((project) => project.id === storedProjectChoice)
  if (storedProjectMissing) return { projectChoice: UNASSIGNED, cwd: '' }
  return {
    projectChoice: storedProjectChoice ?? initialProject?.id ?? UNASSIGNED,
    cwd: storedCwd ?? initialProject?.path ?? ''
  }
}

export function useWelcomeDraftController({
  projects,
  providers,
  requestedProjectId,
  settings,
  preferInitialProject = true
}: WelcomeDraftControllerOptions) {
  const stored = useStore((state) => state.welcomeDraft)
  const update = useStore((state) => state.updateWelcomeDraft)
  const clear = useStore((state) => state.clearWelcomeDraft)
  const projectsLoaded = useStore((state) => state.projectsLoaded)
  const providersLoaded = useStore((state) => state.providersLoaded)
  const availableProjects = useMemo(
    () => projects.filter((project) => !project.archived),
    [projects]
  )
  const initialProject = availableProjects.find((project) => project.id === requestedProjectId)
    ?? (preferInitialProject ? availableProjects[0] : undefined)
  const { projectChoice, cwd } = resolveProjectDraft(
    availableProjects,
    stored.projectChoice,
    stored.cwd,
    initialProject,
    projectsLoaded
  )
  const driveMode = stored.driveMode ?? settings.driveMode
  const { providerId, model, routingMode } = useResolvedProviderDraft(
    providers,
    settings,
    stored,
    providersLoaded,
    update
  )
  const permissionMode = stored.permissionMode
    ?? caogenDrivePolicyView(settings.driveMode).defaultPermissionMode

  useEffect(() => {
    if (!projectsLoaded || stored.projectChoice !== null || stored.cwd || !initialProject) return
    update({ projectChoice: initialProject.id, cwd: initialProject.path })
  }, [initialProject, projectsLoaded, stored.cwd, stored.projectChoice, update])

  useEffect(() => {
    if (!projectsLoaded || !requestedProjectId) return
    const requested = availableProjects.find((project) => project.id === requestedProjectId)
    if (requested) update({ projectChoice: requested.id, cwd: requested.path })
  }, [availableProjects, projectsLoaded, requestedProjectId, update])

  useEffect(() => {
    const storedProjectChoice = stored.projectChoice
    if (!projectsLoaded) return
    if (storedProjectChoice === null || storedProjectChoice === NEW_PROJECT || storedProjectChoice === UNASSIGNED) return
    if (!availableProjects.some((project) => project.id === storedProjectChoice)) {
      update({ projectChoice: UNASSIGNED, cwd: '' })
    }
  }, [availableProjects, projectsLoaded, stored.projectChoice, update])

  const setRoutingMode = (routingMode: WelcomeRoutingMode, firstFixedModel: string): void => {
    update({
      computeSelectionSource: 'user',
      routingMode,
      model: routingMode === 'fixed' ? firstFixedModel : AUTO_MODEL
    })
  }
  const setProvider = (nextProviderId: string): void => {
    const provider = providers.find((item) => item.id === nextProviderId)
    update({
      computeSelectionSource: 'user',
      providerId: nextProviderId,
      model: routingMode === 'fixed' ? provider?.models[0] ?? '' : AUTO_MODEL
    })
  }
  const setDriveMode = (nextDriveMode: CaoGenDriveMode): void => {
    const selectedProvider = providers.find((provider) => provider.id === providerId)
    const nextModel = routingMode === 'fixed'
      ? selectedProvider?.models.includes(model) ? model : ''
      : providerId ? AUTO_MODEL : ''
    update({
      driveMode: nextDriveMode,
      model: nextModel,
      permissionMode: caogenDrivePolicyView(nextDriveMode).defaultPermissionMode
    })
  }
  const setProject = (nextProjectChoice: string): void => {
    const project = projects.find((item) => item.id === nextProjectChoice)
    update({ projectChoice: nextProjectChoice, cwd: project?.path ?? '' })
  }
  const setPickedDirectory = (nextCwd: string): void => {
    update({
      // A folder is optional context for the single conversation workspace,
      // never a project selection or a mode switch.
      projectChoice: UNASSIGNED,
      cwd: nextCwd
    })
  }

  return {
    availableProjects,
    clear,
    cwd,
    driveMode,
    model,
    permissionMode,
    projectChoice,
    providerId,
    routingMode,
    setDriveMode,
    setPickedDirectory,
    setProject,
    setProvider,
    setRoutingMode,
    text: stored.text,
    update
  }
}

function useResolvedProviderDraft(
  providers: ProviderView[],
  settings: AppSettings,
  stored: WelcomeDraftState,
  providersLoaded: boolean,
  update: (patch: Partial<WelcomeDraftState>) => void
): { providerId: string; model: string; routingMode: WelcomeRoutingMode } {
  const resolved = resolveWelcomeComputeSelection(
    providers,
    settings.defaultProviderId,
    settings.defaultModel,
    stored,
    providersLoaded
  )

  useEffect(() => {
    if (!providersLoaded || stored.executionTarget?.kind === 'remote') return
    if ((stored.providerId ?? '') === resolved.providerId
      && (stored.model ?? '') === resolved.model
      && stored.routingMode === resolved.routingMode) return
    update({
      providerId: resolved.providerId || null,
      model: resolved.model || null,
      routingMode: resolved.routingMode
    })
  }, [providersLoaded, resolved.model, resolved.providerId, resolved.routingMode, stored.model, stored.providerId, stored.routingMode, stored.executionTarget?.kind, update])

  return resolved
}
