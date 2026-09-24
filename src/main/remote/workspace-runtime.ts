import { createProductionProjectAggregateService } from '../project-aggregate'
import { sessionManager } from '../sessionManager'
import { listHistory } from '../history'
import { assertTaskExecutionEnvironment } from '../wsl/binding'
import { getRemoteContinuationStore } from './store'
import { digest } from '../project-workspace/codec'
import { readRemoteWorkspaceSource, type RemoteWorkspaceSource } from './workspace-reader'
import type { RemoteWorkspaceRequest, RemoteWorkspaceResult } from '../../shared/remote-workspace-types'
import type { RemoteHostApprovalCandidate } from '../../shared/remote-host-types'

async function source(rootDir: string, deviceId: string, projectId: string, workItemId: string): Promise<RemoteWorkspaceSource> {
  const store = getRemoteContinuationStore(rootDir), snapshot = await store.getSnapshot()
  const device = snapshot.devices.find(item => item.id === deviceId && item.status === 'active')
  if (!device?.capabilities.includes('workspace_read')) throw new Error('此设备未获工作区读取授权，请在远端设备权限中明确开启。')
  const aggregate = await createProductionProjectAggregateService(rootDir).verifyLiveProject(projectId)
  const task = aggregate.workItems.find(item => item.id === workItemId)
  if (!task) throw new Error('任务不属于当前配对项目。')
  const matches = (item: { workspaceId?: string; workItemId?: string; parentSessionId?: string }) => item.workspaceId === projectId && item.workItemId === workItemId && !item.parentSessionId
  const active = sessionManager.list().filter(item => item.status !== 'closed' && matches(item))
  const candidates = active.length ? active : listHistory().filter(matches)
  if (candidates.length !== 1) throw new Error('该任务没有唯一可查看的原始会话，请在远端选择任务。')
  const meta = candidates[0]
  assertTaskExecutionEnvironment(meta)
  const runs = aggregate.workflow.runs.filter(item => item.workItemId === workItemId && item.sessionId === meta.id).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
  const run = runs[0]
  return { projectId, workItemId, sessionId: meta.id, ...(run ? { runId: run.id } : {}), cwd: meta.cwd, title: task.title,
    authorityDigest: digest({ device: device.id, key: device.publicKeyFingerprint, capabilities: device.capabilities.slice().sort(), authorityHistory: device.auditIds,
      session: meta.id, sdk: meta.sdkSessionId, workspaceId: meta.workspaceId, workItemId: meta.workItemId, cwd: meta.cwd,
      executionEnvironment: meta.executionEnvironment, permissionMode: meta.permissionMode, taskStrategy: meta.taskStrategy, driveMode: meta.driveMode }) }
}
export async function readBoundRemoteWorkspace(rootDir: string, deviceId: string, projectId: string, request: RemoteWorkspaceRequest): Promise<RemoteWorkspaceResult> {
  if (!request || typeof request.workItemId !== 'string') throw new Error('远端工作区请求无效。')
  const before = await source(rootDir, deviceId, projectId, request.workItemId)
  const result = readRemoteWorkspaceSource(before, deviceId, request)
  const after = await source(rootDir, deviceId, projectId, request.workItemId)
  if (digest(before) !== digest(after)) throw new Error('读取期间远端任务或授权发生变化，结果已丢弃。')
  return result
}
export async function remoteApprovalCandidates(rootDir: string, projectId: string): Promise<RemoteHostApprovalCandidate[]> {
  const aggregate = await createProductionProjectAggregateService(rootDir).verifyLiveProject(projectId)
  return sessionManager.list().filter(meta => meta.status !== 'closed' && meta.workspaceId === projectId && meta.workItemId && !meta.parentSessionId).flatMap(meta => {
    const task = aggregate.workItems.find(item => item.id === meta.workItemId), session = sessionManager.get(meta.id)
    if (!task || !session) return []
    return session.pendingPermissions().filter(item => item.effectScope?.targetDigest).map(item => ({ sessionId: meta.id, workItemId: task.id,
      permissionRequestId: item.requestId, action: item.toolName, targetDigest: item.effectScope!.targetDigest,
      dataScope: digest({ toolName: item.toolName, capabilities: item.capabilities, effectScope: item.effectScope ?? null, riskLevel: item.riskLevel ?? null }),
      revision: task.revision, summary: `${item.toolName} · ${task.title}\n${item.effectScope!.summary}`.slice(0, 4000) }))
  }).slice(0, 100)
}
