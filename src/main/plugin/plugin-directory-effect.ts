import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { EffectTarget, FileSystemIdentity } from '../../shared/effect-types'
import type { PluginInstallResult, PluginUninstallResult } from '../../shared/types'
import {
  confirmed,
  notApplied,
  unresolved,
  type EffectReconciliationResult
} from '../task/effect-reconciliation-result'

const MAX_COPY_BYTES = 200 * 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_TREE_ENTRIES = 50_000
const CONTROL_DIR = '.caogen-operations'
const TRASH_DIR = '.trash'
const EXCLUDED_DIRECTORY_NAMES = new Set(['.git', 'node_modules'])

export type ManagedPluginInstallTarget = Extract<EffectTarget, { kind: 'managed_plugin_install' }>
export type ManagedPluginUninstallTarget = Extract<EffectTarget, { kind: 'managed_plugin_uninstall' }>

export interface PluginDirectorySnapshot {
  digest: string
  files: number
  bytes: number
}

export interface PreparedPluginInstall {
  sourcePath: string
  rootPath: string
  operationCwd: string
  pluginName: string
  expected: PluginDirectorySnapshot
  overwrite: boolean
  transitionId: string
}

export interface PreparedPluginUninstall {
  rootPath: string
  operationCwd: string
  pluginName: string
  transitionId: string
}

export type PluginTransitionCheckpoint = 'staged' | 'previous_trashed' | 'installed' | 'uninstalled'

export interface PluginTransitionHooks {
  checkpoint?(name: PluginTransitionCheckpoint): void
}

type DirectoryObservation =
  | { state: 'absent' }
  | { state: 'directory'; identity: FileSystemIdentity; snapshot: PluginDirectorySnapshot }
  | { state: 'other' }

type RootDirectoryObservation =
  | { state: 'absent' }
  | { state: 'directory'; identity: FileSystemIdentity }
  | { state: 'other' }

interface ManagedRootObservation {
  rootPath: string
  rootAnchorPath: string
  rootAnchorIdentity: FileSystemIdentity
  rootPreState: 'absent' | 'directory'
  rootIdentity?: FileSystemIdentity
}

export function preparePluginInstall(
  sourceDir: string,
  pluginsRoot: string,
  overwrite: boolean,
  transitionId: string
): PreparedPluginInstall | PluginInstallResult {
  try {
    requireTransitionId(transitionId)
    const sourcePath = canonicalExistingDirectory(sourceDir)
    const root = inspectManagedRoot(pluginsRoot)
    if (containsPath(sourcePath, root.rootPath)) {
      return { ok: false, error: '插件源目录不能包含托管插件目录，请选择具体插件目录' }
    }
    if (!looksLikePlugin(sourcePath)) {
      return { ok: false, error: '该目录不像插件:需要 plugin.json / SKILL.md / agent .md 之一' }
    }
    const nameBefore = installName(sourcePath)
    const first = snapshotPluginDirectory(sourcePath)
    const nameAfter = installName(sourcePath)
    const second = snapshotPluginDirectory(sourcePath)
    if (nameBefore !== nameAfter || !sameSnapshot(first, second)) {
      return { ok: false, error: '插件源目录在准备期间发生变化，请稳定目录后重试' }
    }
    if (sourcePath === join(root.rootPath, nameAfter)) {
      return { ok: false, error: '源目录已在插件目录内,无需安装' }
    }
    return {
      sourcePath,
      rootPath: root.rootPath,
      operationCwd: root.rootAnchorPath,
      pluginName: nameAfter,
      expected: second,
      overwrite,
      transitionId
    }
  } catch (error) {
    return { ok: false, error: safePreparationError(error, '插件目录无法安全读取') }
  }
}

