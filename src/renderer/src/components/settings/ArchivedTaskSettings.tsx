import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
export default function ArchivedTaskSettings(): React.JSX.Element {
  const zh = useStore(state => state.settings.language) === 'zh'
  const history = useStore(state => state.history)
  const restore = useStore(state => state.archiveHistory)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    void window.agentDesk.listHistory().then(rows => { if (alive.current) useStore.setState({ history: rows }) }).catch(cause => { if (alive.current) setError(String(cause)) })
    return () => { alive.current = false }
  }, [])
  const rows = history.filter(item => item.archived && `${item.title} ${item.cwd}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <><p className="desktop-preference-intro">{zh ? '这里与侧栏使用同一份归档记录。恢复后任务回到原项目，文件和对话保留。' : 'These are the same archived tasks as the sidebar. Restoring returns a task to its original project with its files and conversation.'}</p>
    <input className="input input-block" placeholder={zh ? '搜索已归档任务' : 'Search archived tasks'} aria-label={zh ? '搜索已归档任务' : 'Search archived tasks'} value={query} onChange={event => setQuery(event.target.value)} />
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    <div className="desktop-preference-card">{rows.length ? rows.map(row => <div className="desktop-preference-row" key={row.id}>
      <div className="desktop-preference-label"><span>{row.title}</span><p>{row.cwd}</p></div><button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => {
        setBusy(row.id); setError('')
        void restore(row.id, false).catch(cause => { if (alive.current) setError(String(cause)) }).finally(() => { if (alive.current) setBusy('') })
      }}>{busy === row.id ? (zh ? '恢复中…' : 'Restoring…') : (zh ? '恢复任务' : 'Restore task')}</button>
    </div>) : <p className="settings-hint">{zh ? '没有匹配的已归档任务。' : 'No matching archived tasks.'}</p>}</div>
  </>
}
