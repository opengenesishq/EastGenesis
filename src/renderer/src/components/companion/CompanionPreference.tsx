import { useStore } from '../../store'
import { useState } from 'react'
import { normalizeDesktopCompanionSettings } from '../../../../shared/desktop-companion-settings'
import CompanionImageSettings from './CompanionImageSettings'

export default function CompanionPreference(): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const settings = useStore(state => state.settings)
  const updateSettings = useStore(state => state.updateSettings)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const preferences = normalizeDesktopCompanionSettings(settings.desktopCompanion)
  const setDesktopEnabled = (value: boolean): void => {
    if (saving) return
    setSaving(true); setError('')
    void updateSettings({ desktopCompanion: { ...normalizeDesktopCompanionSettings(useStore.getState().settings.desktopCompanion), enabled: value } })
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setSaving(false))
  }
  return <div className="settings-section" data-companion-settings>
    <h3 className="settings-h3">{zh ? 'EastGenesis 浮窗' : 'EastGenesis companion'}</h3>
    <label className="settings-check">
      <input type="checkbox" disabled={saving} checked={preferences.enabled} onChange={event => setDesktopEnabled(event.target.checked)} />
      {zh ? '显示 EastGenesis 状态浮窗' : 'Show the EastGenesis status companion'}
    </label>
    <label className="field-label">{zh ? '显示方式' : 'Display mode'}
      <select className="select" disabled={saving} value={preferences.mode ?? 'figure'} onChange={event => {
        const mode = event.target.value as 'figure' | 'mini'
        setSaving(true); setError('')
        void updateSettings({ desktopCompanion: { ...normalizeDesktopCompanionSettings(useStore.getState().settings.desktopCompanion), mode } })
          .catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setSaving(false))
      }}><option value="figure">{zh ? 'EastGenesis 图标' : 'EastGenesis mark'}</option><option value="mini">{zh ? 'Mini 精简浮窗' : 'Mini'}</option></select>
    </label>
    <label className="field-label">{zh ? '图标大小' : 'Mark size'}
      <select className="select" disabled={saving} value={preferences.size} onChange={event => {
        const size = event.target.value as 'small' | 'medium' | 'large'
        setSaving(true); setError('')
        void updateSettings({ desktopCompanion: { ...normalizeDesktopCompanionSettings(useStore.getState().settings.desktopCompanion), size } })
          .catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setSaving(false))
      }}><option value="small">{zh ? '小' : 'Small'}</option><option value="medium">{zh ? '中' : 'Medium'}</option><option value="large">{zh ? '大' : 'Large'}</option></select>
    </label>
    {error && <p role="alert" className="notice notice-error">{error}</p>}
    <CompanionImageSettings />
    <p className="settings-hint">{zh ? '在独立桌面窗口查看任务进度、待审批事项并继续工作。显示和图标大小设置立即生效。' : 'Use the separate desktop window to check task activity, approvals, and continue work. Visibility and mark size apply immediately.'}</p>
  </div>
}