export function preparePluginUninstall(
  targetPath: string,
  pluginsRoot: string,
  transitionId: string
): PreparedPluginUninstall | PluginUninstallResult {
  try {
    requireTransitionId(transitionId)
    if (typeof targetPath !== 'string' || !targetPath.trim()) return { ok: false, error: '路径无效' }
    const logicalRoot = resolve(pluginsRoot)
    const logicalTarget = resolve(targetPath)
    const rel = relative(logicalRoot, logicalTarget)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) {
      return { ok: false, error: '只能卸载托管插件目录内的直接子目录' }
    }
    const pluginName = requirePluginName(rel)
    const root = inspectManagedRoot(pluginsRoot)
    return { rootPath: root.rootPath, operationCwd: root.rootAnchorPath, pluginName, transitionId }
  } catch (error) {
    return { ok: false, error: safePreparationError(error, '插件卸载目标无效') }
  }
}

export function pluginInstallToolInput(prepared: PreparedPluginInstall): Record<string, unknown> {
  return {
    pluginName: prepared.pluginName,
    rootPath: prepared.rootPath,
    expectedDigest: prepared.expected.digest,
    expectedFiles: prepared.expected.files,
    expectedBytes: prepared.expected.bytes,
    overwrite: prepared.overwrite,
    transitionId: prepared.transitionId
  }
}

export function pluginUninstallToolInput(prepared: PreparedPluginUninstall): Record<string, unknown> {
  return { rootPath: prepared.rootPath, pluginName: prepared.pluginName, transitionId: prepared.transitionId }
}

export function isManagedPluginEffectToolName(toolName: string): boolean {
  return toolName === 'managed_plugin_install' || toolName === 'managed_plugin_uninstall'
}

export function buildManagedPluginEffectTarget(
  cwd: string,
  toolName: string,
  toolInput: Record<string, unknown>
): ManagedPluginInstallTarget | ManagedPluginUninstallTarget {
  const root = inspectManagedRoot(requireRootPath(toolInput.rootPath))
  if (canonicalExistingDirectory(cwd) !== root.rootAnchorPath) {
    throw new Error('托管插件根锚点与操作作用域不匹配')
  }
  const pluginName = requirePluginName(toolInput.pluginName)
  const transitionId = requireTransitionId(toolInput.transitionId)
  const target = observeDirectory(join(root.rootPath, pluginName))
  if (toolName === 'managed_plugin_install') {
    return buildInstallTarget(root, target, pluginName, transitionId, toolInput)
  }
  if (toolName === 'managed_plugin_uninstall') {
    return buildUninstallTarget(root, target, pluginName, transitionId)
  }
  throw new Error('未知托管插件 Effect 工具')
}

export function executeManagedPluginInstallTarget(
  target: ManagedPluginInstallTarget,
  sourcePath: string,
  hooks: PluginTransitionHooks = {}
): PluginInstallResult {
  try {
    const source = snapshotPluginDirectory(sourcePath)
    if (!matchesExpected(source, target)) return installFailure('插件源目录已变化，请重新选择后安装')
    const rootError = prepareRootForExecution(target)
    if (rootError) return installFailure(rootError)
    if (!matchesInstallPrecondition(target)) return installFailure('插件目标状态已变化，请刷新后重试')

    const stagingPath = resolveControlPath(target.rootPath, target.stagingRelativePath)
    const trashPath = target.trashRelativePath
      ? resolveControlPath(target.rootPath, target.trashRelativePath)
      : undefined
    if (observeDirectory(stagingPath).state !== 'absent') {
      return installFailure('检测到未完成的插件安装 staging，请先在恢复面板对账')
    }
    if (trashPath && observeDirectory(trashPath).state !== 'absent') {
      return installFailure('冻结的插件回收站目标已存在，请先在恢复面板对账')
    }

    mkdirSync(dirname(stagingPath), { recursive: true })
    cpSync(sourcePath, stagingPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (candidate) => shouldCopyPluginPath(sourcePath, candidate)
    })
    const staged = observeDirectory(stagingPath)
    if (!isExpectedDirectory(staged, target)) return installFailure('插件 staging 与冻结源摘要不一致')
    hooks.checkpoint?.('staged')

    if (!matchesInstallPrecondition(target)) return installFailure('复制期间插件目标发生变化，已停止切换')
    if (target.targetPreState === 'directory') {
      if (!trashPath) return installFailure('覆盖安装缺少冻结回收站目标')
      mkdirSync(dirname(trashPath), { recursive: true })
      renameSync(join(target.rootPath, target.pluginName), trashPath)
      const trashed = observeDirectory(trashPath)
      if (!matchesInstallPreDirectory(trashed, target)) {
        return installFailure('旧插件移动后摘要或身份不一致')
      }
      hooks.checkpoint?.('previous_trashed')
    }

    renameSync(stagingPath, join(target.rootPath, target.pluginName))
    hooks.checkpoint?.('installed')
    const final = reconcileManagedPluginEffectTarget(target)
    if (final.kind !== 'confirmed') return installFailure('插件安装后置条件未唯一成立，请人工对账')
    return { ok: true, installedPath: join(target.rootPath, target.pluginName), name: target.pluginName }
  } catch {
    return installFailure('插件安装执行中断，请在恢复面板确认目录状态')
  }
}

