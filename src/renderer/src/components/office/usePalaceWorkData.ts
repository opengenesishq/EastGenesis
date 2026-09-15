import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectWorkspace, TaskPlanStateView, WorkItem, WorkflowLedgerRendererSelection } from '../../../../shared/types'
import { mergeWorkflowLedgerPages } from '../studio/workInboxNavigation'

export function usePalaceWorkData(sessionIds: string[]) {
  const [projects, setProjects] = useState<ProjectWorkspace[]>([])
  const [items, setItems] = useState<WorkItem[]>([])
  const [plans, setPlans] = useState<TaskPlanStateView[]>([])
  const [ledger, setLedger] = useState<WorkflowLedgerRendererSelection | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [unavailablePlans, setUnavailablePlans] = useState(0)
  const [updatedAt, setUpdatedAt] = useState<number>()
  const sequence = useRef(0)
  const sessionKey = [...sessionIds].sort().join('\0')
  const refresh = useCallback(async (): Promise<void> => {
    const request = ++sequence.current
    setLoading(true)
    setError('')
    try {
      const [nextProjects, nextItems, nextLedger, nextPlans] = await Promise.all([
        window.agentDesk.listProjectWorkspaces({ includeArchived: true }),
        window.agentDesk.listProjectWorkItems(),
        readPalaceLedger(),
        Promise.allSettled(sessionKey ? sessionKey.split('\0').map((id) => window.agentDesk.getTaskPlan(id)) : [])
      ])
      if (sequence.current !== request) return
      setProjects(nextProjects); setItems(nextItems); setLedger(nextLedger)
      setPlans(nextPlans.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []))
      setUnavailablePlans(nextPlans.filter((result) => result.status === 'rejected').length)
      setUpdatedAt(Date.now())
    } catch (cause) {
      if (sequence.current === request) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (sequence.current === request) setLoading(false) }
  }, [sessionKey])
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15_000)
    return () => { sequence.current++; window.clearInterval(timer) }
  }, [refresh])
  return { projects, items, plans, ledger, loading, error, unavailablePlans, updatedAt, refresh }
}

async function readPalaceLedger(): Promise<WorkflowLedgerRendererSelection | null> {
  const pages: WorkflowLedgerRendererSelection[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await window.agentDesk.listWorkflowLedger({ limit: 500, ...(cursor ? { cursor } : {}) })
    pages.push(page)
    cursor = [page.goals, page.workItems, page.runs, page.artifacts, page.acceptances, page.evidenceLinks, page.events]
      .find((entry) => entry.hasMore)?.nextCursor
    if (cursor && seen.has(cursor)) throw new Error('账本分页未前进，请刷新后重试。')
    if (cursor) seen.add(cursor)
  } while (cursor)
  return mergeWorkflowLedgerPages(pages)
}
