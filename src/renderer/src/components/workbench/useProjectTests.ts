import { useEffect, useRef, useState } from 'react'
import type { ProjectTestCommand, ProjectTestRunResult } from '../../../../shared/types'
import { useStore } from '../../store'

export type ProjectTestOutputStream = 'stdout' | 'stderr'

interface ActiveRunIdentity {
  sessionId: string
  commandId: string
}

export interface ProjectTestsController {
  activeId: string | null
  commands: ProjectTestCommand[]
  loading: boolean
  error: string
  result: ProjectTestRunResult | null
  stale: boolean
  runningCommandId: string | null
  cancelPending: boolean
  stream: ProjectTestOutputStream
  runningHere: boolean
  refresh(): Promise<void>
  run(command: ProjectTestCommand): Promise<void>
  cancel(): Promise<void>
  setStream(stream: ProjectTestOutputStream): void
  invalidate(): void
}

export function useProjectTests(): ProjectTestsController {
  const activeId = useStore((state) => state.activeId)
  const [commands, setCommands] = useState<ProjectTestCommand[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ProjectTestRunResult | null>(null)
  const [stale, setStale] = useState(false)
  const [runningCommandId, setRunningCommandId] = useState<string | null>(null)
  const [cancelPending, setCancelPending] = useState(false)
  const [stream, setStream] = useState<ProjectTestOutputStream>('stdout')
  const discoverySequence = useRef(0)
  const activeRun = useRef<ActiveRunIdentity | null>(null)
  const activeSessionId = useRef(activeId)
  activeSessionId.current = activeId

  const refreshSession = async (sessionId: string): Promise<void> => {
    const sequence = ++discoverySequence.current
    setLoading(true); setError('')
    try {
      const discovered = await window.agentDesk.discoverProjectTests(sessionId)
      if (sequence !== discoverySequence.current) return
      setCommands(discovered.commands)
      if (!discovered.ok) setError(discovered.error ?? 'Test discovery failed')
    } catch (caught) {
      if (sequence === discoverySequence.current) setError(errorMessage(caught))
    } finally {
      if (sequence === discoverySequence.current) setLoading(false)
    }
  }

  useEffect(() => {
    discoverySequence.current += 1
    setCommands([]); setError(''); setResult(null); setStale(false)
    setRunningCommandId(activeRun.current?.sessionId === activeId ? activeRun.current.commandId : null)
    if (activeId) void refreshSession(activeId)
  }, [activeId])

  const run = async (command: ProjectTestCommand): Promise<void> => {
    if (!activeId || activeRun.current) return
    const sessionId = activeId
    activeRun.current = { sessionId, commandId: command.id }
    setRunningCommandId(command.id); setResult(null); setError(''); setStream('stdout')
    try {
      const next = await window.agentDesk.runProjectTest(sessionId, command.id)
      if (activeSessionId.current === sessionId) {
        setResult(next); setStale(false)
        setStream(next.stderr && !next.stdout ? 'stderr' : 'stdout')
      }
    } catch (caught) {
      if (activeSessionId.current === sessionId) setError(errorMessage(caught))
    } finally {
      activeRun.current = null; setCancelPending(false)
      if (activeSessionId.current === sessionId) setRunningCommandId(null)
    }
  }

  const cancel = async (): Promise<void> => {
    const running = activeRun.current
    if (!running || cancelPending) return
    setCancelPending(true)
    try {
      await window.agentDesk.cancelProjectTest(running.sessionId)
    } catch (caught) {
      if (activeSessionId.current === running.sessionId) setError(errorMessage(caught))
      setCancelPending(false)
    }
  }

  return {
    activeId, commands, loading, error, result, stale, runningCommandId, cancelPending, stream,
    runningHere: activeRun.current?.sessionId === activeId,
    refresh: () => activeId ? refreshSession(activeId) : Promise.resolve(),
    run, cancel, setStream, invalidate: () => setStale(true)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
