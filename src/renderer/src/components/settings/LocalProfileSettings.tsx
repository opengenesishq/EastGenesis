import { LOCAL_PROFILE_EMOJIS, desktopProfileAvatar, normalizeDesktopPersonalization, type DesktopPersonalizationSettings } from '../../../../shared/desktop-personalization'
import './desktop-personalization-settings.css'

export default function LocalProfileSettings({ value, language, onChange }: {
  value?: DesktopPersonalizationSettings; language: 'zh' | 'en'; onChange(value: DesktopPersonalizationSettings): void
}): React.JSX.Element {
  const zh = language === 'zh', settings = normalizeDesktopPersonalization(value), profile = settings.profile
  const update = (patch: Partial<typeof profile>): void => {
    onChange({ ...settings, profile: { ...profile, ...patch } })
  }
  return <section className="local-profile-settings" aria-label={zh ? '本地个人资料' : 'Local profile'}>
    <h2 className="desktop-preference-heading">{zh ? '本地个人资料' : 'Local profile'}</h2>
    <p className="settings-hint">{zh ? '显示在这台电脑的个人工作区入口，仅保存在本机。' : 'Shown in the personal workspace menu on this computer and stored locally.'}</p>
    <div className="local-profile-preview"><span aria-hidden="true">{desktopProfileAvatar(profile, language)}</span><div><strong>{profile.displayName || (zh ? '个人工作区' : 'Personal workspace')}</strong><small>{zh ? 'EastGenesis · 本地' : 'EastGenesis · Local'}</small></div></div>
    <label className="field-label" htmlFor="local-profile-name">{zh ? '显示名' : 'Display name'}</label>
    <input id="local-profile-name" className="input input-block" value={value?.profile.displayName ?? profile.displayName} maxLength={60} placeholder={zh ? '个人工作区' : 'Personal workspace'}
      onChange={event => update({ displayName: event.target.value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '') })} />
    <p className="settings-hint">{zh ? '最多 60 个字符；留空使用默认名称。' : 'Up to 60 characters. Leave empty to use the default name.'}</p>
    <fieldset className="profile-avatar-options"><legend>{zh ? '头像' : 'Avatar'}</legend>
      <label><input type="radio" name="local-profile-avatar" checked={profile.avatarStyle === 'initial'} onChange={() => update({ avatarStyle: 'initial' })} />{zh ? '显示名首字' : 'Display name initial'}</label>
      <label><input type="radio" name="local-profile-avatar" checked={profile.avatarStyle === 'emoji'} onChange={() => update({ avatarStyle: 'emoji' })} />{zh ? '内置图标' : 'Built-in icon'}</label>
      {profile.avatarStyle === 'emoji' && <div className="profile-emoji-list" role="group" aria-label={zh ? '选择头像图标' : 'Choose an avatar icon'}>{LOCAL_PROFILE_EMOJIS.map(emoji => <button type="button" key={emoji} className="profile-emoji" aria-label={emoji} aria-pressed={profile.emoji === emoji} onClick={() => update({ emoji })}>{emoji}</button>)}</div>}
    </fieldset>
    <div className="personalization-actions"><button type="button" className="btn btn-ghost" onClick={() => update({ displayName: '', avatarStyle: 'initial', emoji: '🌱' })}>{zh ? '恢复默认资料' : 'Reset local profile'}</button></div>
    <p className="settings-hint">{zh ? '此版本支持首字和内置图标。更改后保存设置，侧栏即会更新。' : 'This version supports initials and built-in icons. Save settings to update the sidebar.'}</p>
  </section>
}
