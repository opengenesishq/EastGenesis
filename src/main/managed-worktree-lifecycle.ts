import { execFileSyncInExecutionEnvironment as execFileSync } from './wsl/process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { app } from 'electron'
import type {
  EffectTarget,
  ManagedWorktreeProjectionRecord,
  WorktreeRemoveResult
} from '../shared/types'
import { isolatedLocalGitEnv, withSafeLocalGitConfig } from './git/safe-git'
import { normalizeDesktopGitPreferences } from '../shared/desktop-git-preferences'
import { getSettings } from './settings'
import { parseWslHostPath } from './wsl/binding'
import { assertManagedWorktreeExecutionPath, wslManagedWorktreePath } from './git/wsl-worktree-path'

const GIT_TIMEOUT_MS = 120_000
const MANAGED_WORKTREE_REGISTRY_SCHEMA_VERSION = 1

export type ManagedWorktreeState = 'active' | 'removed'

export interface ManagedWorktreeRecord extends ManagedWorktreeProjectionRecord {}

interface ManagedWorktreeRegistryDocument {
  schemaVersion: 1
  records: ManagedWorktreeRecord[]
}

export type ManagedWorktreeRegistryRecordLookup =
  | { ok: true; record: ManagedWorktreeRecord | null }
  | { ok: false; error: string }

export interface WorktreePrepareOptions {
  sessionId: string
  cwd: string
  isolated?: boolean
}

export type WorktreePrepareResult =
  | { ok: true; isolated: boolean; cwd: string; record?: ManagedWorktreeRecord }
  | { ok: false; isolated: boolean; cwd: string; error: string }

export type WorktreeOpResult =
  | { ok: true; record: ManagedWorktreeRecord }
  | { ok: false; error: string; record?: ManagedWorktreeRecord }

export type ManagedWorktreeLifecycleEffectTarget = Extract<
  EffectTarget,
  { kind: 'git_worktree_create' | 'git_worktree_remove' }
>

export interface ManagedWorktreeCreateEffectOptions {
  isolated: true
  requested: boolean
}

export interface ManagedWorktreeCreateEffectToolInput {
  sessionId: string
  sourceCwd: string
  worktreePath: string
  branch: string
  baseSha: string
  baseBranch: string | null
  registryRecord: Readonly<ManagedWorktreeRecord>
}

export interface ManagedWorktreeCreateEffectPlan {
  previousRecord?: Readonly<ManagedWorktreeRecord>
  record: Readonly<ManagedWorktreeRecord>
  options: Readonly<ManagedWorktreeCreateEffectOptions>
  toolInput: Readonly<ManagedWorktreeCreateEffectToolInput>
}

export type ManagedWorktreeCreateEffectPlanResult =
  | { ok: true; isolated: false; cwd: string }
  | { ok: true; isolated: true; cwd: string; record: ManagedWorktreeRecord; existing: true }
  | { ok: true; isolated: true; cwd: string; plan: ManagedWorktreeCreateEffectPlan }
  | { ok: false; isolated: boolean; cwd: string; error: string }

export interface ManagedWorktreeRemoveEffectOptions {
  force: boolean
  deleteBranch: boolean
}

export interface ManagedWorktreeRemoveEffectToolInput extends ManagedWorktreeCreateEffectToolInput {
  force: boolean
  deleteBranch: boolean
}

export interface ManagedWorktreeRemoveEffectPlan {
  previousRecord: Readonly<ManagedWorktreeRecord>
  record: Readonly<ManagedWorktreeRecord>
  options: Readonly<ManagedWorktreeRemoveEffectOptions>
  toolInput: Readonly<ManagedWorktreeRemoveEffectToolInput>
}

export type ManagedWorktreeRemoveEffectPlanResult =
  | { ok: true; plan: ManagedWorktreeRemoveEffectPlan }
  | { ok: true; noop: Extract<WorktreeOpResult, { ok: true }> }
  | { ok: false; error: string; record?: ManagedWorktreeRecord }

export type ManagedWorktreeRegistryProjectionState =
  | { kind: 'confirmed'; record: ManagedWorktreeRecord }
  | { kind: 'not_applied'; record?: ManagedWorktreeRecord }
  | { kind: 'unresolved'; reason: string; record?: ManagedWorktreeRecord }

