import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionMeta, TaskPlanStateView } from '../../../../shared/types'
import { DEFAULT_PROJECT_INSTITUTION_TEMPLATE, type ProjectInstitutionContext } from '../../../../shared/project-institution-template'
import { systemRolesForTemplate } from './kit/palace/systemRoleCatalog'

/** Scene institutions follow the active task's frozen generation, or the
 * selected project's future default when no task is selected. */
export function useOfficeInstitutions(projectId: string | undefined, meta: SessionMeta | undefined,
  sessions: readonly SessionMeta[], readPlans: boolean) {
  const goalId = meta && meta.workspaceId === projectId ? meta.goalId : undefined
  const workItemId = meta && meta.workspaceId === projectId ? meta.workItemId : undefined
  const key = JSON.stringify([projectId, goalId, workItemId])
  const [context, setContext] = useState<{ key: string; value: ProjectInstitutionContext }>()
  const [error, setError] = useState('')
  const sequence = useRef(0)
  useEffect(() => {
    setContext(undefined); setError('')
    if (!projectId) return
    const refresh = async (): Promise<void> => {
      const request = ++sequence.current
      try {
        const value = await window.agentDesk.getProjectInstitutionContext({ projectId, ...(goalId ? { goalId } : {}), ...(workItemId ? { workItemId } : {}) })
        if (request !== sequence.current) return
        if (value.projectId !== projectId || value.workItemId !== workItemId || (goalId && value.goalId !== goalId)) throw new Error('机构记录与当前任务不一致')
        setContext({ key, value }); setError('')
      } catch (cause) {
        if (request === sequence.current) { setContext(undefined); setError(cause instanceof Error ? cause.message : String(cause)) }
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15_000)
    window.addEventListener('focus', refresh)
    return () => { sequence.current++; window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [key])
  const value = context?.key === key ? context.value : undefined
  const roles = useMemo(() => !projectId ? systemRolesForTemplate(DEFAULT_PROJECT_INSTITUTION_TEMPLATE)
    : value ? systemRolesForTemplate(value.template, value.recordedRoleIds) : [], [projectId, value])
  const sessionKey = sessions.filter(session => session.workspaceId === projectId && (!goalId || session.goalId === goalId))
    .map(session => session.id).sort().join('\0')
  const [planRead, setPlanRead] = useState<{ key: string; plans: TaskPlanStateView[]; unavailable: number }>()
  const planKey = `${key}:${sessionKey}`
  useEffect(() => {
    setPlanRead(undefined)
    if (!readPlans) return
    let active = true
    let sequence = 0
    const refresh = async (): Promise<void> => {
      const request = ++sequence
      const records = await Promise.allSettled(sessionKey ? sessionKey.split('\0').map(id => window.agentDesk.getTaskPlan(id)) : [])
      if (active && request === sequence) setPlanRead({ key: planKey, plans: records.flatMap(record => record.status === 'fulfilled' ? [record.value] : []),
        unavailable: records.filter(record => record.status === 'rejected').length })
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [readPlans, planKey])
  return { context: value, roles, error, loading: !!projectId && !value && !error, goalId, workItemId,
    plans: planRead?.key === planKey ? planRead.plans : [],
    plansLoading: readPlans && planRead?.key !== planKey,
    unavailablePlans: planRead?.key === planKey ? planRead.unavailable : 0 }
}
