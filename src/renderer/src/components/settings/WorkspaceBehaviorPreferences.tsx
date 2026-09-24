import { useEffect, useState } from 'react'
import type { AppSettings } from '../../../../shared/types'
import { normalizeWorkspaceBehavior, type ExternalEditorChoice, type ExternalEditorId } from '../../../../shared/workspace-behavior-types'
import { PreferenceRow } from './DesktopPreferences'

export default function WorkspaceBehaviorPreferences({ draft, onChange }: { draft: AppSettings; onChange(patch: Partial<AppSettings>): void }): React.JSX.Element {
  const config = normalizeWorkspaceBehavior(draft.workspaceBehavior), zh = draft.language === 'zh'
  const [choices, setChoices] = useState<ExternalEditorChoice[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { let active = true; void window.agentDesk.listExternalEditors().then(value => { if (active) setChoices(value) }).catch(cause => { if (active) setError(String(cause)) }); return () => { active = false } }, [])
  const choose = async (): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try { const path = await window.agentDesk.chooseExternalEditor(); if (path) onChange({ workspaceBehavior: { ...config, externalEditor: 'custom', customEditorPath: path } }) }
    catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }
  return <section data-workspace-behavior>
    <h3>{zh ? '文件工作区' : 'File workspace'}</h3>
    <div className="desktop-preference-card">
      <PreferenceRow title={zh ? '文件标签位置' : 'File tabs position'}><select className="select" value={config.fileTabsPosition} aria-label={zh ? '文件标签位置' : 'File tabs position'} onChange={event => onChange({ workspaceBehavior: { ...config, fileTabsPosition: event.target.value as 'top' | 'bottom' } })}><option value="top">{zh ? '顶部' : 'Top'}</option><option value="bottom">{zh ? '底部' : 'Bottom'}</option></select></PreferenceRow>
      <PreferenceRow title={zh ? '外部编辑器' : 'External editor'}><select className="select" aria-label={zh ? '外部编辑器' : 'External editor'} value={config.externalEditor} onChange={event => onChange({ workspaceBehavior: { ...config, externalEditor: event.target.value as ExternalEditorId } })}>
        {!choices.length && <option value={config.externalEditor}>{zh ? '正在读取…' : 'Loading…'}</option>}
        {choices.map(choice => <option key={choice.id} value={choice.id} disabled={!choice.available}>{choice.name}{choice.available ? '' : zh ? '（未找到）' : ' (not found)'}</option>)}
        {choices.length > 0 && <option value="custom">{zh ? '选择本机应用' : 'Choose local application'}</option>}
      </select></PreferenceRow>
      {config.externalEditor === 'custom' && <PreferenceRow title={zh ? '编辑器程序' : 'Editor application'}><button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void choose()}>{zh ? '选择应用…' : 'Choose application…'}</button>{config.customEditorPath && <small title={config.customEditorPath} style={{ maxWidth: 260, overflowWrap: 'anywhere' }}>{config.customEditorPath}</small>}</PreferenceRow>}
    </div>
    <p className="settings-hint">{zh ? '在文件面板点击“外部编辑器”，打开磁盘上的已保存版本。先保存当前修改，再到编辑器继续工作。' : 'Use “External editor” in the file panel to open the saved version on disk. Save your changes before continuing in the editor.'}</p>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
  </section>
}