export function listManagedWorktreeRecords(): ManagedWorktreeRecord[] {
  return loadRegistry().sort((left, right) => right.updatedAt - left.updatedAt)
}

export function managedWorktreeRecordForSession(sessionId: string): ManagedWorktreeRecord | null {
  const normalized = normalizeSessionId(sessionId)
  return loadRegistry().find((record) => record.sessionId === normalized) ?? null
}

/**
 * Removes only a terminal registry projection. Active worktrees remain external
 * Git state and must first complete their own remove Effect.
 */
export function purgeRemovedManagedWorktreeRecord(sessionId: string): boolean {
  return purgeRemovedManagedWorktreeRecordAtRoot(sessionId)
}

export function purgeRemovedManagedWorktreeRecordAtRoot(
  sessionId: string,
  userDataRoot?: string
): boolean {
  const normalized = normalizeSessionId(sessionId)
  const records = loadRegistry('mutation', userDataRoot)
  const record = records.find((candidate) => candidate.sessionId === normalized)
  if (!record) return false
  if (record.state !== 'removed') {
    throw new Error('managed worktree is active; complete its remove Effect before deleting the Session')
  }
  saveRegistry(records.filter((candidate) => candidate.sessionId !== normalized), userDataRoot)
  return true
}

export function inspectManagedWorktreeRegistryRecord(
  sessionId: string,
  userDataRoot?: string
): ManagedWorktreeRegistryRecordLookup {
  try {
    const normalized = normalizeSessionId(sessionId)
    const record = loadRegistry('mutation', userDataRoot).find((candidate) => candidate.sessionId === normalized)
    return { ok: true, record: record ? { ...record } : null }
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}

export function inspectManagedWorktreeIdentity(
  record: Readonly<ManagedWorktreeRecord>
): { ok: true } | { ok: false; error: string } {
  try {
    assertManagedWorktreeIdentity(record)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}

interface ManagedWorktreePaths {
  sourceRoot: string
  worktreeRoot: string
}

function assertManagedWorktreeIdentity(record: Readonly<ManagedWorktreeRecord>): void {
  if (record.state !== 'active') throw new Error('managed worktree 不是 active 状态')
  const paths = observeManagedWorktreePaths(record)
  assertManagedWorktreeGitTopology(record, paths.worktreeRoot)
  const sourceCommonDir = canonicalGitPath(record.repoRoot, '--git-common-dir')
  const worktreeCommonDir = canonicalGitPath(record.worktreePath, '--git-common-dir')
  if (sourceCommonDir !== worktreeCommonDir) throw new Error('git common-dir 身份已变化')
}

function observeManagedWorktreePaths(record: Readonly<ManagedWorktreeRecord>): ManagedWorktreePaths {
  const worktreeRoot = realpathSync(record.worktreePath)
  if (worktreeRoot !== resolve(record.worktreePath)) throw new Error('worktree path 已变为符号链接')
  const sourceRoot = realpathSync(record.repoRoot)
  const sourceCwd = realpathSync(record.sourceCwd)
  const worktreeCwd = realpathSync(record.cwd)
  const actualSourceRoot = realpathSync(git(record.repoRoot, ['rev-parse', '--show-toplevel']))
  const actualRoot = realpathSync(git(record.worktreePath, ['rev-parse', '--show-toplevel']))
  const actualCwdRoot = realpathSync(git(record.cwd, ['rev-parse', '--show-toplevel']))
  if (actualSourceRoot !== sourceRoot) throw new Error('source repo root 身份已变化')
  if (actualRoot !== worktreeRoot || actualCwdRoot !== worktreeRoot) {
    throw new Error('worktree root 或 cwd 身份已变化')
  }
  const sourcePrefix = relative(sourceRoot, sourceCwd)
  const worktreePrefix = relative(worktreeRoot, worktreeCwd)
  if (!isContainedRelativePath(sourcePrefix) || sourcePrefix !== worktreePrefix) {
    throw new Error('sourceCwd 与 managed cwd 的子目录映射已变化')
  }
  return { sourceRoot, worktreeRoot }
}

function assertManagedWorktreeGitTopology(
  record: Readonly<ManagedWorktreeRecord>,
  worktreeRoot: string
): void {
  const expectedRef = `refs/heads/${record.branch}`
  const symbolicRef = git(record.worktreePath, ['symbolic-ref', '-q', 'HEAD'])
  const headSha = git(record.worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const branchSha = git(record.repoRoot, ['rev-parse', '--verify', `${expectedRef}^{commit}`])
  const entries = registeredWorktreeEntries(record.repoRoot)
    .filter((entry) => sameCanonicalPath(entry.path, worktreeRoot))
  if (entries.length !== 1) throw new Error('Git worktree registry 条目缺失或重复')
  const entry = entries[0]
  if (entry.detached || entry.prunable) throw new Error('Git worktree registry 已 detached 或 prunable')
  if (symbolicRef !== expectedRef || entry.branch !== expectedRef) throw new Error('worktree branch 身份已变化')
  if (branchSha !== headSha || entry.head !== headSha) {
    throw new Error('worktree HEAD、branch ref 与 registry 条目不一致')
  }
  git(record.repoRoot, ['merge-base', '--is-ancestor', record.baseSha, headSha])
  if (hasInProgressGitOperation(canonicalGitPath(record.worktreePath, '--git-dir'))) {
    throw new Error('worktree 存在未完成 Git 操作')
  }
}

interface RegisteredWorktreeEntry {
  path: string
  head?: string
  branch?: string
  detached: boolean
  prunable: boolean
}

function registeredWorktreeEntries(repoRoot: string): RegisteredWorktreeEntry[] {
  return git(repoRoot, ['worktree', 'list', '--porcelain'])
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/)
      return {
        path: lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length) ?? '',
        head: lines.find((line) => line.startsWith('HEAD '))?.slice('HEAD '.length),
        branch: lines.find((line) => line.startsWith('branch '))?.slice('branch '.length),
        detached: lines.includes('detached'),
        prunable: lines.some((line) => line === 'prunable' || line.startsWith('prunable '))
      }
    })
    .filter((entry) => Boolean(entry.path))
}

