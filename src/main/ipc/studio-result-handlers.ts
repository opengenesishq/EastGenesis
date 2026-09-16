import { app, BrowserWindow, dialog, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { pathToFileURL } from 'node:url'
import { createProductionProjectAggregateService } from '../project-aggregate'
import { writeDurableFile } from '../task/workflow-ledger-migration-storage'
import { sessionManager } from '../sessionManager'
import { listHistory } from '../history'
import { buildStudioResultExport, buildStudioResultSnapshot } from '../studio-result/studio-result-service'
import {
  buildFailedStudioAuditTimeline,
  buildStudioAuditTimelinePage,
  buildStudioExecutionAudit,
  buildUnboundStudioAuditTimeline
} from '../studio-result/studio-audit-timeline'
import { selectModelAttempts } from '../task/model-attempt-store'
import type { ModelAttemptRecord } from '../../shared/model-attempt-types'
import type { StudioAuditTimelineQuery, StudioDeliverySummary, StudioExecutionAudit } from '../../shared/studio-result-types'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'
import { registerSessionProducedArtifacts } from '../task/session-artifact-producer'
import { buildPortableDeliveryPackage, safeFileStem } from '../studio-result/studio-result-package'
import { checkStudioResultFiles } from '../studio-result/studio-result-file-changes'
import { buildStudioResultRerunPreview } from '../studio-result/studio-result-rerun-preview'
import { confirmStudioResultRerun } from '../studio-result/studio-result-rerun-dispatch'
import { getSessionInputService } from '../task/session-input-runtime'
import { listTaskSnapshots, readTaskSnapshotDatabase } from '../task/task-snapshot'
import { listPendingSessionCreations } from '../session-creation-journal'
import type { StudioResultRerunConfirmInput, StudioResultRerunInput } from '../../shared/studio-result-rerun-types'

type StudioResultAction = 'get' | 'audit' | 'export' | 'save' | 'check_files' | 'rerun_preview' | 'rerun_confirm'

export async function handleStudioResultIpc(
  event: IpcMainInvokeEvent,
  rawAction: unknown,
  rawSessionId: unknown,
  rawQuery?: unknown
) {
  assertTrustedWorkflowLedgerSender(event)
  const action = normalizeAction(rawAction)
  const sessionId = requiredSessionId(rawSessionId)
  if (action === 'get') return studioResultSnapshotForSession(sessionId)
  if (action === 'check_files') {
    const session = sessionManager.list().find(candidate => candidate.id === sessionId)
    if (!session) throw new Error(`Studio result Session was not found: ${sessionId}`)
    return checkStudioResultFiles(session, app.getPath('userData'))
  }
  if (action === 'rerun_preview') {
    const session = sessionManager.list().find(candidate => candidate.id === sessionId)
    if (!session) throw new Error(`Studio result Session was not found: ${sessionId}`)
    return buildStudioResultRerunPreview(app.getPath('userData'), session, rerunInput(rawQuery))
  }
  if (action === 'rerun_confirm') {
    const session = sessionManager.list().find(candidate => candidate.id === sessionId)
    if (!session) throw new Error(`Studio result Session was not found: ${sessionId}`)
    const input = rerunConfirmInput(rawQuery)
    return confirmStudioResultRerun(app.getPath('userData'), session, input, {
      getSession: id => sessionManager.get(id),
      identities: async () => [...sessionManager.list(), ...listHistory(), ...(await listTaskSnapshots()).map(value => value.meta),
        ...listPendingSessionCreations().map(value => value.baseMeta)],
      requireAuthority: id => sessionManager.requireTaskExecutionAuthority(id),
      createManaged: (options, lifecycle) => sessionManager.createManaged(options, lifecycle),
      inputs: getSessionInputService(app.getPath('userData'))
    }, `local-user:webcontents-${event.sender.id}`)
  }
  if (action === 'audit') return studioAuditTimelineForSession(sessionId, auditQuery(rawQuery))
  const exported = await studioResultExportForSession(sessionId)
  if (action === 'export') return exported
  return saveStudioResult(event.sender, exported.json, exported.exportDigest, exported.bundle.snapshot, exported.bundle.executionAudit)
}

async function studioAuditTimelineForSession(sessionId: string, query: StudioAuditTimelineQuery) {
  const session = sessionManager.list().find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error(`Studio audit timeline Session was not found: ${sessionId}`)
  if (!session.workspaceId) return buildUnboundStudioAuditTimeline(session)
  let aggregate
  try {
    aggregate = await createProductionProjectAggregateService().verifyLiveProject(session.workspaceId)
  } catch {
    return buildFailedStudioAuditTimeline(session, 'PROJECT_INTEGRITY')
  }
  let attempts: ModelAttemptRecord[]
  try {
    attempts = await queryAllProjectModelAttempts(session.workspaceId)
  } catch {
    return buildFailedStudioAuditTimeline(session, 'MODEL_ATTEMPT_INTEGRITY')
  }
  return buildStudioAuditTimelinePage({
    session,
    aggregate,
    attempts,
    sessionCosts: [...listHistory(), ...sessionManager.list()],
    query
  })
}

async function queryAllProjectModelAttempts(projectId: string): Promise<ModelAttemptRecord[]> {
  return readTaskSnapshotDatabase(undefined, db => {
    const attempts: ModelAttemptRecord[] = []
    let cursor: string | undefined
    do {
      const page = selectModelAttempts(db, { projectId, limit: 500, ...(cursor ? { cursor } : {}) })
      attempts.push(...page.attempts)
      cursor = page.nextCursor
    } while (cursor)
    return attempts
  })
}

export async function studioResultSnapshotForSession(sessionId: string) {
  const session = sessionManager.list().find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error(`Studio result Session was not found: ${sessionId}`)
  const aggregate = session.workspaceId
    ? await createProductionProjectAggregateService().verifyLiveProject(session.workspaceId)
    : undefined
  const attempts = session.workspaceId ? await queryAllProjectModelAttempts(session.workspaceId) : []
  return buildStudioResultSnapshot(session, aggregate, [], Date.now(), attempts)
}

async function studioResultExportForSession(sessionId: string) {
  const current = sessionManager.list().find(candidate => candidate.id === sessionId)
  if (!current) throw new Error(`Studio result Session was not found: ${sessionId}`)
  // Neither dialog latency nor live Session/model changes may mix report and audit inputs.
  const session = structuredClone(current)
  const aggregate = session.workspaceId
    ? structuredClone(await createProductionProjectAggregateService().verifyLiveProject(session.workspaceId))
    : undefined
  const attempts = session.workspaceId ? structuredClone(await queryAllProjectModelAttempts(session.workspaceId)) : []
  const snapshot = buildStudioResultSnapshot(session, aggregate, [], Date.now(), attempts)
  const audit = aggregate ? buildStudioExecutionAudit({ session, aggregate, attempts }, snapshot) : undefined
  return buildStudioResultExport(snapshot, audit)
}

async function saveStudioResult(
  sender: WebContents,
  json: string,
  exportDigest: string,
  snapshot: Awaited<ReturnType<typeof studioResultSnapshotForSession>>,
  audit?: StudioExecutionAudit
) {
  const win = BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getAllWindows()[0]
  const title = snapshot.workItems[0]?.title ?? snapshot.goal?.title ?? snapshot.workspace?.name ?? 'delivery'
  const result = await dialog.showSaveDialog(win, {
    title: '导出 CaoGen 可移植交付包',
    defaultPath: `caogen-delivery-${safeFileStem(title)}-${new Date(snapshot.generatedAt).toISOString().slice(0, 10)}.zip`,
    filters: [{ name: 'CaoGen delivery package', extensions: ['zip'] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  const creatingRun = [...snapshot.runs]
    .filter((run) => run.sessionId === snapshot.scope.sessionId)
    .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id))
    .at(-1)
  if (!creatingRun || !snapshot.scope.workspaceId) {
    throw new Error('STUDIO_RESULT_RUN_REQUIRED: canonical Project-owned Run is required before saving a delivery report')
  }
  let deliverySummary: StudioDeliverySummary | undefined
  const packageBytes = await buildPortableDeliveryPackage(snapshot, json, exportDigest, audit, value => { deliverySummary = value })
  await writeDurableFile(result.filePath, packageBytes, { replace: true })
  const [binding] = await registerSessionProducedArtifacts({
    sessionId: snapshot.scope.sessionId,
    projectId: snapshot.scope.workspaceId,
    creatingRunId: creatingRun.id,
    producerInvocationId: `studio-result-export:${exportDigest}`,
    artifacts: [{
      kind: 'release_package',
      title: `CaoGen portable delivery package: ${title}`,
      content: { storageKind: 'blob', bytes: packageBytes },
      lineageKey: [
        'studio-result',
        snapshot.scope.level,
        snapshot.scope.workspaceId,
        snapshot.scope.goalId ?? '-',
        snapshot.scope.workItemId ?? '-'
      ].join(':'),
      mediaType: 'application/zip',
      producer: 'studio_result_export',
      // Export receipt verifies package contents; it must not advance the task's business acceptance.
      attachToStage: false,
      metadata: {
        exportDigest,
        resultDigest: snapshot.verification.resultDigest,
        aggregateDigest: snapshot.verification.aggregateDigest,
        scopeLevel: snapshot.scope.level,
        openItems: snapshot.summary.openItems,
        risks: snapshot.summary.risks,
        packageFormat: 'caogen.studio-delivery.v1'
      },
      evidenceKind: 'delivery_check',
      evidenceSummary: 'The saved portable package contains the frozen canonical result, complete sanitized execution audit with source coverage, delivery checklist and byte-verified eligible Artifacts.',
      evidenceVerifier: 'studio-result-export',
      acceptanceCriterion: 'The portable package must preserve the canonical result bytes, manifest, Artifact digests, ownership and available delivery files.',
      externalLocation: {
        kind: 'external',
        uri: pathToFileURL(result.filePath).href,
        metadata: { userExport: true }
      },
      createdAt: snapshot.generatedAt
    }],
    rootInput: {
      workflowRoot: app.getPath('userData'),
      workspaceRoot: app.getPath('userData')
    }
  })
  return {
    canceled: false,
    filePath: result.filePath,
    exportDigest,
    ...deliverySummary,
    workflowArtifactId: binding.artifactId,
    workflowEvidenceId: binding.evidenceId,
    workflowAcceptanceId: binding.acceptanceId
  }
}

function normalizeAction(value: unknown): StudioResultAction {
  if (value === 'get' || value === 'audit' || value === 'export' || value === 'save' || value === 'check_files' || value === 'rerun_preview' || value === 'rerun_confirm') return value
  throw new Error('Studio result action is invalid')
}

function rerunInput(value: unknown): StudioResultRerunInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('局部重跑预览参数无效。')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !['planDigest', 'workItemId'].includes(key)) ||
      typeof record.planDigest !== 'string' || typeof record.workItemId !== 'string') throw new Error('局部重跑预览参数无效。')
  return { planDigest: record.planDigest, workItemId: record.workItemId }
}

