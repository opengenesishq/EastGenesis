import { useEffect, useMemo, useState } from 'react'
import type { AppSettings } from '../../../../shared/types'
import { DESKTOP_SHORTCUTS, formatShortcut, normalizeDesktopShortcuts, normalizeShortcut, shortcutConflicts, shortcutFromEvent, shortcutFor, type DesktopShortcutAction } from '../../../../shared/desktop-shortcuts'
import { CODE_FONT_CHOICES, DEFAULT_DESKTOP_FONTS, INTERFACE_FONT_CHOICES, desktopFontStack } from '../../../../shared/desktop-fonts'

function platform(): 'darwin' | 'other' { return /Mac|iPhone|iPad/.test(navigator.platform) ? 'darwin' : 'other' }

export default function DesktopShortcutSettings({ value, onChange, language }: {
  value: AppSettings['desktopShortcuts']; onChange(value: NonNullable<AppSettings['desktopShortcuts']>): void; language: AppSettings['language']
}): React.JSX.Element {
  const zh = language === 'zh', [capturing, setCapturing] = useState<DesktopShortcutAction | null>(null)
  const [captureError, setCaptureError] = useState('')
  const [search, setSearch] = useState('')
  useEffect(() => {
    if (!capturing) return
    let mounted = true
    void window.agentDesk.setDesktopShortcutCapture(true).catch(() => {
      if (mounted) { setCaptureError(zh ? '无法开始录制，请重试。' : 'Could not start shortcut recording.'); setCapturing(null) }
    })
    const end = (): void => setCapturing(null)
    window.addEventListener('blur', end)
    return () => { mounted = false; window.removeEventListener('blur', end); void window.agentDesk.setDesktopShortcutCapture(false).catch(() => {}) }
  }, [capturing, zh])
  const settings = normalizeDesktopShortcuts(value)
  const conflicts = useMemo(() => shortcutConflicts(settings), [settings])
  const capture = (event: React.KeyboardEvent, action: DesktopShortcutAction): void => {
    event.preventDefault(); event.stopPropagation()
    if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      onChange({ ...settings, [action]: null }); setCapturing(null); return
    }
    const next = shortcutFromEvent({ key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing }, platform())
    if (!next) return
    if (normalizeShortcut(next, action) === undefined) { setCaptureError(zh ? '请使用带 Ctrl / ⌘ / Alt 的组合键或功能键。' : 'Use Ctrl / Cmd / Alt with a key, or a function key.'); return }
    const nextSettings = { ...settings, [action]: next }
    const conflict = shortcutConflicts(nextSettings).find(conflict => conflict.actions.includes(action))
    if (conflict) { setCaptureError(zh ? '此组合键已被其他动作或系统占用，请换一个。' : 'This combination is reserved or used by another action.'); return }
    onChange(nextSettings); setCapturing(null); setCaptureError('')
  }
  const grouped = ['navigation', 'workbench', 'input'] as const
  const groupLabels = { navigation: '导航 Navigation', workbench: '工作区 Workbench', input: '输入 Input' }
  const query = search.trim().toLocaleLowerCase()
  const visibleShortcuts = DESKTOP_SHORTCUTS.filter(item => !query || `${item.zh} ${item.en} ${item.id} ${groupLabels[item.group]} ${formatShortcut(shortcutFor(item.id, settings), platform())} ${shortcutFor(item.id, settings) ?? '已禁用 disabled'}`.toLocaleLowerCase().includes(query))
  return <section className="desktop-shortcut-settings" data-desktop-shortcuts>
    <p className="settings-hint">{zh ? '点击快捷键后按下新组合键。按 Esc 清空。冲突快捷键不会保存。' : 'Click a shortcut and press a new combination. Press Esc to clear. Conflicting shortcuts are not saved.'}</p>
    <input className="input input-block" type="search" value={search} aria-label={zh ? '搜索快捷键' : 'Search shortcuts'} placeholder={zh ? '搜索命令、分组或组合键…' : 'Search commands, groups, or key combinations…'} onChange={event => { setSearch(event.target.value); setCapturing(null); setCaptureError('') }} />
    <p className="settings-hint" role="status">{zh ? `${visibleShortcuts.length} / ${DESKTOP_SHORTCUTS.length} 个快捷键` : `${visibleShortcuts.length} / ${DESKTOP_SHORTCUTS.length} shortcuts`}</p>
    {captureError && <p className="notice notice-error" role="alert">{captureError}</p>}
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => { onChange({}); setCaptureError(''); setCapturing(null) }}>{zh ? '恢复全部默认快捷键' : 'Restore default shortcuts'}</button>
    {!visibleShortcuts.length && <p className="settings-hint">{zh ? '没有匹配的快捷键。请尝试其他命令或组合键。' : 'No matching shortcuts. Try another command or key combination.'}</p>}
    {grouped.filter(group => visibleShortcuts.some(item => item.group === group)).map(group => <div className="desktop-shortcut-group" key={group}>
      <h4>{zh ? ({ navigation: '导航', workbench: '工作区', input: '输入' }[group]) : ({ navigation: 'Navigation', workbench: 'Workbench', input: 'Input' }[group])}</h4>
      {visibleShortcuts.filter(item => item.group === group).map(item => {
        const conflict = conflicts.find(value => value.actions.includes(item.id))
        return <div className={`desktop-shortcut-row${conflict ? ' has-conflict' : ''}`} key={item.id}>
          <span>{zh ? item.zh : item.en}</span>
          <button type="button" data-shortcut-capture={item.id} aria-label={zh ? `${item.zh}快捷键` : `${item.en} shortcut`} onClick={() => { setCapturing(item.id); setCaptureError('') }} onBlur={() => setCapturing(null)} onKeyDown={event => capturing === item.id && capture(event, item.id)}>
            {capturing === item.id ? (zh ? '请按键…' : 'Press keys…') : formatShortcut(shortcutFor(item.id, settings), platform())}
          </button>
          {conflict && <small role="alert">{zh ? `与${conflict.actions.filter(id => id !== item.id).map(id => DESKTOP_SHORTCUTS.find(item => item.id === id)?.zh).join('、') || '系统快捷键'}冲突` : 'Shortcut conflict'}</small>}
        </div>
      })}
    </div>)}
  </section>
}

