import { useEffect, useState } from 'react'
import type { AppSettings } from '../../../../shared/types'
import { normalizeWslPreferences, type WslStatus } from '../../../../shared/wsl-types'
export default function WslSettings({ draft, onChange }: { draft: AppSettings; onChange(patch: Partial<AppSettings>): void }): React.JSX.Element {
  const [status, setStatus] = useState<WslStatus>(), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const config = normalizeWslPreferences(draft.wsl), zh = draft.language === 'zh'
  const refresh = async (): Promise<void> => {
    setBusy(true); setMessage('')
    try { setStatus(await window.agentDesk.inspectWsl()) } catch (error) { setMessage(String(error)) } finally { setBusy(false) }
  }
  useEffect(() => { void refresh() }, [])
  const validate = async (): Promise<void> => {
    if (!config.distribution) return
    const cwd = await window.agentDesk.pickDirectory(); if (!cwd) return
    setBusy(true)
    try {
      const binding = await window.agentDesk.validateWslDirectory({ distribution: config.distribution, cwd })
      setMessage(`${zh ? '目录已核对，可作为项目文件夹：' : 'Verified project directory:'} ${binding.hostCwd} → ${binding.guestCwd}`)
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  return <section className="settings-runtime-status" data-wsl-settings>
    <h3>{zh ? 'Windows / WSL2 执行环境' : 'Windows / WSL2 execution environment'}</h3>
    <p className="settings-hint">{zh ? '新任务可以使用指定的 WSL2 发行版。已有任务保留原环境；模型与厂商选择独立于执行环境。' : 'Choose WSL2 for new tasks. Existing tasks keep their environment; models and providers are selected separately.'}</p>
    <label className="field-label">{zh ? '新任务默认环境' : 'Default for new tasks'}
      <select className="select" value={config.mode} disabled={busy} onChange={event => onChange({ wsl: { ...config, mode: event.target.value as 'host' | 'wsl' } })}>
        <option value="host">{status?.platform === 'win32' ? (zh ? 'Windows 宿主机' : 'Windows host') : (zh ? '本机' : 'This computer')}</option><option value="wsl" disabled={status?.platform !== 'win32'}>WSL2</option>
      </select>
    </label>
    {config.mode === 'wsl' && <label className="field-label">{zh ? '发行版' : 'Distribution'}
      <select className="select" value={config.distribution ?? ''} disabled={busy} onChange={event => onChange({ wsl: { mode: 'wsl', distribution: event.target.value || undefined } })}>
        <option value="">{zh ? '选择已安装的 WSL2 发行版' : 'Choose an installed WSL2 distribution'}</option>
        {status?.distributions.map(row => <option value={row.name} key={row.name} disabled={row.version !== 2}>{row.name} · WSL{row.version} · {row.state}</option>)}
        {config.distribution && !status?.distributions.some(row => row.name === config.distribution) && <option value={config.distribution}>{config.distribution} · {zh ? '当前不可用' : 'Unavailable'}</option>}
      </select>
    </label>}
    <p className="settings-hint">{zh ? 'WSL 项目需选择对应发行版的 Linux 文件夹（\\\\wsl.localhost\\发行版\\...）。命令与 Git 在 Linux 执行，文件工具通过已核对的映射访问同一目录。Windows 盘符项目不支持；受管 Worktree 保留在同一发行版内。' : 'Select a Linux folder under \\\\wsl.localhost\\distribution. Commands and Git run in Linux; file tools use the verified mapping. Windows-drive projects are not supported; managed worktrees stay in the same distribution.'}</p>
    {status?.error && <p role="status" className="settings-hint">{status.error}</p>}
    {message && <p role="status" className="settings-hint">{message}</p>}
    <button className="btn btn-ghost" disabled={busy} onClick={() => void refresh()}>{busy ? (zh ? '检查中…' : 'Checking…') : (zh ? '刷新 WSL 状态' : 'Refresh WSL status')}</button>
    {config.mode === 'wsl' && <button className="btn btn-ghost" disabled={busy || !config.distribution || !status?.available} onClick={() => void validate()}>{zh ? '检查项目文件夹' : 'Check a project folder'}</button>}
  </section>
}
