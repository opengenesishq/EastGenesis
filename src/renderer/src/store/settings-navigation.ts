export type SettingsTab =
  | 'control'
  | 'routing'
  | 'usage'
  | 'general'
  | 'appearance'
  | 'voice'
  | 'terminal'
  | 'git'
  | 'archived'
  | 'profile'
  | 'models'
  | 'environment'
  | 'permissions'
  | 'office'
  | 'providers'
  | 'notifications'
  | 'plugins'
  | 'data'
  | 'migrate'
  | 'feedback'
  | 'status'
  | 'browser'

export type SettingsContext = 'welcome-provider-recovery' | 'welcome-provider-import' | 'provider-recovery-exhausted' | 'first-launch-provider-onboarding'

export interface SettingsNavigationSlice {
  showSettings: boolean
  settingsTab: SettingsTab
  settingsContext: SettingsContext | null
  setShowSettings(value: boolean, tab?: SettingsTab, context?: SettingsContext): void
}

type SettingsNavigationState = Pick<
  SettingsNavigationSlice,
  'settingsContext' | 'settingsTab' | 'showSettings'
>

export function createSettingsNavigationSlice(
  set: (update: SettingsNavigationState) => void
): SettingsNavigationSlice {
  return {
    showSettings: false,
    settingsTab: 'general',
    settingsContext: null,
    setShowSettings: (showSettings, settingsTab = 'general', settingsContext) =>
      set({
        showSettings,
        settingsTab,
        settingsContext: showSettings ? settingsContext ?? null : null
      })
  }
}
