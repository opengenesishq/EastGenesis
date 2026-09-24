import type { AppSettings } from '../../../../shared/types'
import { normalizeNotificationPreferences } from '../../../../shared/desktop-behavior-preferences'
import { PreferenceRow } from './DesktopPreferences'
export default function NotificationPreferences({ draft, onChange }: { draft: AppSettings; onChange(patch: Partial<AppSettings>): void }): React.JSX.Element {
  const zh = draft.language === 'zh', config = normalizeNotificationPreferences(draft.notificationPreferences)
  const labels = { failures: zh ? '任务失败' : 'Task failures', approvals: zh ? '等待审批' : 'Approval requests', sound: zh ? '通知声音' : 'Notification sound' }
  return <section><h2 className="desktop-preference-heading">{zh ? '桌面通知' : 'Desktop notifications'}</h2><div className="desktop-preference-card">
    <PreferenceRow title={zh ? '允许桌面通知' : 'Allow desktop notifications'} description={zh ? '也需要系统允许 EastGenesis 发送通知。' : 'Your system must also allow EastGenesis notifications.'}>
      <input type="checkbox" aria-label={zh ? '允许桌面通知' : 'Allow desktop notifications'} checked={draft.notificationsEnabled} onChange={event => onChange({ notificationsEnabled: event.target.checked })} />
    </PreferenceRow>
    <PreferenceRow title={zh ? '任务完成' : 'Task completion'}><select className="select" aria-label={zh ? '任务完成通知' : 'Task completion notifications'} disabled={!draft.notificationsEnabled} value={config.completion} onChange={event => onChange({ notificationPreferences: { ...config, completion: event.target.value as typeof config.completion } })}>
      <option value="never">{zh ? '从不' : 'Never'}</option><option value="background">{zh ? '仅工作台在后台时' : 'When the workbench is in the background'}</option><option value="always">{zh ? '总是' : 'Always'}</option>
    </select></PreferenceRow>
    {(['failures', 'approvals', 'sound'] as const).map(key => <PreferenceRow key={key} title={labels[key]}><input type="checkbox" aria-label={labels[key]} disabled={!draft.notificationsEnabled} checked={config[key]} onChange={event => onChange({ notificationPreferences: { ...config, [key]: event.target.checked } })} /></PreferenceRow>)}
  </div></section>
}