export function DesktopFontSettings({ value, onChange, language }: {
  value: AppSettings['desktopFonts']; onChange(value: NonNullable<AppSettings['desktopFonts']>): void; language: AppSettings['language']
}): React.JSX.Element {
  const zh = language === 'zh', fonts = value ?? DEFAULT_DESKTOP_FONTS
  return <div className="desktop-font-settings" data-desktop-fonts>
    <FontField label={zh ? '界面字体' : 'Interface font'} value={fonts.interfaceFamily} choices={INTERFACE_FONT_CHOICES} zh={zh} onChange={interfaceFamily => onChange({ ...fonts, interfaceFamily })} />
    <FontField label={zh ? '代码与终端字体' : 'Code and terminal font'} value={fonts.codeFamily} choices={CODE_FONT_CHOICES} zh={zh} onChange={codeFamily => onChange({ ...fonts, codeFamily })} />
    <span className="desktop-font-preview" style={{ fontFamily: desktopFontStack(fonts.interfaceFamily) }}>{zh ? '字体预览 · EastGenesis 工作台' : 'Font preview · EastGenesis workspace'}</span>
    <code className="desktop-font-preview" style={{ fontFamily: desktopFontStack(fonts.codeFamily, true) }}>const result = 123;</code>
    <p className="settings-hint">{zh ? '未安装的字体会使用系统替代字体。可填写其他本机字体名称；不下载远程字体。' : 'Missing fonts fall back to system fonts. Enter another local family name if needed; no fonts are downloaded.'}</p>
  </div>
}

function FontField({ label, value, choices, zh, onChange }: { label: string; value: string; choices: readonly string[]; zh: boolean; onChange(value: string): void }): React.JSX.Element {
  const [custom, setCustom] = useState(!choices.includes(value))
  return <label className="field-label">{label}<select className="select select-block" value={custom ? '__custom' : value} onChange={event => {
    const next = event.target.value
    setCustom(next === '__custom')
    if (next !== '__custom') onChange(next)
  }}>
    {choices.map(value => <option key={value} value={value}>{value === 'system' ? (zh ? '系统默认' : 'System default') : value}</option>)}
    <option value="__custom">{zh ? '其他本机字体…' : 'Other local font…'}</option>
  </select>
    {custom && <input className="input input-block" aria-label={label} maxLength={100} value={value === 'system' ? '' : value} placeholder={zh ? '本机字体名称' : 'Local font family'}
      onChange={event => { if (/^[\p{L}\p{N} ._-]*$/u.test(event.target.value)) onChange(event.target.value) }} />}
  </label>
}
