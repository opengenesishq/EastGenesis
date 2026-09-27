import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { DEFAULT_DESKTOP_PALETTES, DESKTOP_THEME_JSON_MAX_LENGTH, desktopThemeTokens, normalizeDesktopPersonalization, normalizeDesktopThemeColors, parseDesktopThemeJson, serializeDesktopThemeJson,
  type DesktopColorMode, type DesktopPaletteOverrides, type DesktopPersonalizationSettings, type DesktopThemeColors } from '../../../../shared/desktop-personalization'
import { previewDesktopTheme } from '../../theme'
import './desktop-personalization-settings.css'

export default function DesktopThemeSettings({ value, language, onChange }: {
  value?: DesktopPersonalizationSettings; language: 'zh' | 'en'; onChange(value: DesktopPersonalizationSettings): void
}): React.JSX.Element {
  const zh = language === 'zh', saved = normalizeDesktopPersonalization(value)
  const [mode, setMode] = useState<DesktopColorMode>('light'), [colors, setColors] = useState<DesktopThemeColors>(() => saved.colors)
  const [preview, setPreview] = useState(false), [json, setJson] = useState(''), [showJson, setShowJson] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const picker = useRef<HTMLInputElement>(null), mounted = useRef(true), importRevision = useRef(0)
  const savedKey = JSON.stringify(saved.colors)
  useEffect(() => { setColors(JSON.parse(savedKey) as DesktopThemeColors) }, [savedKey])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; importRevision.current++ } }, [])
  let validation = ''
  try { normalizeDesktopThemeColors(colors) } catch (failure) { validation = zh && failure instanceof Error ? failure.message : 'Increase the contrast between the background, text, and accent colors.' }
  useEffect(() => {
    if (!preview || validation) return
    return previewDesktopTheme(mode, colors)
  }, [preview, mode, colors, validation])
  const edit = (key: keyof DesktopPaletteOverrides, next?: string): void => {
    importRevision.current++; setError(''); setNotice('')
    setColors(current => { const palette = { ...current[mode] }; if (next) palette[key] = next; else delete palette[key]; return { ...current, [mode]: palette } })
  }
  const apply = (next: DesktopThemeColors): void => {
    try { const validated = normalizeDesktopThemeColors(next); onChange({ ...saved, colors: validated }); setColors(validated); setError(''); setNotice(zh ? '配色已加入设置草稿；保存设置后持续生效。' : 'Colors added to the settings draft. Save settings to keep them.') }
    catch (failure) { setError(zh && failure instanceof Error ? failure.message : 'Theme colors are invalid or have insufficient contrast.') }
  }
  const importJson = (text: string): void => {
    try { const next = parseDesktopThemeJson(text); setColors(next); setError(''); setNotice(zh ? '已读取主题。检查两种模式的预览，再应用到设置草稿。' : 'Theme loaded. Review both modes, then apply it to the settings draft.') }
    catch (failure) { setError(zh && failure instanceof Error ? failure.message : 'This theme JSON is invalid, unsupported, or has insufficient contrast.') }
  }
  const exportJson = (): string | undefined => {
    try { const text = serializeDesktopThemeJson(colors); setJson(text); setShowJson(true); setError(''); return text }
    catch (failure) { setError(zh && failure instanceof Error ? failure.message : 'Choose readable colors before exporting.'); return undefined }
  }
  const download = (): void => {
    const text = exportJson(); if (!text) return
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })), anchor = document.createElement('a')
    anchor.href = url; anchor.download = 'eastgenesis-theme.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }
  const resolved = { ...DEFAULT_DESKTOP_PALETTES[mode], ...colors[mode] }
  const tokens = desktopThemeTokens(mode, colors[mode])
  return <section className="desktop-theme-settings" aria-label={zh ? '自定义主题' : 'Custom theme'}>
    <div className="personalization-section-heading"><h3>{zh ? '自定义配色' : 'Custom colors'}</h3><select className="select" aria-label={zh ? '编辑配色模式' : 'Color mode to edit'} value={mode} onChange={event => { importRevision.current++; setMode(event.target.value as DesktopColorMode) }}><option value="light">{zh ? '浅色' : 'Light'}</option><option value="dark">{zh ? '深色' : 'Dark'}</option></select></div>
    <p className="settings-hint">{zh ? '浅色与深色分别继承各自默认配色。跟随系统时会自动使用对应方案。' : 'Light and dark modes inherit their own default palettes. System mode uses the matching palette automatically.'}</p>
    <div className="theme-color-grid">{(['accent', 'background', 'foreground'] as const).map(key => <div className="theme-color-row" key={`${mode}-${key}`}>
      <label htmlFor={`desktop-theme-${mode}-${key}`}>{({ accent: zh ? '强调色' : 'Accent', background: zh ? '背景色' : 'Background', foreground: zh ? '文字色' : 'Text' })[key]}</label>
      <input id={`desktop-theme-${mode}-${key}`} type="color" value={resolved[key]} onChange={event => edit(key, event.target.value)} /><code>{resolved[key]}</code>
      <button type="button" className="btn btn-ghost btn-sm" disabled={!colors[mode][key]} onClick={() => edit(key)}>{colors[mode][key] ? (zh ? '恢复默认' : 'Reset') : (zh ? '继承默认' : 'Inherited')}</button>
    </div>)}</div>
    <div className="theme-palette-preview" style={tokens as CSSProperties} aria-label={zh ? '配色示例' : 'Color preview'}><aside><span>● ● ●</span><strong>{zh ? '项目与任务' : 'Projects & tasks'}</strong><p>{zh ? '本周报告' : 'Weekly report'}</p></aside><article><h4>{zh ? '开始一项工作' : 'Start a task'}</h4><p>{zh ? '整理资料，准备客户汇报。' : 'Organize research and prepare a client report.'}</p><code>{zh ? '文件 · 代码 · 进度' : 'Files · Code · Progress'}</code><button type="button" tabIndex={-1}>{zh ? '继续工作' : 'Continue'}</button></article></div>
    {validation && <p className="notice notice-error" role="alert">{validation}</p>}
    <div className="personalization-actions"><button type="button" className="btn btn-secondary" disabled={Boolean(validation) && !preview} aria-pressed={preview && !validation} onClick={() => setPreview(current => !current)}>{preview ? (zh ? '结束窗口预览' : 'End window preview') : (zh ? '在当前窗口预览' : 'Preview in this window')}</button>
      <button type="button" className="btn btn-primary" disabled={Boolean(validation)} onClick={() => apply(colors)}>{zh ? '应用配色到设置草稿' : 'Apply colors to draft'}</button>
      <button type="button" className="btn btn-ghost" onClick={() => { importRevision.current++; const next = { ...colors, [mode]: {} }; setColors(next); apply(next) }}>{zh ? '清除当前模式自定义' : 'Reset current mode'}</button>
      <button type="button" className="btn btn-ghost" onClick={() => { importRevision.current++; const next = { light: {}, dark: {} }; setColors(next); apply(next) }}>{zh ? '恢复全部默认配色' : 'Reset both modes'}</button></div>
    {preview && !validation && <p className="settings-hint" role="status">{zh ? '正在临时预览；离开此页即恢复已保存主题。' : 'Temporary preview. Leaving this page restores the saved theme.'}</p>}
    <details className="theme-sharing" open={showJson} onToggle={event => setShowJson(event.currentTarget.open)}><summary>{zh ? '导入与分享主题 JSON' : 'Import and share theme JSON'}</summary>
      <p className="settings-hint">{zh ? '主题只包含颜色。个人资料、自定义指令和连接配置不会导出。' : 'Themes contain colors only. Profile details, instructions and connection settings are excluded.'}</p>
      <textarea className="input input-block" rows={8} aria-label={zh ? '主题 JSON' : 'Theme JSON'} maxLength={DESKTOP_THEME_JSON_MAX_LENGTH} value={json} onChange={event => { importRevision.current++; setJson(event.target.value); setError('') }} placeholder={zh ? '粘贴 EastGenesis 主题 JSON（v1）' : 'Paste EastGenesis theme JSON (v1)'} />
      <input hidden ref={picker} type="file" accept=".json,application/json" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
        const revision = ++importRevision.current
        if (file.size > DESKTOP_THEME_JSON_MAX_LENGTH) { setError(zh ? '主题 JSON 不得超过 8 KB。' : 'Theme JSON must not exceed 8 KB.'); return }
        void file.text().then(text => { if (mounted.current && importRevision.current === revision) { setJson(text); importJson(text) } }).catch(() => { if (mounted.current && importRevision.current === revision) setError(zh ? '无法读取该主题文件。' : 'Could not read that theme file.') })
      }} />
      <div className="personalization-actions"><button type="button" className="btn btn-secondary" disabled={!json.trim()} onClick={() => { importRevision.current++; importJson(json) }}>{zh ? '读取 JSON' : 'Load JSON'}</button><button type="button" className="btn btn-ghost" onClick={() => picker.current?.click()}>{zh ? '选择 JSON 文件' : 'Choose JSON file'}</button>
        <button type="button" className="btn btn-ghost" disabled={Boolean(validation)} onClick={() => { void (async () => { const text = exportJson(); if (!text) return; try { await navigator.clipboard.writeText(text); if (mounted.current) setNotice(zh ? '主题 JSON 已复制。' : 'Theme JSON copied.') } catch { if (mounted.current) setNotice(zh ? '请从上方文本框手动复制主题 JSON。' : 'Copy the theme JSON from the text box above.') } })() }}>{zh ? '复制 JSON' : 'Copy JSON'}</button>
        <button type="button" className="btn btn-ghost" disabled={Boolean(validation)} onClick={download}>{zh ? '导出 JSON 文件' : 'Export JSON file'}</button></div>
    </details>
    {error && <p className="notice notice-error" role="alert">{error}</p>}{notice && <p className="settings-hint" role="status">{notice}</p>}
  </section>
}