function rerunConfirmInput(value: unknown): StudioResultRerunConfirmInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('局部重跑确认参数无效。')
  const { planDigest, workItemId, previewDigest } = value as Record<string, unknown>
  const input = rerunInput({ planDigest, workItemId })
  if (typeof previewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(previewDigest) || Object.keys(value).some(key => !['planDigest', 'workItemId', 'previewDigest'].includes(key))) {
    throw new Error('局部重跑确认参数无效。')
  }
  return { ...input, previewDigest }
}

function auditQuery(value: unknown): StudioAuditTimelineQuery {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Studio audit timeline query is invalid')
  }
  const record = value as Record<string, unknown>
  const unexpected = Object.keys(record).filter((key) => !['runId', 'limit', 'cursor'].includes(key))
  if (unexpected.length > 0) throw new Error('Studio audit timeline query contains unsupported fields')
  if (record.runId !== undefined && typeof record.runId !== 'string') throw new Error('Studio audit timeline Run ID is invalid')
  if (record.limit !== undefined && typeof record.limit !== 'number') throw new Error('Studio audit timeline limit is invalid')
  if (record.cursor !== undefined && typeof record.cursor !== 'string') throw new Error('Studio audit timeline cursor is invalid')
  return {
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    ...(record.limit === undefined ? {} : { limit: record.limit }),
    ...(record.cursor === undefined ? {} : { cursor: record.cursor })
  }
}

function requiredSessionId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('Studio result Session ID is required')
  }
  return value.trim()
}