export function executeManagedPluginUninstallTarget(
  target: ManagedPluginUninstallTarget,
  hooks: PluginTransitionHooks = {}
): PluginUninstallResult {
  try {
    const rootError = prepareRootForExecution(target)
    if (rootError) return uninstallFailure(rootError)
    if (!matchesUninstallPrecondition(target)) return uninstallFailure('插件目标状态已变化，请刷新后重试')
    const trashPath = resolveControlPath(target.rootPath, target.trashRelativePath)
    if (observeDirectory(trashPath).state !== 'absent') {
      return uninstallFailure('冻结的插件回收站目标已存在，请先在恢复面板对账')
    }
    mkdirSync(dirname(trashPath), { recursive: true })
    renameSync(join(target.rootPath, target.pluginName), trashPath)
    hooks.checkpoint?.('uninstalled')
    const final = reconcileManagedPluginEffectTarget(target)
    if (final.kind !== 'confirmed') return uninstallFailure('插件卸载后置条件未唯一成立，请人工对账')
    return { ok: true, trashedTo: trashPath }
  } catch {
    return uninstallFailure('插件卸载执行中断，请在恢复面板确认目录状态')
  }
}

export function reconcileManagedPluginEffectTarget(
  target: ManagedPluginInstallTarget | ManagedPluginUninstallTarget
): EffectReconciliationResult {
  try {
    const anchor = currentIdentity(target.rootAnchorPath)
    if (!anchor || !sameIdentity(anchor, target.rootAnchorIdentity)) {
      return unresolved({ kind: target.kind, state: 'root_anchor_changed', reason: '托管插件根锚点身份已变化' })
    }
    if (target.kind === 'managed_plugin_install') return reconcileInstall(target)
    return reconcileUninstall(target)
  } catch (error) {
    return unresolved({
      kind: target.kind,
      state: 'observation_failed',
      reason: error instanceof Error ? error.message : String(error)
    })
  }
}

