import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { EffectTarget, SessionMeta } from '../shared/types'
import type { WorkspaceHandoffReceipt, WorkspaceHandoffView } from '../shared/workspace-handoff-types'
import { writeDurableFileSync } from './durable-file'
import { assertTaskExecutionEnvironment, assertWslBinding, createWslBinding, parseWslHostPath } from './wsl/binding'
import { captureHandoffFiles, handoffHash, handoffGit, sameHandoffContents, transferHandoffFiles,
  assertHandoffFilesCurrent, assertTransferredHandoffFiles, type HandoffFiles } from './git/workspace-handoff-files'
import { buildManagedWorktreeCreateTarget, executeManagedWorktreeCreateTarget, reconcileManagedWorktreeCreateTarget, type ManagedWorktreeCreateTarget } from './git/managed-worktree-effect'
import { inspectManagedWorktreeIdentity, managedWorktreeRecordForSession, prepareManagedWorktreeCreateEffect,
  projectManagedWorktreeCreated, type ManagedWorktreeCreateEffectPlan, type ManagedWorktreeRecord } from './managed-worktree-lifecycle'
import { confirmed, notApplied, unresolved, type EffectReconciliationResult } from './task/effect-reconciliation-result'

interface HandoffJournal {
  schemaVersion: 1
  id: string
  sessionId: string
  createdAt: number
  sourceMeta: SessionMeta
  direction: 'worktree' | 'local'
  source: HandoffFiles
  target?: HandoffFiles
  record: ManagedWorktreeRecord
  createPlan?: ManagedWorktreeCreateEffectPlan
  createTarget?: ManagedWorktreeCreateTarget
  phase: 'prepared' | 'files_committed' | 'committed'
  receipt?: WorkspaceHandoffReceipt
  planDigest: string
}
export type WorkspaceHandoffTarget = Extract<EffectTarget, { kind: 'workspace_handoff' }>
const token = (value: string) => handoffHash(value)
function rootDir(root = app.getPath('userData')): string { return join(root, 'workspace-handoffs') }
function journalPath(root: string, id: string): string { return join(rootDir(root), `${token(id)}.json`) }
function pointerPath(root: string, id: string): string { return join(rootDir(root), `session-${token(id)}.json`) }
function blobsDir(root: string): string { return join(rootDir(root), 'blobs') }
function planDigest(journal: Omit<HandoffJournal, 'planDigest'> | HandoffJournal): string {
  return handoffHash({ id: journal.id, sessionId: journal.sessionId, createdAt: journal.createdAt, sourceMeta: journal.sourceMeta,
    direction: journal.direction, source: journal.source, record: journal.record, createPlan: journal.createPlan, createTarget: journal.createTarget,
    // For creation, the clean destination is verified against the frozen create target after it exists.
    target: journal.createPlan ? undefined : journal.target })
}
function readJournal(root: string, id: string): HandoffJournal {
  const { integrityDigest, ...journal } = JSON.parse(readFileSync(journalPath(root, id), 'utf8')) as HandoffJournal & { integrityDigest: string }
  if (integrityDigest !== handoffHash(journal)) throw new Error('工作目录交接记录字节校验失败。')
  if (journal.schemaVersion !== 1 || journal.id !== id || journal.sourceMeta?.id !== journal.sessionId || journal.planDigest !== planDigest(journal) ||
      !['prepared', 'files_committed', 'committed'].includes(journal.phase)) throw new Error('工作目录交接记录损坏，已阻止继续。')
  return journal
}
function currentJournal(root: string, sessionId: string): HandoffJournal | undefined {
  let pointer: { id: string; sessionId: string }
  try { pointer = JSON.parse(readFileSync(pointerPath(root, sessionId), 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  if (pointer.sessionId !== sessionId || typeof pointer.id !== 'string') throw new Error('工作目录交接索引损坏。')
  const journal = readJournal(root, pointer.id)
  if (journal.sessionId !== sessionId) throw new Error('工作目录交接索引身份不一致。')
  return journal
}
function writeJournal(root: string, journal: HandoffJournal): void {
  writeDurableFileSync(journalPath(root, journal.id), JSON.stringify({ ...journal, integrityDigest: handoffHash(journal) }))
}
function assertOwner(meta: SessionMeta, journal: HandoffJournal): void {
  for (const key of ['id', 'sdkSessionId', 'createdAt', 'workspaceId', 'goalId', 'workItemId', 'parentSessionId', 'businessLineId'] as const) {
    if (meta[key] !== journal.sourceMeta[key]) throw new Error(`工作目录交接任务归属不一致：${key}`)
  }
}

/** Freeze every source byte and destination precondition before the first repository mutation. */
export function prepareWorkspaceHandoff(meta: SessionMeta, root = app.getPath('userData')): WorkspaceHandoffTarget {
  assertTaskExecutionEnvironment(meta)
  const previous = currentJournal(root, meta.id)
  if (previous && (previous.phase !== 'committed' || meta.workspaceHandoff?.id !== previous.id)) { assertOwner(meta, previous); return targetFor(previous, root) }
  const direction: 'local' | 'worktree' = meta.isolated ? 'local' : 'worktree'
  const source = captureHandoffFiles(meta.cwd, blobsDir(root))
  let record = managedWorktreeRecordForSession(meta.id) ?? undefined
  let createPlan: ManagedWorktreeCreateEffectPlan | undefined
  let createTarget: ManagedWorktreeCreateTarget | undefined
  if (!record) {
    if (direction !== 'worktree') throw new Error('受管 Worktree 身份缺失，不能交接。')
    const prepared = prepareManagedWorktreeCreateEffect({ sessionId: meta.id, cwd: meta.cwd, isolated: true })
    if ('error' in prepared) throw new Error(prepared.error)
    if (!prepared.isolated || !('plan' in prepared)) throw new Error('Worktree 创建计划不可用。')
    createPlan = prepared.plan
    createTarget = buildManagedWorktreeCreateTarget(meta.cwd, { ...createPlan.toolInput })
    record = { ...createPlan.record }
  } else {
    const identity = inspectManagedWorktreeIdentity(record)
    if (!identity.ok) throw new Error('error' in identity ? identity.error : 'Worktree 身份不可用。')
  }
  const target = createPlan ? undefined : captureHandoffFiles(direction === 'local' ? record.sourceCwd : record.cwd, blobsDir(root))
  if (target) {
    if (target.commonDir !== source.commonDir || target.root === source.root) throw new Error('交接目录不属于同一个仓库的不同工作区。')
    const baseline = previous?.source
    if (baseline?.root === target.root) {
      if (!sameHandoffContents(baseline, target) || baseline.ref !== target.ref || baseline.identity !== target.identity) throw new Error('目标目录在上次离开后已有新改动，请先合并或保存这些改动再交接。')
    } else if (target.head !== record.baseSha || target.indexTree !== handoffGit(target.root, ['rev-parse', `${record.baseSha}^{tree}`]) ||
        handoffGit(target.root, ['status', '--porcelain=v1', '--untracked-files=all'])) {
      throw new Error('原目录含独立改动，无法安全覆盖；请先核对并合并这些改动。')
    }
  }
  const body = { schemaVersion: 1 as const, id: randomUUID(), sessionId: meta.id, createdAt: Date.now(), sourceMeta: structuredClone(meta),
    direction, source, target, record, createPlan, createTarget, phase: 'prepared' as const }
  const journal: HandoffJournal = { ...body, planDigest: planDigest(body) }
  writeJournal(root, journal)
  writeDurableFileSync(pointerPath(root, meta.id), JSON.stringify({ sessionId: meta.id, id: journal.id }))
  return targetFor(journal, root)
}
function targetFor(journal: HandoffJournal, root: string): WorkspaceHandoffTarget {
  return { kind: 'workspace_handoff', sessionId: journal.sessionId, journalId: journal.id, journalDigest: journal.planDigest,
    userDataRoot: root, repoRoot: journal.record.repoRoot, worktreePath: journal.record.worktreePath, direction: journal.direction }
}
export function buildWorkspaceHandoffTarget(input: Record<string, unknown>): WorkspaceHandoffTarget {
  if (Object.keys(input).sort().join(',') !== 'journalId,sessionId') throw new Error('交接请求参数无效。')
  if (typeof input.journalId !== 'string' || typeof input.sessionId !== 'string') throw new Error('交接请求身份缺失。')
  const root = app.getPath('userData'), journal = readJournal(root, input.journalId)
  if (journal.sessionId !== input.sessionId || currentJournal(root, input.sessionId)?.id !== journal.id) throw new Error('交接请求已过期。')
  return targetFor(journal, root)
}
function matchingJournal(target: WorkspaceHandoffTarget): HandoffJournal {
  const journal = readJournal(target.userDataRoot, target.journalId)
  if (handoffHash(targetFor(journal, target.userDataRoot)) !== handoffHash(target)) throw new Error('交接效果与冻结记录不一致。')
  return journal
}
export function executeWorkspaceHandoffTarget(target: WorkspaceHandoffTarget): { ok: true } {
  let journal = matchingJournal(target)
  if (journal.phase === 'committed') return { ok: true }
  assertTaskExecutionEnvironment(journal.sourceMeta)
  assertHandoffFilesCurrent(journal.source)
  if (!journal.target) {
    if (!journal.createTarget || !journal.createPlan) throw new Error('交接缺少目标目录。')
    const existing = managedWorktreeRecordForSession(journal.sessionId)
    if (!existing) {
      if (reconcileManagedWorktreeCreateTarget(journal.createTarget).kind !== 'confirmed') {
        const created = executeManagedWorktreeCreateTarget(journal.createTarget)
        if (created.ok === false) throw new Error(created.error)
      }
      const projected = projectManagedWorktreeCreated(journal.createPlan)
      if (projected.ok === false) throw new Error(projected.error)
    }
    const destination = captureHandoffFiles(journal.record.cwd, blobsDir(target.userDataRoot))
    if (destination.head !== journal.createTarget.baseSha || handoffGit(destination.root, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('新建 Worktree 已被其他操作修改。')
    journal = { ...journal, target: destination }
    writeJournal(target.userDataRoot, journal)
  }
  transferHandoffFiles(journal.source, journal.target!, blobsDir(target.userDataRoot))
  journal = { ...journal, phase: 'files_committed' }
  writeJournal(target.userDataRoot, journal)
  assertTransferredHandoffFiles(journal.source, journal.target!)
  const receipt: WorkspaceHandoffReceipt = { schemaVersion: 1, id: journal.id, sessionId: journal.sessionId, direction: journal.direction,
    fromCwd: journal.sourceMeta.cwd, toCwd: journal.direction === 'local' ? journal.record.sourceCwd : journal.record.cwd,
    createdAt: journal.createdAt, committedAt: Date.now(), fileCount: journal.source.files.length, state: 'committed' }
  writeJournal(target.userDataRoot, { ...journal, phase: 'committed', receipt })
  return { ok: true }
}
export function reconcileWorkspaceHandoffTarget(target: WorkspaceHandoffTarget): EffectReconciliationResult {
  try {
    const journal = matchingJournal(target)
    if (journal.phase === 'committed' && journal.receipt && journal.target) {
      assertTransferredHandoffFiles(journal.source, journal.target)
      return confirmed({ journalId: journal.id, digest: journal.planDigest }, '工作目录与 Git 暂存状态已交接，同一任务位置回执已持久化。')
    }
    if (!journal.createPlan && journal.target) {
      try { assertHandoffFilesCurrent(journal.target); return notApplied({ journalId: journal.id }, '目标工作区仍保持交接前状态。') } catch { /* partial application is resumable */ }
    }
    return unresolved({ journalId: journal.id, phase: journal.phase, reason: '工作目录交接尚未完成，请在原任务重试同一次交接。' })
  } catch (error) { return unresolved({ reason: errorText(error) }) }
}

/** The durable placement decision wins over stale history or active registry projections. */
export function restoreWorkspaceHandoff(meta: SessionMeta, root = app.getPath('userData')): SessionMeta {
  const journal = currentJournal(root, meta.id)
  if (!journal) return meta
  assertOwner(meta, journal)
  if (journal.phase !== 'committed' || !journal.receipt) return { ...meta, workspaceHandoffPending: journal.id }
  const record = journal.record
  const previousEnvironment = meta.executionEnvironment
  const destination = parseWslHostPath(journal.receipt.toCwd)
  if (previousEnvironment?.kind === 'wsl' && destination?.distribution !== previousEnvironment.distribution) {
    throw new Error('工作目录交接不能切换任务已固定的 WSL 发行版。')
  }
  if (previousEnvironment?.kind !== 'wsl' && destination) throw new Error('宿主机任务不能通过工作目录交接隐式进入 WSL。')
  let executionEnvironment = previousEnvironment
  if (previousEnvironment?.kind === 'wsl') {
    assertWslBinding(previousEnvironment)
    if (previousEnvironment.hostCwd !== journal.receipt.toCwd) {
      if (!journal.target) throw new Error('WSL 交接回执缺少目标目录身份。')
      const stats = lstatSync(journal.target.root, { bigint: true })
      if (`${stats.dev}:${stats.ino}` !== journal.target.identity) throw new Error('WSL 交接目标目录身份已变化。')
      executionEnvironment = createWslBinding(previousEnvironment.distribution, journal.receipt.toCwd)
    }
  }
  return { ...meta, cwd: journal.receipt.toCwd, isolated: journal.direction === 'worktree',
    executionEnvironment,
    sourceCwd: record.sourceCwd, repoRoot: record.repoRoot, worktreePath: record.worktreePath, branch: record.branch,
    baseBranch: record.baseBranch, baseSha: record.baseSha, worktreeState: record.state,
    workspaceHandoff: journal.receipt, workspaceHandoffPending: undefined }
}
export function assertWorkspaceHandoffReady(meta: SessionMeta): void {
  const restored = restoreWorkspaceHandoff(meta)
  if (restored.workspaceHandoffPending) throw new Error('工作目录交接尚未完成，请打开 Worktree 面板重试原交接。')
  if (restored.cwd !== meta.cwd || restored.workspaceHandoff?.id !== meta.workspaceHandoff?.id) throw new Error('工作目录已有持久交接记录，请恢复原任务后继续。')
}
export function workspaceHandoffAllowsLocal(meta: SessionMeta, record: ManagedWorktreeRecord): boolean {
  if (meta.isolated === true) return false
  const journal = currentJournal(app.getPath('userData'), meta.id)
  if (!journal) return false
  assertOwner(meta, journal)
  return journal.record.worktreePath === record.worktreePath && meta.cwd === record.sourceCwd &&
    ((journal.phase === 'committed' && journal.direction === 'local') || (journal.phase !== 'committed' && journal.sourceMeta.isolated !== true))
}
export function workspaceHandoffView(meta: SessionMeta): WorkspaceHandoffView {
  const journal = currentJournal(app.getPath('userData'), meta.id)
  return { sessionId: meta.id, current: meta.isolated ? 'worktree' : 'local', pending: Boolean(journal && journal.phase !== 'committed'),
    destination: meta.isolated ? meta.sourceCwd : meta.worktreePath,
    lastReceipt: journal?.receipt ?? meta.workspaceHandoff }
}
export function isWorkspaceHandoffTarget(value: Record<string, unknown>): boolean {
  return ['sessionId', 'journalId', 'journalDigest', 'userDataRoot', 'repoRoot', 'worktreePath'].every(key => typeof value[key] === 'string' && Boolean(value[key])) &&
    ['worktree', 'local'].includes(String(value.direction)) && /^[a-f0-9]{64}$/.test(String(value.journalDigest)) && resolve(String(value.userDataRoot)) === value.userDataRoot
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
