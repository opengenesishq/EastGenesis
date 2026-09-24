export type ExperienceMode = 'assistant' | 'studio' | 'video'
export type SessionExperienceMode = Exclude<ExperienceMode, 'video'>
export type StudioSurface = 'workspace' | 'result' | 'session'

export interface ExperienceModeSlice {
  experienceMode: ExperienceMode
  studioSurface: StudioSurface
  setExperienceMode(mode: ExperienceMode): void
  setStudioSurface(surface: StudioSurface): void
}

type ExperienceModeState = Pick<ExperienceModeSlice, 'experienceMode' | 'studioSurface'> & {
  showNewSession: boolean
  newSessionProjectId: string | null
}

export function createExperienceModeSlice(
  set: (update: Partial<ExperienceModeState>) => void,
  persist?: (mode: ExperienceMode) => void | Promise<void>
): ExperienceModeSlice {
  return {
    experienceMode: 'assistant',
    studioSurface: 'session',
    setExperienceMode: (experienceMode) => {
      if (experienceMode === 'studio') {
        set({
          experienceMode,
          studioSurface: 'workspace',
          showNewSession: false,
          newSessionProjectId: null
        })
      } else if (experienceMode === 'video') {
        set({ experienceMode, showNewSession: false, newSessionProjectId: null })
      } else {
        set({ experienceMode })
      }
      void persist?.(experienceMode)
    },
    setStudioSurface: (studioSurface) => set({ studioSurface })
  }
}