function canonicalGitPath(cwd: string, argument: '--git-common-dir' | '--git-dir'): string {
  return realpathSync(resolve(cwd, git(cwd, ['rev-parse', argument])))
}

function isContainedRelativePath(value: string): boolean {
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

function hasInProgressGitOperation(gitDir: string): boolean {
  return [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
    'rebase-merge',
    'rebase-apply',
    'sequencer',
    'index.lock'
  ].some((name) => existsSync(join(gitDir, name)))
}

export function prepareWorktree(opts: WorktreePrepareOptions): WorktreePrepareResult {
  const prepared = prepareManagedWorktreeCreateEffect(opts)
  if ('error' in prepared) return prepared
  if (!prepared.isolated) return prepared
  if ('existing' in prepared) {
    return { ok: true, isolated: true, cwd: prepared.cwd, record: prepared.record }
  }
  return {
    ok: false,
    isolated: true,
    cwd: typeof opts.cwd === 'string' ? opts.cwd : '',
    error: '直接创建 managed worktree 的同步入口已禁用；必须通过 Operation Effect Gateway 执行'
  }
}

export function prepareManagedWorktreeCreateEffect(
  opts: WorktreePrepareOptions
): ManagedWorktreeCreateEffectPlanResult {
  const sourceCwd = typeof opts.cwd === 'string' ? opts.cwd : ''
  const requestedIsolation = opts.isolated === true
  const shouldAutoIsolate = opts.isolated === undefined
  try {
    const sessionId = normalizeSessionId(opts.sessionId)
    const repoRoot = repoRootFor(sourceCwd)
    if (!repoRoot) {
      return requestedIsolation
        ? { ok: false, isolated: true, cwd: sourceCwd, error: '当前目录不是 Git 仓库' }
        : { ok: true, isolated: false, cwd: sourceCwd }
    }
    if (!requestedIsolation && !shouldAutoIsolate) return { ok: true, isolated: false, cwd: sourceCwd }
    return createPlanForRepository(sessionId, sourceCwd, repoRoot, requestedIsolation)
  } catch (err) {
    return { ok: false, isolated: requestedIsolation || shouldAutoIsolate, cwd: sourceCwd, error: errorText(err) }
  }
}

function createPlanForRepository(
  sessionId: string,
  sourceCwd: string,
  repoRoot: string,
  requested: boolean
): ManagedWorktreeCreateEffectPlanResult {
  const records = loadRegistry('mutation')
  const previous = records.find((record) => record.sessionId === sessionId)
  const existing = previous?.state === 'active' ? previous : undefined
  if (existing && existsSync(existing.worktreePath)) {
    assertManagedWorktreeExecutionPath(repoRoot, canonicalGitPath(repoRoot, '--git-common-dir'), existing.worktreePath, sessionId)
    return { ok: true, isolated: true, cwd: existing.cwd, record: { ...existing }, existing: true }
  }
  const branch = `${normalizeDesktopGitPreferences(getSettings().gitPreferences).branchPrefix}/${sessionId}`
  git(repoRoot, ['check-ref-format', '--branch', branch])
  const worktreePath = worktreePathFor(sessionId, repoRoot)
  if (existsSync(worktreePath)) {
    return { ok: false, isolated: true, cwd: sourceCwd, error: `目标 worktree 路径已存在: ${worktreePath}` }
  }
  if (branchExists(repoRoot, branch)) {
    return { ok: false, isolated: true, cwd: sourceCwd, error: `目标 worktree 分支已存在: ${branch}` }
  }
  const baseSha = git(repoRoot, ['rev-parse', 'HEAD'])
  const baseBranch = currentBranchFor(repoRoot)
  const cwd = cwdForWorktree(worktreePath, sourceCwd)
  const now = Date.now()
  const record = freezeRecord({
    sessionId,
    repoRoot,
    sourceCwd,
    worktreePath,
    cwd,
    branch,
    baseSha,
    baseBranch,
    state: 'active',
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  })
  const options = Object.freeze({ isolated: true as const, requested })
  const toolInput = Object.freeze({
    sessionId,
    sourceCwd,
    worktreePath,
    branch,
    baseSha,
    baseBranch,
    registryRecord: record
  })
  return {
    ok: true,
    isolated: true,
    cwd,
    plan: Object.freeze({
      ...(previous ? { previousRecord: freezeRecord(previous) } : {}),
      record,
      options,
      toolInput
    })
  }
}

export function projectManagedWorktreeCreated(plan: ManagedWorktreeCreateEffectPlan): WorktreeOpResult {
  try {
    const records = loadRegistry('mutation')
    const current = records.find((item) => item.sessionId === plan.record.sessionId)
    if (current) {
      if (sameRecord(current, plan.record) && current.state === 'active') return { ok: true, record: { ...current } }
      if (!plan.previousRecord || !sameRecord(current, plan.previousRecord)) {
        return { ok: false, error: 'managed worktree registry 已包含不同生命周期记录，拒绝覆盖', record: current }
      }
    }
    if (!recordMatchesCreatedGitState(plan.record)) {
      return { ok: false, error: 'Git worktree 状态与冻结的 create plan 不匹配，拒绝写入 registry' }
    }
    return saveProjectedRecord(records, { ...plan.record })
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

export function removeManagedWorktree(
  sessionId: string,
  opts: { deleteBranch?: boolean; force?: boolean } = {}
): WorktreeOpResult {
  void sessionId
  void opts
  return {
    ok: false,
    error: '直接移除 managed worktree 的同步入口已禁用；必须通过 Operation Effect Gateway 执行'
  }
}

export function removeManagedWorktreeView(
  sessionId: string,
  opts: { deleteBranch?: boolean; force?: boolean } = {}
): WorktreeRemoveResult {
  const result = removeManagedWorktree(sessionId, opts)
  if (!('error' in result)) return { ok: true, record: { ...result.record } }
  return { ok: false, error: result.error, record: result.record ? { ...result.record } : undefined }
}

export function prepareManagedWorktreeRemoveEffect(
  sessionId: string,
  opts: { deleteBranch?: boolean; force?: boolean } = {}
): ManagedWorktreeRemoveEffectPlanResult {
  try {
    const normalized = normalizeSessionId(sessionId)
    const previous = loadRegistry('mutation').find((item) => item.sessionId === normalized)
    if (!previous) return { ok: false, error: `未找到 session ${normalized} 的 worktree 记录` }
    if (previous.state === 'removed') return { ok: true, noop: { ok: true, record: { ...previous } } }
    const options = Object.freeze({ force: opts.force === true, deleteBranch: opts.deleteBranch === true })
    const previousRecord = freezeRecord(previous)
    const record = freezeRecord({ ...previous, state: 'removed', updatedAt: Date.now() })
    const toolInput = Object.freeze({
      sessionId: previous.sessionId,
      sourceCwd: previous.sourceCwd,
      worktreePath: previous.worktreePath,
      branch: previous.branch,
      baseSha: previous.baseSha,
      baseBranch: previous.baseBranch,
      registryRecord: record,
      force: options.force,
      deleteBranch: options.deleteBranch
    })
    return { ok: true, plan: Object.freeze({ previousRecord, record, options, toolInput }) }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

export function projectManagedWorktreeRemoved(plan: ManagedWorktreeRemoveEffectPlan): WorktreeOpResult {
  try {
    const records = loadRegistry('mutation')
    const current = records.find((item) => item.sessionId === plan.record.sessionId)
    if (!current) return { ok: false, error: 'managed worktree registry 记录已丢失，拒绝重建投影' }
    if (sameRecord(current, plan.record) && current.state === 'removed') return { ok: true, record: { ...current } }
    if (!sameRecord(current, plan.previousRecord)) {
      return { ok: false, error: 'managed worktree registry 已偏离冻结的 remove plan，拒绝覆盖', record: current }
    }
    return saveProjectedRecord(records, { ...plan.record })
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

export function projectConfirmedManagedWorktreeTarget(
  target: ManagedWorktreeLifecycleEffectTarget
): WorktreeOpResult {
  return target.kind === 'git_worktree_create'
    ? projectConfirmedCreate(target)
    : projectConfirmedRemove(target)
}

export function inspectManagedWorktreeRegistryProjection(
  target: ManagedWorktreeLifecycleEffectTarget
): ManagedWorktreeRegistryProjectionState {
  try {
    const record = loadRegistry('mutation').find((item) => item.sessionId === target.sessionId)
    if (!record) return { kind: 'not_applied' }
    if (!recordMatchesTarget(record, target)) {
      return { kind: 'unresolved', reason: 'registry 记录身份与 EffectTarget 不匹配', record }
    }
    return sameRecord(record, target.registryRecord)
      ? { kind: 'confirmed', record }
      : { kind: 'not_applied', record }
  } catch (err) {
    return { kind: 'unresolved', reason: errorText(err) }
  }
}

function projectConfirmedCreate(
  target: Extract<ManagedWorktreeLifecycleEffectTarget, { kind: 'git_worktree_create' }>
): WorktreeOpResult {
  try {
    const records = loadRegistry('mutation')
    const current = records.find((item) => item.sessionId === target.sessionId)
    if (current?.state === 'active') {
      return sameRecord(current, target.registryRecord)
        ? { ok: true, record: { ...current } }
        : { ok: false, error: 'registry active 记录与已确认的 create EffectTarget 不匹配', record: current }
    }
    if (current && !recordMatchesTarget(current, target)) {
      return { ok: false, error: 'registry 历史记录与已确认的 create EffectTarget 不匹配', record: current }
    }
    const record: ManagedWorktreeRecord = { ...target.registryRecord }
    if (!recordMatchesCreatedGitState(record)) {
      return { ok: false, error: '已确认的 create target 与当前 Git worktree 状态不一致' }
    }
    return saveProjectedRecord(records, record)
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

function projectConfirmedRemove(
  target: Extract<ManagedWorktreeLifecycleEffectTarget, { kind: 'git_worktree_remove' }>
): WorktreeOpResult {
  try {
    const records = loadRegistry('mutation')
    const current = records.find((item) => item.sessionId === target.sessionId)
    if (!current) return { ok: false, error: 'remove EffectTarget 对应的 registry 记录已丢失' }
    if (!recordMatchesTarget(current, target)) {
      return { ok: false, error: 'registry 记录与已确认的 remove EffectTarget 不匹配', record: current }
    }
    if (sameRecord(current, target.registryRecord)) return { ok: true, record: { ...current } }
    return saveProjectedRecord(records, { ...target.registryRecord })
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

function recordMatchesTarget(
  record: ManagedWorktreeRecord,
  target: ManagedWorktreeLifecycleEffectTarget
): boolean {
  return record.sessionId === target.sessionId
    && record.repoRoot === target.repoRoot
    && sameCanonicalPath(record.sourceCwd, target.sourceCwd)
    && record.worktreePath === target.worktreePath
    && sameCanonicalPath(record.cwd, target.worktreeCwd)
    && record.branch === target.branch
    && record.baseSha === target.baseSha
    && record.baseBranch === target.baseBranch
    && record.createdAt === target.registryRecord.createdAt
}

function recordMatchesCreatedGitState(record: Readonly<ManagedWorktreeRecord>): boolean {
  if (!existsSync(record.worktreePath)) return false
  const actualRoot = git(record.worktreePath, ['rev-parse', '--show-toplevel'])
  const actualBranch = git(record.worktreePath, ['symbolic-ref', '--short', '-q', 'HEAD'])
  const sourceCommonDir = resolve(record.repoRoot, git(record.repoRoot, ['rev-parse', '--git-common-dir']))
  const worktreeCommonDir = resolve(record.worktreePath, git(record.worktreePath, ['rev-parse', '--git-common-dir']))
  const headSha = git(record.worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'])
  return resolve(actualRoot) === resolve(record.worktreePath)
    && resolve(sourceCommonDir) === resolve(worktreeCommonDir)
    && actualBranch === record.branch
    && headSha === record.baseSha
}

function saveProjectedRecord(
  records: ManagedWorktreeRecord[],
  record: ManagedWorktreeRecord
): Extract<WorktreeOpResult, { ok: true }> {
  upsertRecord(records, record)
  saveRegistry(records)
  return { ok: true, record }
}

type RegistryReadMode = 'query' | 'mutation'

function loadRegistry(mode: RegistryReadMode = 'query', userDataRoot?: string): ManagedWorktreeRecord[] {
  try {
    const raw = JSON.parse(readFileSync(registryFile(userDataRoot), 'utf8')) as unknown
    const values = registryValues(raw)
    if (!values) throw new Error('registry 根节点不是 records 数组')
    return validateRegistryRecords(values)
  } catch (err) {
    if (isMissingFileError(err)) return []
    if (mode === 'mutation') throw new Error(`managed worktree registry 已损坏，拒绝覆盖: ${errorText(err)}`)
    return []
  }
}

function saveRegistry(records: ManagedWorktreeRecord[], userDataRoot?: string): void {
  validateRegistryRecords(records)
  const root = worktreesRoot(userDataRoot)
  mkdirSync(root, { recursive: true })
  const destination = registryFile(userDataRoot)
  const temp = join(root, `.index.json.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temp, 'wx', 0o600)
    const document: ManagedWorktreeRegistryDocument = {
      schemaVersion: MANAGED_WORKTREE_REGISTRY_SCHEMA_VERSION,
      records
    }
    writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temp, destination)
    fsyncRegistryDirectory(root)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temp)) unlinkSync(temp)
  }
}

function registryValues(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw
  if (!raw || typeof raw !== 'object') return null
  const document = raw as { schemaVersion?: unknown; records?: unknown }
  if ('schemaVersion' in document && document.schemaVersion !== MANAGED_WORKTREE_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`Unsupported managed worktree registry schema version: ${String(document.schemaVersion)}`)
  }
  return Array.isArray(document.records) ? document.records : null
}

function validateRegistryRecords(values: unknown[]): ManagedWorktreeRecord[] {
  if (!values.every(isRecord)) throw new Error('registry 含无效或不完整的 worktree 记录')
  const records = values as ManagedWorktreeRecord[]
  const seen = new Set<string>()
  for (const record of records) {
    if (seen.has(record.sessionId)) throw new Error(`registry 含重复 sessionId: ${record.sessionId}`)
    seen.add(record.sessionId)
  }
  return records.map((record) => ({ ...record }))
}

function isRecord(value: unknown): value is ManagedWorktreeRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<ManagedWorktreeRecord>
  return typeof record.sessionId === 'string'
    && typeof record.repoRoot === 'string'
    && typeof record.sourceCwd === 'string'
    && typeof record.worktreePath === 'string'
    && typeof record.cwd === 'string'
    && typeof record.branch === 'string'
    && typeof record.baseSha === 'string'
    && (typeof record.baseBranch === 'string' || record.baseBranch === null)
    && (record.state === 'active' || record.state === 'removed')
    && typeof record.createdAt === 'number'
    && typeof record.updatedAt === 'number'
}

function sameRecord(left: ManagedWorktreeRecord, right: Readonly<ManagedWorktreeRecord>): boolean {
  return left.sessionId === right.sessionId
    && left.repoRoot === right.repoRoot
    && left.sourceCwd === right.sourceCwd
    && left.worktreePath === right.worktreePath
    && left.cwd === right.cwd
    && left.branch === right.branch
    && left.baseSha === right.baseSha
    && left.baseBranch === right.baseBranch
    && left.state === right.state
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
}

function sameCanonicalPath(left: string, right: string): boolean {
  try {
    return canonicalPlannedPath(left) === canonicalPlannedPath(right)
  } catch {
    return false
  }
}

function upsertRecord(records: ManagedWorktreeRecord[], record: ManagedWorktreeRecord): void {
  const index = records.findIndex((item) => item.sessionId === record.sessionId)
  if (index >= 0) records[index] = record
  else records.push(record)
}

function worktreesRoot(userDataRoot?: string): string {
  return join(userDataRoot ? resolve(userDataRoot) : app.getPath('userData'), 'worktrees')
}

function registryFile(userDataRoot?: string): string {
  return join(worktreesRoot(userDataRoot), 'index.json')
}

function worktreePathFor(sessionId: string, repoRoot: string): string {
  if (parseWslHostPath(repoRoot)) {
    return canonicalPlannedPath(wslManagedWorktreePath(repoRoot, canonicalGitPath(repoRoot, '--git-common-dir'), safePathSegment(sessionId))!)
  }
  return canonicalPlannedPath(join(worktreesRoot(), safePathSegment(sessionId)))
}

function canonicalPlannedPath(input: string): string {
  let cursor = resolve(input)
  const missing: string[] = []
  while (!existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) throw new Error(`找不到 planned path 的既存父目录: ${input}`)
    missing.unshift(basename(cursor))
    cursor = parent
  }
  return join(realpathSync(cursor), ...missing)
}

function safePathSegment(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe && safe === sessionId && safe !== '.' && safe !== '..') return safe
  const hash = createHash('sha1').update(sessionId).digest('hex').slice(0, 8)
  const prefix = safe && safe !== '.' && safe !== '..' ? safe : 'session'
  return `${prefix}-${hash}`
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim()
  if (!normalized) throw new Error('sessionId 不能为空')
  return normalized
}

function cwdForWorktree(worktreePath: string, sourceCwd: string): string {
  const subdir = git(sourceCwd, ['rev-parse', '--show-prefix']).replace(/[\\/]+$/, '')
  return subdir ? join(worktreePath, subdir) : worktreePath
}

function currentBranchFor(repoRoot: string): string | null {
  try {
    return git(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD']) || null
  } catch {
    return null
  }
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    execFileSync('git', withSafeLocalGitConfig(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]), {
      cwd: repoRoot,
      env: isolatedLocalGitEnv(process.env),
      stdio: 'ignore',
      timeout: GIT_TIMEOUT_MS
    })
    return true
  } catch {
    return false
  }
}

function repoRootFor(cwd: string): string | null {
  if (!cwd) return null
  try {
    if (git(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null
    return realpathSync(resolve(git(cwd, ['rev-parse', '--show-toplevel'])))
  } catch {
    return null
  }
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', withSafeLocalGitConfig(args), {
      cwd,
      env: isolatedLocalGitEnv(process.env),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS
    }).trim()
  } catch (err) {
    throw new Error(`git ${args.join(' ')} failed: ${errorText(err)}`)
  }
}

function fsyncRegistryDirectory(root: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(root, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function isMissingFileError(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

function freezeRecord(record: ManagedWorktreeRecord): Readonly<ManagedWorktreeRecord> {
  return Object.freeze({ ...record })
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const output = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string }
  const stderr = output.stderr ? String(output.stderr).trim() : ''
  const stdout = output.stdout ? String(output.stdout).trim() : ''
  return stderr || stdout || err.message
}
