import { useState } from 'react'
import { useStore } from '../../store'
import ExternalBrowserPanel from '../workbench/ExternalBrowserPanel'

export default function BrowserExtensionSettings(): React.JSX.Element {
  const sessionId = useStore(state => state.activeId)
  const zh = useStore(state => state.settings.language === 'zh')
  const [externalMode, setExternalMode] = useState(true), [error, setError] = useState('')
  return <section className="browser-extension-settings">
    <h3>{zh ? 'Chrome / Edge 扩展' : 'Chrome / Edge extension'}</h3>
    <button className="btn btn-ghost btn-sm" onClick={() => void window.agentDesk.openBrowserExtensionDirectory().catch(cause => setError(String(cause)))}>{zh ? '打开本机扩展目录' : 'Open local extension folder'}</button>
    <p className="settings-hint">{zh ? '在浏览器扩展管理中开启开发者模式并加载已解压的扩展。安装会声明 debugger 调试权限；只有明确配对、授权并选择的标签可以被当前任务使用。' : 'Enable Developer mode and load the unpacked extension. Installation declares debugger permission. Only an explicitly paired, authorized and selected tab can be used by the current task.'}</p>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {sessionId ? <ExternalBrowserPanel key={sessionId} sessionId={sessionId} active externalMode={externalMode} onModeChange={setExternalMode} /> : <p className="settings-hint">{zh ? '打开或新建一个任务后，在这里配对、选择标签及撤销连接。' : 'Open or create a task to pair, select a tab or revoke its connection here.'}</p>}
  </section>
}
