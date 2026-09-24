import { useState } from 'react'
import { useStore } from '../../store'

export default function BrowserDebugSettings(): React.JSX.Element {
  const enabled = useStore(state => state.settings.browserDebug?.enabled === true)
  const zh = useStore(state => state.settings.language === 'zh')
  const updateSettings = useStore(state => state.updateSettings)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  return <section className="browser-debug-settings">
    <h3>{zh ? '高级浏览器调试' : 'Advanced browser debugging'}</h3>
    <label className="browser-management-check"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => {
      setBusy(true); setError('')
      void updateSettings({ browserDebug: { enabled: event.target.checked } }).catch(failure => setError(String(failure instanceof Error ? failure.message : failure))).finally(() => setBusy(false))
    }} />{zh ? '启用高级调试入口（默认关闭）' : 'Enable advanced debugging (off by default)'}</label>
    <p className="settings-hint">{zh ? '仅支持内置浏览器。开启后仍需在当前标签的调试面板单独授权，五分钟后失效；切页、导航或关闭面板会撤销。允许控制台、网络元数据和性能快照；主框架脚本每次仍需审批。关闭此设置立即撤销全部调试授权。' : 'Embedded browser only. Each tab requires an explicit five-minute grant. Tab changes, navigation, or closing the panel revoke it. Console, network metadata, and performance snapshots are available; main-frame scripts still require approval each time. Disabling this setting revokes all grants.'}</p>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
  </section>
}