export function snapshotPluginDirectory(dir: string): PluginDirectorySnapshot {
  const root = canonicalExistingDirectory(dir)
  const hash = createHash('sha256')
  let files = 0
  let bytes = 0
  let entries = 0

  const walk = (current: string, prefix: string): void => {
    const children = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const child of children) {
      if (child.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(child.name)) continue
      entries += 1
      if (entries > MAX_TREE_ENTRIES) throw new Error('插件目录条目过多')
      const fullPath = join(current, child.name)
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name
      const before = lstatSync(fullPath)
      if (before.isSymbolicLink()) throw new Error('插件目录不允许符号链接')
      if (before.isDirectory()) {
        hash.update(`D\0${relativePath}\0${before.mode & 0o777}\n`)
        walk(fullPath, relativePath)
        continue
      }
      if (!before.isFile()) throw new Error('插件目录包含不支持的特殊文件')
      if (before.size > MAX_COPY_BYTES - bytes) throw new Error('插件目录超过 200MB 上限')
      const content = readFileSync(fullPath)
      const after = lstatSync(fullPath)
      if (!stableFileObservation(before, after, content.byteLength)) {
        throw new Error('插件文件在读取期间发生变化')
      }
      files += 1
      bytes += content.byteLength
      if (bytes > MAX_COPY_BYTES) throw new Error('插件目录超过 200MB 上限')
      hash.update(`F\0${relativePath}\0${before.mode & 0o777}\0${content.byteLength}\0`)
      hash.update(createHash('sha256').update(content).digest('hex'))
      hash.update('\n')
    }
  }

  walk(root, '')
  return { digest: hash.digest('hex'), files, bytes }
}

function buildInstallTarget(
  root: ManagedRootObservation,
  target: DirectoryObservation,
  pluginName: string,
  transitionId: string,
  input: Record<string, unknown>
): ManagedPluginInstallTarget {
  if (target.state === 'other') throw new Error('同名插件目标不是普通目录')
  const overwrite = input.overwrite === true
  if (target.state === 'directory' && !overwrite) throw new Error(`已存在同名插件 ${pluginName};确认覆盖后重试`)
  const expectedDigest = requireDigest(input.expectedDigest)
  const expectedFiles = requireNonNegativeInt(input.expectedFiles, 'expectedFiles')
  const expectedBytes = requireNonNegativeInt(input.expectedBytes, 'expectedBytes')
  const base = {
    kind: 'managed_plugin_install' as const,
    ...root,
    pluginName,
    expectedDigest,
    expectedFiles,
    expectedBytes,
    stagingRelativePath: `${CONTROL_DIR}/${transitionId}-stage`
  }
  if (target.state === 'absent') return { ...base, targetPreState: 'absent' }
  return {
    ...base,
    targetPreState: 'directory',
    targetPreIdentity: target.identity,
    targetPreDigest: target.snapshot.digest,
    targetPreFiles: target.snapshot.files,
    targetPreBytes: target.snapshot.bytes,
    trashRelativePath: `${TRASH_DIR}/${pluginName}-${transitionId}`
  }
}

function buildUninstallTarget(
  root: ManagedRootObservation,
  target: DirectoryObservation,
  pluginName: string,
  transitionId: string
): ManagedPluginUninstallTarget {
  if (root.rootPreState !== 'directory' || !root.rootIdentity) throw new Error('托管插件目录不存在')
  if (target.state !== 'directory') throw new Error('插件目录不存在或不是普通目录')
  return {
    kind: 'managed_plugin_uninstall',
    rootPath: root.rootPath,
    rootAnchorPath: root.rootAnchorPath,
    rootAnchorIdentity: root.rootAnchorIdentity,
    rootIdentity: root.rootIdentity,
    pluginName,
    targetPreIdentity: target.identity,
    targetPreDigest: target.snapshot.digest,
    targetPreFiles: target.snapshot.files,
    targetPreBytes: target.snapshot.bytes,
    trashRelativePath: `${TRASH_DIR}/${pluginName}-${transitionId}`
  }
}

