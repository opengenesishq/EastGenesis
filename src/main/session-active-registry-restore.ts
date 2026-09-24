import { app } from 'electron'
import { getTaskHostExecutionGate, taskHostSubject } from './task-handoff/execution-gate'
import type { AgentEvent, AgentEventIdentity, SessionMeta } from '../shared/types'
import type { Engine } from './engine'
import { createEngine } from './engine'
import {
  bindLegacyUnscopedSessionForRecovery,
  resolveDigitalWorkerSessionScope
} from './digital-worker/session-binding'

export interface PreparedActiveSession {
  record: SessionMeta
  meta: SessionMeta
  engine: Engine
  projectPath?: string
  bufferedEvents: Array<{ event: AgentEvent; seq: number; identity?: AgentEventIdentity }>
}

export function prepareActiveSessionEngines(
  records: readonly SessionMeta[],
  prepared: PreparedActiveSession[]
): void {
  for (const record of records) {
    getTaskHostExecutionGate(app.getPath('userData')).assert(taskHostSubject(record))
    const meta = bindLegacyUnscopedSessionForRecovery(restoredSessionMeta(record))
    resolveDigitalWorkerSessionScope(meta, app.getPath('userData'))
    const bufferedEvents: PreparedActiveSession['bufferedEvents'] = []
    prepared.push({
      record,
      meta,
      projectPath: !meta.unassigned && !meta.workspaceId && !meta.projectId ? meta.sourceCwd ?? meta.cwd : undefined,
      bufferedEvents,
      engine: createEngine(
        meta.engine,
        meta,
        (event, seq, identity) => bufferedEvents.push({ event, seq, identity }),
        record.sdkSessionId
      )
    })
  }
}

export function startActiveSessionEngines(
  prepared: readonly PreparedActiveSession[],
  startRestoredEngine?: (record: SessionMeta, engine: Engine) => void | Promise<void>
): void {
  for (const item of prepared) {
    void Promise.resolve().then(() => startRestoredEngine
      ? startRestoredEngine(item.record, item.engine)
      : item.engine.start()).catch((error) => {
      console.error(`[caogen] active session Engine 启动失败 (${item.meta.id}):`, error)
    })
  }
}

function restoredSessionMeta(record: SessionMeta): SessionMeta {
  return {
    ...record,
    status: 'starting',
    lastError: record.status === 'running' || record.status === 'starting'
      ? '应用上次退出时该任务尚未完成；会话已恢复，请确认当前文件状态后继续。'
      : record.lastError
  }
}
