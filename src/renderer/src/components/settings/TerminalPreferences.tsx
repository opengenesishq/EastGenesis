import type { AppSettings } from '../../../../shared/types'
import { DEFAULT_TERMINAL_PREFERENCES, normalizeTerminalPreferences } from '../../../../shared/desktop-behavior-preferences'
import { PreferenceRow } from './DesktopPreferences'
export default function TerminalPreferences({ draft, onChange }: { draft: AppSettings; onChange(patch: Partial<AppSettings>): void }): React.JSX.Element {
  const zh = draft.language === 'zh', config = normalizeTerminalPreferences(draft.terminalPreferences)
  return <><p className="desktop-preference-intro">{zh ? '同时应用于本地和 SSH 终端的显示。不会修改命令、Shell 或远端环境。字体在外观设置中选择。' : 'Display preferences apply to local and SSH terminals. Commands, shells and remote environments are unchanged. Choose a font in Appearance.'}</p><div className="desktop-preference-card">
    <PreferenceRow title={zh ? '字号' : 'Font size'}><input type="range" aria-label={zh ? '终端字号' : 'Terminal font size'} min={8} max={28} step={1} value={config.fontSize} onChange={event => onChange({ terminalPreferences: { ...config, fontSize: Number(event.target.value) } })} /><span>{config.fontSize}px</span></PreferenceRow>
    <PreferenceRow title={zh ? '回看行数' : 'Scrollback lines'}><select className="select" aria-label={zh ? '终端回看行数' : 'Terminal scrollback'} value={config.scrollback} onChange={event => onChange({ terminalPreferences: { ...config, scrollback: Number(event.target.value) } })}>{[100, 1000, 5000, 10000, 50000, 100000].map(value => <option value={value} key={value}>{value.toLocaleString()}</option>)}{![100, 1000, 5000, 10000, 50000, 100000].includes(config.scrollback) && <option value={config.scrollback}>{config.scrollback}</option>}</select></PreferenceRow>
    <PreferenceRow title={zh ? '光标闪烁' : 'Blinking cursor'}><input type="checkbox" aria-label={zh ? '终端光标闪烁' : 'Blinking terminal cursor'} checked={config.cursorBlink} onChange={event => onChange({ terminalPreferences: { ...config, cursorBlink: event.target.checked } })} /></PreferenceRow>
  </div><button className="btn btn-ghost" onClick={() => onChange({ terminalPreferences: { ...DEFAULT_TERMINAL_PREFERENCES } })}>{zh ? '恢复终端显示默认值' : 'Reset terminal display'}</button></>
}