function reconcileInstall(target: ManagedPluginInstallTarget): EffectReconciliationResult {
  const root = observeRootDirectory(target.rootPath)
  if (root.state === 'other') {
    return unresolved({ kind: target.kind, state: 'root_not_directory', reason: '托管插件根路径不是普通目录' })
  }
  if (target.rootPreState === 'directory') {
    if (root.state !== 'directory' || !target.rootIdentity || !sameIdentity(root.identity, target.rootIdentity)) {
      return unresolved({ kind: target.kind, state: 'root_identity_changed', reason: '托管插件根目录身份已变化' })
    }
  }
  const active = root.state === 'directory'
    ? observeDirectory(join(target.rootPath, target.pluginName))
    : { state: 'absent' as const }
  const staged = root.state === 'directory'
    ? observeDirectory(resolveControlPath(target.rootPath, target.stagingRelativePath))
    : { state: 'absent' as const }
  const trashed = root.state === 'directory' && target.trashRelativePath
    ? observeDirectory(resolveControlPath(target.rootPath, target.trashRelativePath))
    : { state: 'absent' as const }
  const state = transitionState(active, staged, trashed)

  if (installPostconditionMatches(active, staged, trashed, target)) {
    return confirmed(state, '托管插件安装的活动目录与回收站后置条件均成立')
  }
  if (installPreconditionRemains(active, staged, trashed, target)) {
    return notApplied(state, '托管插件活动目录仍保持完整前置状态')
  }
  return unresolved({ ...state, reason: '托管插件安装处于部分完成或外部冲突状态' })
}

function installPostconditionMatches(
  active: DirectoryObservation,
  staged: DirectoryObservation,
  trashed: DirectoryObservation,
  target: ManagedPluginInstallTarget
): boolean {
  if (!isExpectedDirectory(active, target) || staged.state !== 'absent') return false
  return target.targetPreState === 'absent'
    ? trashed.state === 'absent'
    : matchesInstallPreDirectory(trashed, target)
}

function installPreconditionRemains(
  active: DirectoryObservation,
  staged: DirectoryObservation,
  trashed: DirectoryObservation,
  target: ManagedPluginInstallTarget
): boolean {
  return matchesInstallPreDirectory(active, target) &&
    staged.state === 'absent' &&
    trashed.state === 'absent'
}

function reconcileUninstall(target: ManagedPluginUninstallTarget): EffectReconciliationResult {
  const root = observeRootDirectory(target.rootPath)
  if (root.state !== 'directory' || !sameIdentity(root.identity, target.rootIdentity)) {
    return unresolved({ kind: target.kind, state: 'root_identity_changed', reason: '托管插件根目录身份已变化' })
  }
  const active = observeDirectory(join(target.rootPath, target.pluginName))
  const trashed = observeDirectory(resolveControlPath(target.rootPath, target.trashRelativePath))
  const state = transitionState(active, { state: 'absent' }, trashed)
  if (active.state === 'absent' && matchesUninstallPreDirectory(trashed, target)) {
    return confirmed(state, '托管插件已原子移动到冻结回收站目标')
  }
  if (matchesUninstallPreDirectory(active, target) && trashed.state === 'absent') {
    return notApplied(state, '托管插件仍保持完整前置状态')
  }
  return unresolved({ ...state, reason: '托管插件卸载处于部分完成或外部冲突状态' })
}

function inspectManagedRoot(inputPath: string): ManagedRootObservation {
  const resolved = resolveThroughExistingAnchor(inputPath)
  const root = observeRootDirectory(resolved.rootPath)
  if (root.state === 'other') throw new Error('托管插件根路径不是普通目录')
  if (root.state === 'directory') {
    return {
      rootPath: resolved.rootPath,
      rootAnchorPath: resolved.rootPath,
      rootAnchorIdentity: root.identity,
      rootPreState: 'directory',
      rootIdentity: root.identity
    }
  }
  return {
    rootPath: resolved.rootPath,
    rootAnchorPath: resolved.anchorPath,
    rootAnchorIdentity: resolved.anchorIdentity,
    rootPreState: 'absent'
  }
}

function resolveThroughExistingAnchor(inputPath: string): {
  rootPath: string
  anchorPath: string
  anchorIdentity: FileSystemIdentity
} {
  let cursor = resolve(inputPath)
  const suffix: string[] = []
  while (!existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) throw new Error('无法定位托管插件根锚点')
    suffix.unshift(basename(cursor))
    cursor = parent
  }
  const anchorPath = realpathSync(cursor)
  const anchorStat = statSync(anchorPath)
  if (!anchorStat.isDirectory()) throw new Error('托管插件根锚点不是目录')
  return {
    rootPath: resolve(anchorPath, ...suffix),
    anchorPath,
    anchorIdentity: identityFromStat(anchorStat)
  }
}

