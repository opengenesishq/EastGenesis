import { useEffect, useRef, useState } from 'react'
import { TASK_EXECUTION_AUTHORITY_WRITE_TOOLS, type TaskExecutionAuthorityView } from '../../../../shared/task-execution-authority-types'
import { useStore } from '../../store'
import './preparation-permission.css'

const CHANGED = 'caogen:task-execution-authority-changed'

export default function TaskExecutionAuthority({ sessionId, running }: {
  sessionId: string; running: boolean
}): React.JSX.Element {
  const zh = useStore(state => state.settings.language === 'zh')
  const strategy = useStore(state => state.sessions[sessionId]?.meta.taskStrategy)
  const [view, setView] = useState<TaskExecutionAuthorityView>()
  const [paths, setPaths] = useState('**/*')
  const [commands, setCommands] = useState('')
  const [tools, setTools] = useState<string[]>([...TASK_EXECUTION_AUTHORITY_WRITE_TOOLS])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const generation = useRef(0)
  useEffect(() => {
    mounted.current = true
    const refresh = (): void => {
      const revision = ++generation.current
      void window.agentDesk.getTaskExecutionAuthority(sessionId).then(value => {
        if (!mounted.current || revision !== generation.current) return
        setView(value); setError('')
        if (value.status === 'granted') {
          setPaths(value.pathPatterns.join('\n')); setCommands(value.allowedCommandPatterns.join('\n')); setTools([...value.allowedWriteTools])
        }
      }).catch(() => {
        if (mounted.current && revision === generation.current) setError(zh ? '无法读取任务授权，请重新打开任务。' : 'Unable to read access. Reopen this task.')
      })
    }
    const changed = (event: Event): void => {
      if ((event as CustomEvent<string>).detail === sessionId) refresh()
    }
    refresh()
    window.addEventListener(CHANGED, changed)
    return () => { mounted.current = false; generation.current++; window.removeEventListener(CHANGED, changed) }
  }, [sessionId, running, zh])

  const mutate = async (operation: 'grant' | 'revoke'): Promise<void> => {
    if (!view || busy) return
    if (operation === 'grant' && !view.bindingDigest) return
    const revision = ++generation.current
    setBusy(true); setError('')
    try {
      const result = operation === 'grant'
        ? await window.agentDesk.grantTaskExecutionAuthority(sessionId, {
          expectedRevision: view.revision,
          expectedBindingDigest: view.bindingDigest!,
          pathPatterns: paths.split('\n').map(path => path.trim()).filter(Boolean),
          allowedWriteTools: TASK_EXECUTION_AUTHORITY_WRITE_TOOLS.filter(tool => tools.includes(tool)),
          allowedCommandPatterns: commands.split('\n').map(command => command.trim()).filter(Boolean)
        })
        : await window.agentDesk.revokeTaskExecutionAuthority(sessionId, { expectedRevision: view.revision })
      if (mounted.current && generation.current === revision) setView(result)
      window.dispatchEvent(new CustomEvent(CHANGED, { detail: sessionId }))
    } catch (cause) {
      if (mounted.current && generation.current === revision) setError(cause instanceof Error ? cause.message : (zh ? '授权变更失败。' : 'Access change failed.'))
    } finally { if (mounted.current) setBusy(false) }
  }
  const status = view?.status === 'granted' ? (view.available ? (zh ? '范围已限定' : 'Scoped') : (zh ? '授权待更新' : 'Grant needs updating'))
    : view?.status === 'revoked' ? (zh ? '已撤权' : 'Revoked')
      : view?.status === 'legacy' ? (zh ? '沿用现有规则' : 'Existing rules') : (zh ? '读取中' : 'Loading')
  return <details className="preparation-permission task-execution-authority" data-task-authority-session={sessionId} data-task-authority-status={view?.status ?? 'loading'}>
    <summary>{zh ? 'Agent 文件修改范围' : 'Agent file access'} · {status}</summary>
    <p>{zh ? '限定后，Agent 可读取资料并使用下方工具修改文件。命令需另行逐条授权；桌面和外部服务不在此范围。全局规则仍生效。恢复到其他设备后需要重新授权。'
      : 'Once scoped, the Agent can read and use the selected tools to modify files. Commands require separate per-command authorization; desktop actions and external services are outside this scope. Global rules also apply. Restoring on another device requires a new grant.'}</p>
    {view?.directory && <code className="preparation-directory">{view.directory}</code>}
    {view?.unavailableReason && <p>{view.unavailableReason}</p>}
    <label>{zh ? '允许修改的相对路径（每行一个）' : 'Allowed relative paths (one per line)'}
      <textarea rows={2} value={paths} disabled={busy || running} onChange={event => setPaths(event.target.value)} placeholder={'docs/**\nreports/*.xlsx'} />
    </label>
    <p className="studio-result-muted">{zh ? '**/* 表示上方目录内全部文件；docs/** 表示其中的 docs 文件夹。' : '**/* covers files inside the directory above; docs/** covers its docs folder.'}</p>
    <label>{zh ? '允许执行的完整命令（每行一条，逐字匹配）' : 'Allowed complete commands (one per line; exact match)'}
      <textarea rows={2} value={commands} disabled={busy || running} onChange={event => setCommands(event.target.value)} placeholder={'npm test -- --runInBand\ngit diff --stat'} />
    </label>
    <p className="studio-result-muted">{zh ? '命令授权独立于文件路径授权，按完整命令逐字匹配；未列出的命令会被拒绝，并继续遵守全局权限规则。清空文件工具和路径即可只授权命令。' : 'Commands are matched verbatim and authorized independently from file paths. Unlisted commands are denied and global permission rules still apply. Clear file tools and paths to grant commands only.'}</p>
    <div className="task-execution-authority-tools">{TASK_EXECUTION_AUTHORITY_WRITE_TOOLS.map(tool => <label key={tool}>
      <input type="checkbox" checked={tools.includes(tool)} disabled={busy || running}
        onChange={event => setTools(current => event.target.checked ? [...current, tool] : current.filter(value => value !== tool))} />
      {toolLabel(tool, zh)}
    </label>)}</div>
    <div className="task-execution-authority-actions">
      <button type="button" className="btn btn-ghost btn-sm" disabled={!view?.bindingDigest || busy || running || strategy !== 'execute' || (!paths.trim() && !commands.trim()) || Boolean(paths.trim()) !== Boolean(tools.length)}
        onClick={() => void mutate('grant')}>{view?.status === 'granted' ? (zh ? '更新修改范围' : 'Update scope') : (zh ? '限定并授权' : 'Grant scoped access')}</button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={!view || busy || view.status === 'revoked'}
        onClick={() => void mutate('revoke')}>{zh ? '撤销 Agent 文件修改权限' : 'Revoke Agent file access'}</button>
    </div>
    {strategy !== 'execute' && <p>{zh ? '批准计划并进入执行后，可授权正式目录修改；起草可使用文件准备区。' : 'Approve the plan and enter execution to grant project file access. Drafts can use the preparation area.'}</p>}
    {error && <p role="alert">{error}</p>}
  </details>
}

function toolLabel(tool: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    write_file: ['写入文本文件', 'Write text files'], edit_file: ['编辑文本文件', 'Edit text files'],
    search_replace: ['查找与替换', 'Find and replace'], create_document: ['创建 Word', 'Create Word'],
    create_spreadsheet: ['创建 Excel', 'Create Excel'], create_presentation: ['创建 PowerPoint', 'Create PowerPoint'],
    create_pdf: ['创建 PDF', 'Create PDF'], revise_office_artifact: ['修订 Office 文件', 'Revise Office files']
  }
  return labels[tool]?.[zh ? 0 : 1] ?? tool
}
