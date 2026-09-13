import { resolve } from 'node:path'
import type { ConnectorResourceLifecycle } from '../../shared/project-workspace-types'
import { mutateProjectConnector } from './project-connector-lifecycle'
import { openProjectWorkspaceStore } from './store'
import { projectResourceEgressPolicy } from './resource-context'

const SWEEP_INTERVAL_MS = 30_000

interface SchedulerState {
  rootDir: string
  timer?: NodeJS.Timeout
  running?: Promise<void>
  rerun: boolean
}

let scheduler: SchedulerState | undefined

export function startProjectConnectorAutoRefreshScheduler(rootDir: string): void {
  stopProjectConnectorAutoRefreshScheduler()
  scheduler = { rootDir: requiredRoot(rootDir), rerun: false }
  schedule(0)
}

export function stopProjectConnectorAutoRefreshScheduler(): void {
  if (scheduler?.timer) clearTimeout(scheduler.timer)
  scheduler = undefined
}

/** Deterministic scheduler sweep used by runtime smoke tests and recovery tooling. */
export async function runProjectConnectorAutoRefreshSweep(rootDir: string): Promise<void> {
  await refreshDueConnectors(requiredRoot(rootDir))
}

function schedule(delay: number): void {
  const state = scheduler
  if (!state) return
  if (state.timer) clearTimeout(state.timer)
  state.timer = setTimeout(() => {
    state.timer = undefined
    void sweep(state)
  }, delay)
  state.timer.unref?.()
}

async function sweep(state: SchedulerState): Promise<void> {
  if (scheduler !== state) return
  if (state.running) {
    state.rerun = true
    return
  }
  state.running = refreshDueConnectors(state.rootDir).finally(() => {
    state.running = undefined
  })
  await state.running
  if (scheduler !== state) return
  const delay = state.rerun ? 0 : SWEEP_INTERVAL_MS
  state.rerun = false
  schedule(delay)
}

async function refreshDueConnectors(rootDir: string): Promise<void> {
  const store = await openProjectWorkspaceStore(rootDir)
  const workspaces = await store.listWorkspaces({ includeArchived: false, includeDeleted: false })
  const now = Date.now()
  for (const workspace of workspaces.filter((candidate) => candidate.status === 'active')) {
    for (const resource of workspace.resources.filter((candidate) => candidate.kind === 'connector')) {
      const currentWorkspace = await store.getWorkspace(workspace.id)
      const currentResource = currentWorkspace?.resources.find((candidate) => candidate.id === resource.id)
      const lifecycle = currentResource?.connector?.lifecycle
      if (!currentWorkspace || !currentResource || !lifecycle) continue
      const autoRefresh = lifecycle.autoRefresh
      if (!isDue(autoRefresh, now) || lifecycle.enabled === false || currentResource.connector?.authorization.status !== 'active' || projectResourceEgressPolicy(currentResource) === 'deny') continue
      if (lifecycle.refresh.status === 'requested' || lifecycle.refresh.status === 'running') continue
      try {
        await mutateProjectConnector(rootDir, currentWorkspace.id, currentResource.id, { kind: 'request_refresh' }, { expectedRevision: currentWorkspace.revision })
      } catch (error) {
        console.error(`[caogen] Project connector auto-refresh failed:${workspace.id}:${resource.id}`, error)
      }
    }
  }
}

function isDue(value: ConnectorResourceLifecycle['autoRefresh'] | undefined, now: number): value is NonNullable<ConnectorResourceLifecycle['autoRefresh']> {
  if (!value || value.intervalMs === 0 || value.nextAt === undefined) return false
  return Number.isFinite(value.nextAt) && value.nextAt <= now
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('Project connector scheduler root is invalid')
  return resolve(value)
}
