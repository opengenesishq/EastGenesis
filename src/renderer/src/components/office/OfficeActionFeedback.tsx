import { useEffect, useState } from 'react'

type OfficeFeedback = { sessionId: string; title: string; text: string; error?: boolean }
const EVENT = 'caogen:office-action-feedback'

export function publishOfficeActionFeedback(feedback: OfficeFeedback): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: feedback }))
}

/** Lives above selection so a stopped/retired actor cannot erase its command receipt. */
export default function OfficeActionFeedback(): React.JSX.Element | null {
  const [feedback, setFeedback] = useState<OfficeFeedback>()
  useEffect(() => {
    const receive = (event: Event): void => setFeedback((event as CustomEvent<OfficeFeedback>).detail)
    window.addEventListener(EVENT, receive)
    return () => window.removeEventListener(EVENT, receive)
  }, [])
  if (!feedback) return null
  return <div className="office-action-feedback" role={feedback.error ? 'alert' : 'status'} data-office-session-receipt={feedback.sessionId}>
    <strong>{feedback.title}</strong><span>{feedback.text}</span>
  </div>
}
