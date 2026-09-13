export type SettingsTab =
  | 'control'
  | 'routing'
  | 'general'
  | 'permissions'
  | 'project'
  | 'persona'
  | 'office'
  | 'providers'
  | 'notifications'
  | 'plugins'
  | 'data'
  | 'migrate'

export type SettingsContext = 'welcome-provider-recovery' | 'provider-recovery-exhausted'

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
    settingsTab: 'control',
    settingsContext: null,
    setShowSettings: (showSettings, settingsTab = 'control', settingsContext) =>
      set({
        showSettings,
        settingsTab,
        settingsContext: showSettings ? settingsContext ?? null : null
      })
  }
}
