import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import type { LocalRuntimeStatus } from '../../../../shared/local-runtime-types'

export default function LocalRuntimeSettings(): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const [status, setStatus] = useState<LocalRuntimeStatus>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const refresh = async (): Promise<void> => {
    setBusy(true); setError('')
    try { setStatus(await window.agentDesk.inspectLocalRuntimes()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  useEffect(() => { void refresh() }, [])
  const links = { node: 'https://nodejs.org/en/download', python: 'https://www.python.org/downloads/', git: 'https://git-scm.com/downloads' }
  return <section className="settings-runtime-status" data-local-runtime-settings>
    <h3>{zh ? '本机运行环境' : 'Local runtimes'}</h3>
    <p className="settings-hint">{zh ? 'Word、Excel、PowerPoint 和 PDF 制作使用应用内置工具。运行自定义分析脚本、开发网站或使用 Git 时，使用下面检测到的本机程序。' : 'Built-in tools create Word, Excel, PowerPoint and PDF files. Custom analysis scripts, website development and Git use the local programs below.'}</p>
    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void refresh()}>{busy ? (zh ? '检测中…' : 'Checking…') : (zh ? '重新检测' : 'Check again')}</button>
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {status && <>
      <p role="status">{zh ? '内置文档工具' : 'Built-in document tools'} · {status.bundledDocuments ? (zh ? '可用' : 'Available') : (zh ? '组件不完整，请重新安装 EastGenesis' : 'Missing components; reinstall EastGenesis')}</p>
      <div className="settings-runtime-list">{status.runtimes.map(runtime => <article key={runtime.id}>
        <div><strong>{runtime.name}</strong><span>{runtime.available ? runtime.version : (zh ? '未就绪' : 'Not ready')}</span></div>
        {runtime.executable && <code>{runtime.executable}</code>}
        {!runtime.available && <><p className="settings-hint">{runtime.error === 'timeout' ? (zh ? '版本检测超时，请确认程序能在终端启动。' : 'Version check timed out. Check the program in a terminal.') : runtime.error === 'probe_failed' ? (zh ? '找到了程序，但启动失败。' : 'The program was found but did not start.') : (zh ? '当前执行环境未找到该程序。安装完成后重新启动 EastGenesis。' : 'Not found in the current execution environment. Restart EastGenesis after installation.')}</p><a className="btn btn-ghost btn-sm" href={links[runtime.id]} target="_blank" rel="noreferrer">{zh ? '打开官方安装页' : 'Open official downloads'}</a></>}
      </article>)}</div>
      <p className="settings-hint">{zh ? 'Python 标准库可处理 CSV、JSON 和统计计算；需要 pandas、matplotlib 等库时，可在具体任务中创建独立环境并安装。交互 HTML 可从文件面板的“网站”入口在浏览器中运行。' : 'Python’s standard library handles CSV, JSON and statistics. A task can create its own environment for pandas or matplotlib when needed. Run interactive HTML in the browser using Sites in the Files panel.'}</p>
    </>}
  </section>
}
