import { useEffect, useState } from 'react'
import { applyDesktopPersonaPreset, DESKTOP_PERSONA_MAX_LENGTH, DESKTOP_PERSONA_PRESETS } from '../../../../shared/desktop-personalization'
import './desktop-personalization-settings.css'

export default function PersonaPresets({ value, language, onChange }: { value: string; language: 'zh' | 'en'; onChange(value: string): void }): React.JSX.Element {
  const zh = language === 'zh'
  const [presetId, setPresetId] = useState(''), [preview, setPreview] = useState(''), [replaceReviewed, setReplaceReviewed] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  useEffect(() => { setReplaceReviewed(false) }, [value])
  useEffect(() => { setPresetId(''); setPreview(''); setReplaceReviewed(false); setError(''); setNotice('') }, [language])
  const apply = (mode: 'append' | 'replace'): void => {
    try {
      const next = applyDesktopPersonaPreset(value, preview, mode)
      onChange(next); setReplaceReviewed(false); setError(''); setNotice(zh ? '预设已写入下方自定义指令草稿。可以继续编辑，保存后在后续请求中使用。' : 'Preset added to the custom-instruction draft below. Edit it further, then save to use it in later requests.')
    } catch (failure) { setError(zh && failure instanceof Error ? failure.message : 'Instructions are invalid or would exceed 12,000 characters.') }
  }
  return <section className="persona-presets" aria-label={zh ? '个性预设' : 'Personality presets'}>
    <h3>{zh ? '个性预设' : 'Personality presets'}</h3><p className="settings-hint">{zh ? '选择预设后先预览，再追加或明确替换当前指令。预设描述表达方式，不改变任务权限。' : 'Preview a preset before appending it or explicitly replacing your current instructions. Presets describe communication style and do not change task permissions.'}</p>
    <select className="select select-block" aria-label={zh ? '选择个性预设' : 'Choose a personality preset'} value={presetId} onChange={event => {
      const id = event.target.value; setPresetId(id); setPreview(DESKTOP_PERSONA_PRESETS.find(preset => preset.id === id)?.text[language] ?? ''); setReplaceReviewed(false); setError(''); setNotice('')
    }}><option value="">{zh ? '保持当前自定义指令' : 'Keep current custom instructions'}</option>{DESKTOP_PERSONA_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.name[language]}</option>)}</select>
    {presetId && <>
      <label className="field-label" htmlFor="persona-preset-preview">{zh ? '预设内容，可先修改' : 'Preset preview; editable'}</label><textarea id="persona-preset-preview" className="input input-block" rows={5} maxLength={DESKTOP_PERSONA_MAX_LENGTH} value={preview} onChange={event => { setPreview(event.target.value); setReplaceReviewed(false); setError(''); setNotice('') }} />
      {value.trim() && <label className="persona-replace-confirm"><input type="checkbox" checked={replaceReviewed} onChange={event => setReplaceReviewed(event.target.checked)} />{zh ? '我已检查当前指令，允许用这段内容替换。' : 'I reviewed my current instructions and allow replacing them with this text.'}</label>}
      <div className="personalization-actions"><button type="button" className="btn btn-primary" disabled={!preview.trim()} onClick={() => apply('append')}>{zh ? '追加到当前指令' : 'Append to instructions'}</button><button type="button" className="btn btn-secondary" disabled={!preview.trim() || Boolean(value.trim() && !replaceReviewed)} onClick={() => apply('replace')}>{zh ? '替换当前指令' : 'Replace instructions'}</button></div>
    </>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}{notice && <p className="settings-hint" role="status">{notice}</p>}
  </section>
}
