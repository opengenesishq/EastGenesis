import { useEffect, useState } from 'react'
import type { QuickbarState } from '../../../../shared/types'
import { normalizeQuickbarSettings, type QuickbarSettings as Settings } from '../../../../shared/quickbar-settings'
import { PreferenceRow } from './DesktopPreferences'

export default function QuickbarSettings({ value, zh, onChange }: {
  value?: Settings; zh: boolean; onChange(value: Settings): void
}): React.JSX.Element {
  const config = normalizeQuickbarSettings(value)
  const [state, setState] = useState<QuickbarState>()
  const [error, setError] = useState('')
  const refresh = (): void => {
    setError('')
    void window.agentDesk.quickbarGetState().then(setState).catch(cause => setError(String(cause)))
  }
  useEffect(refresh, [])
  const permissionLabels = {
    granted: zh ? '已允许' : 'Allowed',
    denied: zh ? '未允许' : 'Not allowed',
    restricted: zh ? '受系统限制' : 'Restricted by the system',
    'not-determined': zh ? '尚未授权' : 'Not yet authorized',
    unknown: zh ? '状态不可用' : 'Status unavailable'
  }
  return <>
    <p className="desktop-preference-intro">{zh ? '快捷输入把文字、剪贴板、文件和所选窗口截图加入任务草稿。检查内容后，在任务中点击发送。' : 'Quick input adds text, clipboard content, files, or a selected window screenshot to a task draft. Review it before sending from the task.'}</p>
    <div className="desktop-preference-card" data-quickbar-settings>
      <PreferenceRow title={zh ? '默认目标' : 'Default destination'} description={zh ? '自动：打开时有当前任务就选中它，否则新建。打开后目标保持固定。' : 'Automatic selects the current task when opened, or a new task when none is selected. The selected destination then stays fixed.'}>
        <select className="select" aria-label={zh ? '默认目标' : 'Default destination'} value={config.defaultTarget} onChange={event => onChange({ ...config, defaultTarget: event.target.value as Settings['defaultTarget'] })}>
          <option value="auto">{zh ? '自动' : 'Automatic'}</option><option value="current">{zh ? '当前任务' : 'Current task'}</option><option value="new">{zh ? '新建任务' : 'New task'}</option>
        </select>
      </PreferenceRow>
      <PreferenceRow title={zh ? '附加截图中的文字' : 'Include text from screenshots'} description={zh ? '使用本机 OCR 识别所选截图，不读取其他窗口的可访问文本。可在每次截图前调整。' : 'Use local OCR on the selected screenshot. Other windows are not read. You can change this before each capture.'}>
        <button type="button" className="desktop-preference-toggle" role="switch" aria-label={zh ? '附加截图中的文字' : 'Include text from screenshots'} aria-checked={config.includeOcr} onClick={() => onChange({ ...config, includeOcr: !config.includeOcr })}><span /></button>
      </PreferenceRow>
      <PreferenceRow title={zh ? '快捷输入快捷键' : 'Quick input shortcut'} description={state?.registrationError ?? (state?.registered ? (zh ? '已注册全局快捷键' : 'Global shortcut registered') : (zh ? '快捷键尚不可用' : 'Shortcut is unavailable'))}>
        <kbd>{state?.accelerator ?? '…'}</kbd>
      </PreferenceRow>
      <PreferenceRow title={zh ? '屏幕录制权限' : 'Screen capture permission'} description={state?.platform === 'darwin'
        ? (zh ? '在 macOS 系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许 EastGenesis；必要时重新启动应用。' : 'Allow EastGenesis in macOS System Settings → Privacy & Security → Screen & System Audio Recording. Restart the app if required.')
        : (zh ? '窗口与屏幕是否可用由系统决定。截图失败会显示实际错误。' : 'Your operating system controls window and screen availability. Capture failures show the actual error.')}>
        <span>{state?.screenCapturePermission ? permissionLabels[state.screenCapturePermission] : (zh ? '由系统管理' : 'Managed by the system')}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={refresh}>{zh ? '刷新状态' : 'Refresh status'}</button>
      </PreferenceRow>
    </div>
    {error && <div className="notice notice-error" role="alert">{error}</div>}
    <p className="settings-hint">{zh ? '每次截图都需要选择一个明确的窗口或屏幕。窗口关闭或来源变化时会停止，不能自动换截其他窗口。' : 'Choose a window or screen before each capture. If it closes or changes, capture stops instead of selecting another source.'}</p>
  </>
}
