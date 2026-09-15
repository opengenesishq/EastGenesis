import { dirname, join, resolve } from 'node:path'
import type { LegacyMemoryImportInput, LegacyMemoryImportResult, LegacyMemoryPreview, LegacyMemoryPreviewEntry } from '../../shared/legacy-memory-import-types'
import type { LearningRecord } from '../../shared/learning-types'
import { readLegacyProjectMemoryEntries, type ProjectMemoryTarget } from '../memoryStore'
import { listMemories } from './memory-manager'
import { projectLearningNamespace } from '../project-aggregate/project-memory-adapter'
import { createLearningDraft, getLearningRecord } from '../learning/learning-lifecycle'
import { learningProjectHash, readLearningState } from '../learning/learning-store'
import { digest } from '../task/workflow-ledger-canonical'

type ImportTarget = ProjectMemoryTarget & { projectId: string }

/** Reads only the legacy namespace of this Session's formal resource directory. */
export async function previewLegacyProjectMemory(target: ProjectMemoryTarget, memoryRoot: string): Promise<LegacyMemoryPreview> {
  const scope = requireTarget(target)
  const [legacy, layered, current] = await Promise.all([
    readLegacyProjectMemoryEntries(scope.projectRoot, memoryRoot),
    listMemories(memoryRoot, { projectRoot: scope.projectRoot }),
    readLearningState(learningRoot(memoryRoot), projectLearningNamespace(scope.projectId))
  ])
  const entries: LegacyMemoryPreviewEntry[] = legacy.map(({ storage, sourceState, entry }) => makeEntry(scope, {
    storage, sourceState, sourceId: entry.id, sourceVersion: entry.version,
    updatedAt: entry.updatedAt, kind: entry.kind, title: entry.title, body: entry.body, source: entry.source, reason: entry.reason
  }, { ...entry, sourceState, storage }))
  for (const entry of layered) {
    if (entry.layer === 'user' || entry.archivedAt) continue
    entries.push(makeEntry(scope, { storage: 'layered', sourceState: 'active', sourceId: entry.id,
      updatedAt: entry.updatedAt, kind: `legacy-${entry.layer}`, title: entry.title, body: entry.body,
      source: entry.source, reason: entry.tags.length ? `原标签: ${entry.tags.join('、')}` : ''
    }, { id: entry.id, layer: entry.layer, projectHash: entry.projectHash, title: entry.title, body: entry.body,
      source: entry.source, tags: entry.tags, createdAt: entry.createdAt, updatedAt: entry.updatedAt }))
  }
  if (new Set(entries.map((entry) => entry.entryKey)).size !== entries.length) throw new Error('旧记忆身份重复，请先修复原始记录。')
  for (const entry of entries) {
    const imported = current.records.find((record) => record.id === importId(scope, entry))
    if (imported) {
      assertImportIdentity(imported, scope, entry)
      entry.imported = { recordId: imported.id, status: imported.status }
    }
  }
  return { schemaVersion: 1, projectId: scope.projectId, sourceDirectory: scope.projectRoot,
    entries: entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.entryKey.localeCompare(b.entryKey)) }
}

