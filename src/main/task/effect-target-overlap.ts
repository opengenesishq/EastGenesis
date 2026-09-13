import { realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import type { EffectTarget } from '../../shared/types'

interface FileOverlapOptions {
  canonicalizeRoots?: boolean
}

type OutputFileTarget = Extract<EffectTarget, { kind: 'file_content' | 'office_artifact' | 'office_artifact_revision' }>

export function effectTargetsShareFile(
  left: EffectTarget,
  right: EffectTarget,
  options: FileOverlapOptions = {}
): boolean {
  if (left.kind === 'worktree_patch_apply') {
    return isOutputFileTarget(right) && patchTargetIncludesFile(left, right, options)
  }
  if (right.kind === 'worktree_patch_apply') {
    return isOutputFileTarget(left) && patchTargetIncludesFile(right, left, options)
  }
  if (left.kind === 'code_forge_patch') {
    return isOutputFileTarget(right) && codeForgeTargetIncludesFile(left, right, options)
  }
  if (right.kind === 'code_forge_patch') {
    return isOutputFileTarget(left) && codeForgeTargetIncludesFile(right, left, options)
  }
  if (!isOutputFileTarget(left) || !isOutputFileTarget(right)) return false
  if (left.kind === 'file_content' && right.kind === 'file_content' && samePreFileIdentity(left, right)) return true
  return fileTargetPath(left, options) === fileTargetPath(right, options)
}

function codeForgeTargetIncludesFile(
  patch: Extract<EffectTarget, { kind: 'code_forge_patch' }>,
  file: OutputFileTarget,
  options: FileOverlapOptions
): boolean {
  const worktreeRoot = rootPath(patch.worktreePath, options)
  const fullPath = resolve(rootPath(file.rootPath, options), file.relativePath)
  const relativePath = relative(worktreeRoot, fullPath).split(sep).join('/')
  return !relativePath.startsWith('../') && !relativePath.startsWith('/') && patch.changedPaths.includes(relativePath)
}

function patchTargetIncludesFile(
  patch: Extract<EffectTarget, { kind: 'worktree_patch_apply' }>,
  file: OutputFileTarget,
  options: FileOverlapOptions
): boolean {
  const repoRoot = rootPath(patch.repoRoot, options)
  const fullPath = resolve(rootPath(file.rootPath, options), file.relativePath)
  const relativePath = relative(repoRoot, fullPath).split(sep).join('/')
  return [
    !relativePath.startsWith('../'),
    !relativePath.startsWith('/'),
    patch.changedPaths.includes(relativePath)
  ].every(Boolean)
}

function samePreFileIdentity(
  left: Extract<EffectTarget, { kind: 'file_content' }>,
  right: Extract<EffectTarget, { kind: 'file_content' }>
): boolean {
  if (!left.preFileIdentity || !right.preFileIdentity) return false
  return [
    left.preFileIdentity.device === right.preFileIdentity.device,
    left.preFileIdentity.inode === right.preFileIdentity.inode
  ].every(Boolean)
}

function fileTargetPath(
  target: OutputFileTarget,
  options: FileOverlapOptions
): string {
  return resolve(rootPath(target.rootPath, options), target.relativePath)
}

function isOutputFileTarget(target: EffectTarget): target is OutputFileTarget {
  return target.kind === 'file_content' || (target.kind === 'office_artifact' || target.kind === 'office_artifact_revision')
}

function rootPath(value: string, options: FileOverlapOptions): string {
  return options.canonicalizeRoots ? realpathSync(resolve(value)) : resolve(value)
}
