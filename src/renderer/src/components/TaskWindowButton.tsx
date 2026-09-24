import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { taskWindowSessionId } from '../task-window-context'

export default function TaskWindowButton({ sessionId, zh }: { sessionId: string; zh: boolean }): React.JSX.Element | null {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (taskWindowSessionId()) return null
  const label = zh ? '在独立窗口打开' : 'Open in a separate window'
  return <span className="task-window-open-wrap">
    <button type="button" className="icon-btn" data-task-window-open aria-label={label} title={label} disabled={busy} onClick={() => {
      setBusy(true); setError('')
      void window.agentDesk.openTaskWindow(sessionId).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false))
    }}><ExternalLink size={16} /></button>
    {error && <span className="task-window-open-error" role="alert">{error}</span>}
  </span>
}