/** Explicit adoption creates a draft; replay never restores a deleted/rejected/retired import. */
export async function importLegacyProjectMemory(target: ProjectMemoryTarget, memoryRoot: string,
  input: LegacyMemoryImportInput, assertCurrentTarget: () => void = () => undefined): Promise<LegacyMemoryImportResult> {
  const scope = requireTarget(target)
  if (!input || input.expectedProjectId !== scope.projectId) throw new Error('当前任务所属项目已变化，请重新预览旧记忆。')
  if (!/^[a-f0-9]{64}$/.test(input.entryKey) || !/^[a-f0-9]{64}$/.test(input.sourceDigest)) throw new Error('旧记忆预览身份或摘要无效。')
  const root = learningRoot(memoryRoot)
  const namespace = projectLearningNamespace(scope.projectId)
  const id = importId(scope, input)
  const previous = await getLearningRecord(namespace, root, id)
  assertCurrentTarget()
  if (previous) {
    assertImportIdentity(previous, scope, input)
    return result(previous, true)
  }
  const preview = await previewLegacyProjectMemory(scope, memoryRoot)
  const entry = preview.entries.find((candidate) => candidate.entryKey === input.entryKey)
  if (!entry || entry.sourceDigest !== input.sourceDigest) throw new Error('旧记忆已修改、删除或失效，请重新预览后导入。')
  assertCurrentTarget()
  const source = importSource(scope, input)
  let record: LearningRecord
  try {
    record = await createLearningDraft(namespace, root, {
      kind: 'memory', source, confidence: 0.7,
      payload: { type: 'memory', memoryKind: entry.kind, title: entry.title, body: entry.body,
        reason: importReason(entry, learningProjectHash(scope.projectRoot)) }
    }, { requestedId: id, requestedLogicalId: id,
      actor: { type: 'user', id: 'ipc:memory:legacyImport', source: 'explicit-legacy-memory-import' } })
  } catch (error) {
    // Another request may have created and even approved the same source while
    // this request waited. Its immutable identity is the receipt for this import.
    const concurrent = await getLearningRecord(namespace, root, id)
    if (!concurrent) throw error
    assertImportIdentity(concurrent, scope, input)
    return result(concurrent, true)
  }
  return result(record, false)

  function result(record: LearningRecord, replayed: boolean): LegacyMemoryImportResult {
    return { projectId: scope.projectId, entryKey: input.entryKey, sourceDigest: input.sourceDigest, record, replayed }
  }
}

function requireTarget(target: ProjectMemoryTarget): ImportTarget {
  if (!target?.projectId?.trim()) throw new Error('请先将任务关联到正式项目，再导入旧记忆。')
  if (!target.projectRoot?.trim()) throw new Error('当前任务没有正式资料目录。')
  return { projectId: target.projectId.trim(), projectRoot: resolve(target.projectRoot) }
}

function makeEntry(scope: ImportTarget, entry: Omit<LegacyMemoryPreviewEntry, 'entryKey' | 'sourceDigest' | 'imported'>,
  sourceSnapshot: unknown): LegacyMemoryPreviewEntry {
  return { ...entry, entryKey: digest({ namespace: learningProjectHash(scope.projectRoot), storage: entry.storage, id: entry.sourceId }),
    sourceDigest: digest(sourceSnapshot) }
}

function importId(scope: ImportTarget, entry: Pick<LegacyMemoryPreviewEntry, 'entryKey' | 'sourceDigest'>): string {
  return `legacy-memory-${digest({ projectId: scope.projectId, namespace: learningProjectHash(scope.projectRoot),
    entryKey: entry.entryKey, sourceDigest: entry.sourceDigest })}`
}

function importSource(scope: ImportTarget, entry: Pick<LegacyMemoryPreviewEntry, 'entryKey' | 'sourceDigest'>): string {
  return `legacy-memory-import:${importId(scope, { entryKey: entry.entryKey, sourceDigest: entry.sourceDigest })}`
}

function assertImportIdentity(record: LearningRecord, scope: ImportTarget, entry: Pick<LegacyMemoryPreviewEntry, 'entryKey' | 'sourceDigest'>): void {
  if (record.kind !== 'memory' || record.scope !== 'project' || record.project !== learningProjectHash(projectLearningNamespace(scope.projectId)) ||
      record.source !== importSource(scope, entry)) throw new Error('旧记忆导入回执与当前来源不一致。')
}

function importReason(entry: LegacyMemoryPreviewEntry, namespace: string): string {
  const metadata = [
    `用户从旧目录记忆导入为待确认草稿；原状态: ${entry.sourceState}；原版本: ${entry.sourceVersion ?? 'legacy'}。`,
    `原存储: ${entry.storage}；原记录: ${entry.sourceId}；更新时间: ${entry.updatedAt}。`,
    `来源摘要: ${entry.sourceDigest}；目录命名空间: ${namespace}。`,
    `原来源: ${entry.source}`
  ].join('\n')
  return `${metadata}\n原理由: ${entry.reason}`.slice(0, 2000)
}

function learningRoot(memoryRoot: string): string { return join(dirname(resolve(memoryRoot)), 'learning') }
