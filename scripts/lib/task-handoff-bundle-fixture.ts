import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openProjectWorkspaceStore } from '../../src/main/project-workspace/store'
import { openProjectWorkspaceCommandService } from '../../src/main/project-workspace/command-service'
import { ensureManagedPersonalWorkspace, MANAGED_PERSONAL_WORKSPACE_ID } from '../../src/main/project-workspace/managed-personal-workspace'
import { buildTaskSnapshot, saveTaskSnapshot } from '../../src/main/task/task-snapshot'
import { registerPersistedArtifactLifecycle } from '../../src/main/task/artifact-lifecycle-api'
import { historyStoreDocument } from '../../src/main/history-store-format'
import type { SessionMeta, HistoryEntry, TaskRunRecord } from '../../src/shared/types'
import { prepareEffect, markEffectExecuting, completeEffect } from '../../src/main/task/effect-ledger'
import { stableValueDigest } from '../../src/main/task/tool-idempotency'

/** Real stores and local bytes only; no Engine, Provider or network dependency. */
export async function seedTaskHandoffFixture(root: string, cwd: string, prefix = 'handoff', personal = false) {
  mkdirSync(root, { recursive: true }); mkdirSync(cwd, { recursive: true })
  const sessionId = `${prefix}-session`, projectId = personal ? MANAGED_PERSONAL_WORKSPACE_ID : `${prefix}-project`,
    goalId = `${prefix}-goal`, workItemId = `${prefix}-item`, now = 1_800_000_000_000
  const store = await openProjectWorkspaceStore(root)
  if (personal) await ensureManagedPersonalWorkspace(root)
  else await store.createWorkspace({ id: projectId, name: 'Handoff fixture', kind: 'software', ownerId: 'fixture-user' })
  const commands = await openProjectWorkspaceCommandService(root)
  await commands.createGoal({ id: goalId, projectId, title: 'Handoff', objective: 'Preserve task history', status: 'planned' })
  await commands.createWorkItem({ id: workItemId, projectId, goalId, businessLineId: 'studio', type: 'testing', title: 'Handoff', status: 'ready', owner: { type: 'human', id: 'fixture-user' } })
  const meta = { id: sessionId, title: 'Handoff fixture', cwd, workspaceId: projectId, goalId, workItemId,
    ...(personal ? { unassigned: true, personalWorkspaceId: projectId } : {}),
    engine: 'openai', model: 'fixture-model', providerId: 'fixture-provider', taskStrategy: 'plan', permissionMode: 'plan',
    digitalWorkerBinding: { kind: 'unscoped' }, status: 'idle', costUsd: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, contextTokens: 0, createdAt: now } as SessionMeta
  let run: TaskRunRecord = { schemaVersion: 1, id: `${prefix}-run-a`, sessionId, taskId: sessionId, status: 'executing', revision: 1, attempt: 1, recoveryCount: 0, createdAt: now, updatedAt: now, digitalWorkerBinding: { kind: 'unscoped' } }
  const target = { kind: 'file_content' as const, rootPath: cwd, relativePath: 'synthetic-effect.txt', preState: 'absent' as const, expectedSha256: 'a'.repeat(64), expectedBytes: 8 }
  const prepared = prepareEffect(run, { sessionId, cwd, toolUseId: `${prefix}-tool`, toolName: 'write_file', ownerId: 'fixture-owner', now,
    descriptor: { target, targetDigest: stableValueDigest(target), intentDigest: stableValueDigest({ synthetic: true }), inputDigest: stableValueDigest({ content: 'fixture' }), reconcilability: 'queryable' } })
  run = markEffectExecuting(prepared.run, prepared.handle, now + 1)
  run = { ...completeEffect(run, prepared.handle, 'confirmed', 'b'.repeat(64), 'synthetic fixture', now + 2), status: 'failed' }
  run = JSON.parse(JSON.stringify(run)) as TaskRunRecord
  await saveTaskSnapshot(buildTaskSnapshot({ meta, transcript: [], lastSeq: 0, eventCount: 0, reason: 'created', run, now }), root)
  await commands.updateWorkItem(workItemId, { runRefs: [run.id] })
  const artifactId = `${prefix}-artifact`, artifactPath = join(cwd, 'deliverable.txt')
  writeFileSync(artifactPath, 'Frozen deliverable bytes')
  await registerPersistedArtifactLifecycle({ id: artifactId, projectId, goalId, workItemId, runId: run.id, lineageId: `${prefix}-deliverable`,
    kind: 'document', title: 'Deliverable', version: 1, provenance: 'explicit', retention: { mode: 'retain' }, content: { storageKind: 'source_ref', sourceRef: artifactPath }, createdAt: now }, root)
  const history = { ...meta, id: sessionId, title: meta.title!, sdkSessionId: `${prefix}-sdk`, model: meta.model, providerId: meta.providerId, updatedAt: now, costUsd: 0 } as HistoryEntry
  writeFileSync(join(root, 'sessions.json'), JSON.stringify(historyStoreDocument([history])))
  const attachmentDir = join(root, 'attachments', sessionId); mkdirSync(attachmentDir, { recursive: true }); writeFileSync(join(attachmentDir, 'source.txt'), 'original source')
  return { root, cwd, sessionId, projectId, goalId, workItemId, now, meta, history, run, artifactId, artifactPath, commands }
}