function prepareRootForExecution(
  target: ManagedPluginInstallTarget | ManagedPluginUninstallTarget
): string | undefined {
  const anchor = currentIdentity(target.rootAnchorPath)
  if (!anchor || !sameIdentity(anchor, target.rootAnchorIdentity)) return '托管插件根锚点身份已变化'
  const current = observeRootDirectory(target.rootPath)
  if (target.kind === 'managed_plugin_uninstall' || target.rootPreState === 'directory') {
    const expectedIdentity = target.kind === 'managed_plugin_uninstall'
      ? target.rootIdentity
      : target.rootIdentity
    if (current.state !== 'directory' || !expectedIdentity || !sameIdentity(current.identity, expectedIdentity)) {
      return '托管插件根目录身份已变化'
    }
    return undefined
  }
  if (current.state !== 'absent') return '托管插件根路径在执行前被其他进程创建或替换'
  mkdirSync(target.rootPath, { recursive: true })
  if (realpathSync(target.rootPath) !== target.rootPath) return '托管插件根路径包含执行期符号链接替换'
  return undefined
}

function matchesInstallPrecondition(target: ManagedPluginInstallTarget): boolean {
  return matchesInstallPreDirectory(observeDirectory(join(target.rootPath, target.pluginName)), target)
}

function matchesInstallPreDirectory(
  observation: DirectoryObservation,
  target: ManagedPluginInstallTarget
): boolean {
  if (target.targetPreState === 'absent') return observation.state === 'absent'
  return observation.state === 'directory' &&
    target.targetPreIdentity !== undefined &&
    sameIdentity(observation.identity, target.targetPreIdentity) &&
    observation.snapshot.digest === target.targetPreDigest &&
    observation.snapshot.files === target.targetPreFiles &&
    observation.snapshot.bytes === target.targetPreBytes
}

function matchesUninstallPrecondition(target: ManagedPluginUninstallTarget): boolean {
  return matchesUninstallPreDirectory(observeDirectory(join(target.rootPath, target.pluginName)), target)
}

function matchesUninstallPreDirectory(
  observation: DirectoryObservation,
  target: ManagedPluginUninstallTarget
): boolean {
  return observation.state === 'directory' &&
    sameIdentity(observation.identity, target.targetPreIdentity) &&
    observation.snapshot.digest === target.targetPreDigest &&
    observation.snapshot.files === target.targetPreFiles &&
    observation.snapshot.bytes === target.targetPreBytes
}

function isExpectedDirectory(
  observation: DirectoryObservation,
  target: ManagedPluginInstallTarget
): boolean {
  return observation.state === 'directory' && matchesExpected(observation.snapshot, target)
}

function matchesExpected(
  snapshot: PluginDirectorySnapshot,
  target: ManagedPluginInstallTarget
): boolean {
  return snapshot.digest === target.expectedDigest &&
    snapshot.files === target.expectedFiles &&
    snapshot.bytes === target.expectedBytes
}

function observeDirectory(path: string): DirectoryObservation {
  if (!existsSync(path)) return { state: 'absent' }
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { state: 'other' }
  return {
    state: 'directory',
    identity: identityFromStat(stat),
    snapshot: snapshotPluginDirectory(path)
  }
}

function observeRootDirectory(path: string): RootDirectoryObservation {
  if (!existsSync(path)) return { state: 'absent' }
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { state: 'other' }
  return { state: 'directory', identity: identityFromStat(stat) }
}

function transitionState(
  active: DirectoryObservation,
  staged: DirectoryObservation,
  trashed: DirectoryObservation
): Record<string, unknown> {
  return {
    active: observationSummary(active),
    staged: observationSummary(staged),
    trashed: observationSummary(trashed)
  }
}

