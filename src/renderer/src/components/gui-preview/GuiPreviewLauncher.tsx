import { useRef, useState } from 'react'
import { PictureInPicture2 } from 'lucide-react'

export default function GuiPreviewLauncher({ sessionId, zh = true }: { sessionId: string; zh?: boolean }): React.JSX.Element {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const open = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError('')
    try { await window.agentDesk.openGuiPreview(sessionId) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { inFlight.current = false; setBusy(false) }
  }
  return <span className="gui-preview-launcher">
    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} title={zh ? '电脑操作画中画' : 'Computer use preview'} aria-label={zh ? '打开电脑操作画中画' : 'Open computer use preview'} onClick={() => void open()}><PictureInPicture2 size={15}/></button>
    {error && <span role="alert" style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span>}
  </span>
}
