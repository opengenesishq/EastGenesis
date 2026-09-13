import type { LayoutSettings, OfficeQualityMode, OfficeSettings } from '../../../../shared/types'
import { useT } from '../../i18n'

export const DEFAULT_OFFICE_SETTINGS: OfficeSettings = {
  qualityMode: 'auto',
  resolutionMode: 'adaptive',
  showBadges: true,
  liveliness: 1,
  catEars: false,
  spaceTheme: 'control-room',
  outfitPalette: 'role-default',
  hairStyle: 'role-default',
  teamLayout: 'grid'
}

const QUALITY_OPTIONS: Array<{ value: OfficeQualityMode; labelKey: string }> = [
  { value: 'auto', labelKey: 'officeQualityAuto' },
  { value: 'high', labelKey: 'officeQualityHigh' },
  { value: 'balanced', labelKey: 'officeQualityBalanced' },
  { value: 'low', labelKey: 'officeQualityLow' }
]

export default function OfficeAppearanceSettings({ layout, office, onLayoutChange, onOfficeChange }: {
  layout: LayoutSettings
  office: OfficeSettings
  onLayoutChange: (patch: Partial<LayoutSettings>) => void
  onOfficeChange: (patch: Partial<OfficeSettings>) => void
}): React.JSX.Element {
  const t = useT()
  return <>
    <div className="settings-section">
      <div className="settings-section-head"><h3 className="settings-h3">{t('layoutSection')}</h3></div>
      <label className="settings-check">
        <input type="checkbox" checked={layout.sidebarCollapsed} onChange={(event) => onLayoutChange({ sidebarCollapsed: event.target.checked })} />
        {t('layoutSidebarCollapsed')}
      </label>
      <div className="settings-grid-2">
        <label className="field-label">空间主题
          <select className="select select-block" value={office.spaceTheme} onChange={(event) => onOfficeChange({ spaceTheme: event.target.value as OfficeSettings['spaceTheme'] })}>
            <option value="control-room">控制室</option><option value="creative-studio">创作工作室</option><option value="quiet-library">安静图书馆</option>
          </select>
        </label>
        <label className="field-label">团队排布
          <select className="select select-block" value={office.teamLayout} onChange={(event) => onOfficeChange({ teamLayout: event.target.value as OfficeSettings['teamLayout'] })}>
            <option value="grid">工作网格</option><option value="team-photo">团队合影</option>
          </select>
        </label>
        <label className="field-label">服装色调
          <select className="select select-block" value={office.outfitPalette} onChange={(event) => onOfficeChange({ outfitPalette: event.target.value as OfficeSettings['outfitPalette'] })}>
            <option value="role-default">岗位默认</option><option value="graphite">石墨</option><option value="teal">青绿</option><option value="rose">绛红</option>
          </select>
        </label>
        <label className="field-label">发型轮廓
          <select className="select select-block" value={office.hairStyle} onChange={(event) => onOfficeChange({ hairStyle: event.target.value as OfficeSettings['hairStyle'] })}>
            <option value="role-default">岗位默认</option><option value="short">短发</option><option value="long">长发</option><option value="tied">束发</option>
          </select>
        </label>
      </div>
      <div className="settings-grid-2">
        <label className="field-label">
          {t('layoutSidebarWidth')} · {layout.sidebarWidth}px
          <input type="range" className="input-block" min={220} max={420} step={4} value={layout.sidebarWidth} onChange={(event) => onLayoutChange({ sidebarWidth: Number(event.target.value) })} />
        </label>
        <label className="field-label">
          {t('layoutToolPanelWidth')} · {layout.workbenchSideWidth}px
          <input type="range" className="input-block" min={320} max={720} step={8} value={layout.workbenchSideWidth} onChange={(event) => onLayoutChange({ workbenchSideWidth: Number(event.target.value) })} />
        </label>
      </div>
      <div className="settings-grid-2">
        <label className="field-label">
          {t('layoutTerminalDockHeight')} · {layout.workbenchDockHeight}px
          <input type="range" className="input-block" min={220} max={520} step={8} value={layout.workbenchDockHeight} onChange={(event) => onLayoutChange({ workbenchDockHeight: Number(event.target.value) })} />
        </label>
        <label className="field-label">
          {t('layoutChatScale')} · {Math.round(layout.chatScale * 100)}%
          <input type="range" className="input-block" min={0.85} max={1.25} step={0.05} value={layout.chatScale} onChange={(event) => onLayoutChange({ chatScale: Number(event.target.value) })} />
        </label>
        <label className="field-label">
          {t('layoutChatDensity')}
          <select className="select select-block" value={layout.chatDensity} onChange={(event) => onLayoutChange({ chatDensity: event.target.value as LayoutSettings['chatDensity'] })}>
            <option value="comfortable">{t('chatDensityComfortable')}</option>
            <option value="compact">{t('chatDensityCompact')}</option>
          </select>
        </label>
      </div>
    </div>
    <div className="settings-section">
      <div className="settings-section-head"><h3 className="settings-h3">{t('officeTitle')}</h3></div>
      <div className="office-quality-control">
        <div className="field-label">{t('officeQualityMode')}</div>
        <div className="office-quality-options" role="group" aria-label={t('officeQualityMode')}>
          {QUALITY_OPTIONS.map((option) => <button key={option.value} type="button" className={`office-quality-option ${office.qualityMode === option.value ? 'active' : ''}`} aria-pressed={office.qualityMode === option.value} data-office-quality-option={option.value} onClick={() => onOfficeChange({ qualityMode: option.value })}>{t(option.labelKey)}</button>)}
        </div>
      </div>
      <label className="field-label">画面清晰度
        <select className="select select-block" data-office-resolution-mode value={office.resolutionMode ?? 'sharp'}
          onChange={(event) => onOfficeChange({ resolutionMode: event.target.value as 'sharp' | 'adaptive' })}>
          <option value="sharp">高清优先 · 保持屏幕像素密度</option>
          <option value="adaptive">流畅优先 · 允许降低分辨率</option>
        </select>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={office.showBadges} onChange={(event) => onOfficeChange({ showBadges: event.target.checked })} />
        {t('officeShowBadges')}
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={office.catEars} onChange={(event) => onOfficeChange({ catEars: event.target.checked })} />
        {t('officeCatEars')}
      </label>
      <label className="field-label">{t('officeLiveliness')} · {office.liveliness.toFixed(1)}×</label>
      <input type="range" className="input-block" min={0.2} max={1.2} step={0.1} value={office.liveliness} onChange={(event) => onOfficeChange({ liveliness: Number(event.target.value) })} />
    </div>
  </>
}