function observationSummary(observation: DirectoryObservation): Record<string, unknown> {
  return observation.state === 'directory'
    ? { state: observation.state, digest: observation.snapshot.digest, files: observation.snapshot.files, bytes: observation.snapshot.bytes }
    : { state: observation.state }
}

function resolveControlPath(rootPath: string, relativePath: string): string {
  const target = resolve(rootPath, relativePath)
  const rel = relative(rootPath, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('插件控制路径逃逸托管根目录')
  return target
}

function shouldCopyPluginPath(sourceRoot: string, candidate: string): boolean {
  const rel = relative(sourceRoot, candidate)
  if (!rel) return true
  return !rel.split(sep).some((part) => EXCLUDED_DIRECTORY_NAMES.has(part))
}

function canonicalExistingDirectory(path: string): string {
  if (typeof path !== 'string' || !path.trim() || !existsSync(path)) throw new Error('请选择一个存在的目录')
  const canonical = realpathSync(resolve(path))
  if (!statSync(canonical).isDirectory()) throw new Error('请选择一个存在的目录')
  return canonical
}

function looksLikePlugin(dir: string): boolean {
  if (existsSync(join(dir, 'plugin.json'))) return true
  if (existsSync(join(dir, '.caogen-plugin', 'plugin.json'))) return true
  if (existsSync(join(dir, 'SKILL.md'))) return true
  return readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isFile() && entry.name.endsWith('.md'))
}

function installName(sourceDir: string): string {
  let name = basename(sourceDir)
  for (const manifestPath of [join(sourceDir, 'plugin.json'), join(sourceDir, '.caogen-plugin', 'plugin.json')]) {
    try {
      const manifestStat = lstatSync(manifestPath)
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) continue
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      if (typeof parsed.name === 'string' && parsed.name.trim()) {
        name = parsed.name.trim()
        break
      }
    } catch {
      // A missing or malformed manifest falls back to the source directory name.
    }
  }
  const sanitized = name
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80) || 'plugin'
  return requirePluginName(sanitized)
}

function requirePluginName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('插件名不是安全的单段目录名')
  const normalized = value.toLowerCase()
  if (normalized === TRASH_DIR || normalized === CONTROL_DIR) throw new Error('插件名与托管控制目录冲突')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    throw new Error('插件名不是安全的单段目录名')
  }
  return value
}

function containsPath(parentPath: string, candidatePath: string): boolean {
  const rel = relative(parentPath, candidatePath)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function requireTransitionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) {
    throw new Error('插件 transitionId 无效')
  }
  return value
}

function requireRootPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) {
    throw new Error('托管插件根路径无效')
  }
  return value
}

function requireDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('插件目录摘要无效')
  return value
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} 无效`)
  return value as number
}

function identityFromStat(stat: { dev: number | bigint; ino: number | bigint }): FileSystemIdentity {
  return { device: String(stat.dev), inode: String(stat.ino) }
}

function currentIdentity(path: string): FileSystemIdentity | undefined {
  if (!existsSync(path)) return undefined
  const stat = lstatSync(path)
  return stat.isDirectory() && !stat.isSymbolicLink() ? identityFromStat(stat) : undefined
}

function sameIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function stableFileObservation(
  before: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number },
  after: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number },
  bytes: number
): boolean {
  return String(before.dev) === String(after.dev) &&
    String(before.ino) === String(after.ino) &&
    before.size === after.size &&
    before.size === bytes &&
    before.mtimeMs === after.mtimeMs
}

function sameSnapshot(left: PluginDirectorySnapshot, right: PluginDirectorySnapshot): boolean {
  return left.digest === right.digest && left.files === right.files && left.bytes === right.bytes
}

function safePreparationError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  return /^(请选择|插件|托管)/.test(message) ? message : fallback
}

function installFailure(error: string): PluginInstallResult {
  return { ok: false, error }
}

function uninstallFailure(error: string): PluginUninstallResult {
  return { ok: false, error }
}
