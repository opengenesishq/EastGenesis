import { ipcMain } from 'electron'
import { join } from 'node:path'
import type { LearningProjectSnapshot, LearningRecord } from '../../shared/learning-types'
import {
  approveLearningDraft,
  deleteLearningRecord,
  getLearningRecord,
  listLearningProject,
  rejectLearningDraft,
  revokeLearningRecord,
  rollbackLearningRecord
} from '../learning/learning-lifecycle'
import { createTrustedUserLearningDecision } from '../learning/learning-security'
import { resolveDefaultLearningRoot } from '../learning/learning-store'
import type { ProjectMemoryTarget } from '../memoryStore'
import { projectLearningNamespace } from '../project-aggregate/project-memory-adapter'
import { verifyProductionProjectMutation } from '../project-aggregate/project-mutation-ingress'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

export interface LearningIpcOptions {
  projectRootFor(sessionId: string): string | null
  targetForSession?(sessionId: string): ProjectMemoryTarget | null
  userDataRoot?(): string
}

interface LearningContext {
  projectRoot: string
  memoryNamespace: string
  learningRoot: string
  projectId?: string
}

export function registerLearningIpc(options: LearningIpcOptions): void {
  const contextFor = async (sessionId: string): Promise<LearningContext> => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('必须指定会话')
    const target = options.targetForSession
      ? options.targetForSession(sessionId.trim())
      : legacyTarget(options.projectRootFor(sessionId.trim()))
    if (!target) throw new Error('会话不存在')
    return {
      projectRoot: target.projectRoot,
      memoryNamespace: target.projectId ? projectLearningNamespace(target.projectId) : target.projectRoot,
      projectId: target.projectId,
      learningRoot: await resolveDefaultLearningRoot(target.projectRoot,
        options.userDataRoot ? join(options.userDataRoot(), 'learning') : undefined)
    }
  }

  ipcMain.handle('learning:list', async (event, sessionId: string) => {
    assertTrustedWorkflowLedgerSender(event)
    return listScopedLearning(await contextFor(sessionId))
  })

  const decisions = {
    approve: approveLearningDraft,
    reject: rejectLearningDraft,
    rollback: rollbackLearningRecord,
    revoke: revokeLearningRecord,
    delete: deleteLearningRecord
  }
  for (const [action, mutate] of Object.entries(decisions)) {
    ipcMain.handle(`learning:${action}`, async (event, sessionId: string, rawRecordId: string) => {
      assertTrustedWorkflowLedgerSender(event)
      const context = await contextFor(sessionId)
      const recordId = requiredRecordId(rawRecordId)
      const namespace = await namespaceForRecord(context, recordId)
      const result = await mutate(namespace, context.learningRoot, recordId,
        createTrustedUserLearningDecision(`ipc:learning:${action}`))
      if (context.projectId && options.userDataRoot) {
        await verifyProductionProjectMutation(options.userDataRoot(), context.projectId)
      }
      return result
    })
  }
}

async function namespaceForRecord(context: LearningContext, recordId: string): Promise<string> {
  if (context.memoryNamespace === context.projectRoot) return context.projectRoot
  const memory = await getLearningRecord(context.memoryNamespace, context.learningRoot, recordId)
  if (memory?.kind === 'memory') return context.memoryNamespace
  const skill = await getLearningRecord(context.projectRoot, context.learningRoot, recordId)
  if (skill?.kind === 'skill') return context.projectRoot
  throw new Error('Learning 记录不属于当前项目')
}

async function listScopedLearning(context: LearningContext): Promise<LearningProjectSnapshot> {
  if (context.memoryNamespace === context.projectRoot) {
    return listLearningProject(context.projectRoot, context.learningRoot)
  }
  // Skills still materialize under the real resource path. Memory is owned by Project ID.
  const [memory, skills] = await Promise.all([
    listLearningProject(context.memoryNamespace, context.learningRoot),
    listLearningProject(context.projectRoot, context.learningRoot)
  ])
  const records = [
    ...memory.records.filter((record) => record.kind === 'memory'),
    ...skills.records.filter((record) => record.kind === 'skill')
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new Error('Learning 记录身份冲突')
  }
  const memoryIds = new Set(records.filter((record) => record.kind === 'memory').map((record) => record.id))
  const skillIds = new Set(records.filter((record) => record.kind === 'skill').map((record) => record.id))
  return {
    schemaVersion: 1,
    project: memory.project,
    records,
    active: records.filter((record) => record.status === 'active'),
    drafts: records.filter((record) => record.status === 'draft'),
    history: records.filter(isHistorical),
    audit: [
      ...memory.audit.filter((event) => memoryIds.has(event.recordId)),
      ...skills.audit.filter((event) => skillIds.has(event.recordId))
    ].sort((a, b) => a.at.localeCompare(b.at))
  }
}

function isHistorical(record: LearningRecord): boolean {
  return record.status !== 'active' && record.status !== 'draft'
}

function legacyTarget(projectRoot: string | null): ProjectMemoryTarget | null {
  return projectRoot ? { projectRoot } : null
}

function requiredRecordId(recordId: string): string {
  if (typeof recordId !== 'string' || !recordId.trim()) throw new Error('必须指定 Learning 记录')
  return recordId.trim()
}
