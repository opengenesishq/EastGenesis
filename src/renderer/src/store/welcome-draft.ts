import type { CaoGenDriveMode, PermissionModeId, TaskStrategy } from '../../../shared/types'
import { loadWelcomeDraft, persistWelcomeDraft } from './welcome-draft-persistence'
import type { WelcomeExecutionTarget, RemoteIntakeReference } from '../components/experience/welcome-remote-target'

export type WelcomeRoutingMode = 'fixed' | 'provider' | 'global'
export type WelcomeComputeSelectionSource = 'default' | 'user'

export interface WelcomeDraftState {
  executionTarget?: WelcomeExecutionTarget
  draftVersion?: number
  remoteIntakes?: RemoteIntakeReference[]
  text: string
  projectChoice: string | null
  cwd: string | null
  driveMode: CaoGenDriveMode | null
  computeSelectionSource: WelcomeComputeSelectionSource
  routingMode: WelcomeRoutingMode
  providerId: string | null
  model: string | null
  permissionMode: PermissionModeId | null
  taskStrategy?: TaskStrategy
  forkFromSdkSessionId?: string
  forkCheckpointId?: string
  forkSourceTitle?: string
}

export interface WelcomeDraftSlice {
  welcomeDraft: WelcomeDraftState
  updateWelcomeDraft(patch: Partial<WelcomeDraftState>): void
  clearWelcomeDraft(): void
}

export function emptyWelcomeDraft(): WelcomeDraftState {
  return {
    text: '',
    executionTarget: { kind: 'local' },
    draftVersion: 0,
    remoteIntakes: [],
    projectChoice: null,
    cwd: null,
    driveMode: null,
    computeSelectionSource: 'default',
    routingMode: 'global',
    providerId: null,
    model: null,
    permissionMode: null
  }
}

type WelcomeDraftStoreState = Pick<WelcomeDraftSlice, 'welcomeDraft'>

export function createWelcomeDraftSlice(
  set: (
    update: WelcomeDraftStoreState | ((state: WelcomeDraftStoreState) => WelcomeDraftStoreState)
  ) => void
): WelcomeDraftSlice {
  const initialDraft = loadWelcomeDraft(emptyWelcomeDraft())
  return {
    welcomeDraft: initialDraft,
    updateWelcomeDraft: (patch) =>
      set((state) => {
        const changesContent = Object.keys(patch).some(key => key !== 'remoteIntakes' && key !== 'draftVersion' && JSON.stringify(patch[key as keyof WelcomeDraftState]) !== JSON.stringify(state.welcomeDraft[key as keyof WelcomeDraftState]))
        const welcomeDraft = { ...state.welcomeDraft, ...patch, draftVersion: (state.welcomeDraft.draftVersion ?? 0) + (changesContent ? 1 : 0) }
        persistWelcomeDraft(welcomeDraft)
        return { welcomeDraft }
      }),
    clearWelcomeDraft: () => set(state => {
      const welcomeDraft = { ...emptyWelcomeDraft(), draftVersion: (state.welcomeDraft.draftVersion ?? 0) + 1, remoteIntakes: state.welcomeDraft.remoteIntakes ?? [] }
      persistWelcomeDraft(welcomeDraft)
      return { welcomeDraft }
    })
  }
}
