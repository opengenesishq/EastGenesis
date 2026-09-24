import { useState } from 'react'
import ComputerHistoryPage from '../../pages/ComputerHistory'
import ComputerHistorySettings from './ComputerHistorySettings'

/** A complete settings-only entry: permissions first, then the local timeline. */
export default function ComputerHistoryPanel(): React.JSX.Element {
  const [historyOpen, setHistoryOpen] = useState(false)
  return historyOpen ? <ComputerHistoryPage onClose={() => setHistoryOpen(false)} /> : <ComputerHistorySettings onOpenHistory={() => setHistoryOpen(true)} />
}
