import { domainEffectTargetsConflict } from './effect-domain-conflict'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { EffectTarget, FileSystemIdentity } from '../../shared/types'
import { effectTargetsShareFile } from './effect-target-overlap'

type FileContentTarget = Extract<EffectTarget, { kind: 'file_content' }>
type OfficeArtifactTarget = Extract<EffectTarget, { kind: 'office_artifact' | 'office_artifact_revision' }>
type OutputFileTarget = FileContentTarget | OfficeArtifactTarget
type GitCommitTarget = Extract<EffectTarget, { kind: 'git_commit' }>
type GitIndexTarget = Extract<EffectTarget, { kind: 'git_index_update' }>
type GitMergeTarget = Extract<EffectTarget, { kind: 'git_merge' }>
type WorktreePatchTarget = Extract<EffectTarget, { kind: 'worktree_patch_apply' }>
type CodeForgePatchTarget = Extract<EffectTarget, { kind: 'code_forge_patch' }>
type WorktreeLifecycleTarget = Extract<
  EffectTarget,
  { kind: 'git_worktree_create' | 'git_worktree_remove' }
>

export function effectTargetsConflict(left: EffectTarget, right: EffectTarget): boolean {
  if (domainEffectTargetsConflict(left, right)) return true
  if (targetsShareFile(left, right)) return true
  if (opaqueFileTargetsConflict(left, right)) return true
  if (left.kind === 'git_index_update') return gitIndexTargetConflicts(left, right)
  if (right.kind === 'git_index_update') return gitIndexTargetConflicts(right, left)
  if (left.kind === 'code_forge_patch') return codeForgeTargetConflicts(left, right)
  if (right.kind === 'code_forge_patch') return codeForgeTargetConflicts(right, left)
  if (isWorktreeLifecycleTarget(left)) return worktreeLifecycleConflicts(left, right)
  if (isWorktreeLifecycleTarget(right)) return worktreeLifecycleConflicts(right, left)
  return false
}

function targetsShareFile(left: EffectTarget, right: EffectTarget): boolean {
  try {
    return effectTargetsShareFile(left, right, { canonicalizeRoots: true })
  } catch {
    return effectTargetsShareFile(left, right)
  }
}

function opaqueFileTargetsConflict(left: EffectTarget, right: EffectTarget): boolean {
  return (
    (isOpaqueFileEdit(left) && isFileEdit(right)) ||
    (isOpaqueFileEdit(right) && isFileEdit(left))
  )
}

function isFileEdit(target: EffectTarget): boolean {
  return target.kind === 'file_content' || (target.kind === 'office_artifact' || target.kind === 'office_artifact_revision') || isOpaqueFileEdit(target)
}

function isOpaqueFileEdit(target: EffectTarget): boolean {
  return (
    target.kind === 'unsupported' &&
    (target.toolName === 'search_replace' || target.toolName === 'edit_file')
  )
}

function gitIndexTargetConflicts(index: GitIndexTarget, other: EffectTarget): boolean {
  if (isOpaqueFileEdit(other)) return index.worktreeReadScope !== 'none'
  if (other.kind === 'git_index_update') return sameIndexWorktree(index, other)
  if (other.kind === 'git_commit') return sameCommitWorktree(index, other)
  if (other.kind === 'git_merge') return sameMergeWorktree(index, other)
  if (isOutputFileTarget(other)) return indexReadsFile(index, other)
  if (other.kind === 'worktree_patch_apply') return indexReadsPatchPaths(index, other)
  if (isWorktreeLifecycleTarget(other)) return worktreeLifecycleConflicts(other, index)
  return false
}

function worktreeLifecycleConflicts(lifecycle: WorktreeLifecycleTarget, other: EffectTarget): boolean {
  if (isWorktreeLifecycleTarget(other)) return sameGitCommonDir(lifecycle, other)
  const paths = [resolve(lifecycle.repoRoot), resolve(lifecycle.worktreePath)]
  if (other.kind === 'git_index_update') {
    return paths.includes(resolve(other.repoRoot)) || lifecycleGitDirMatchesIndex(lifecycle, other)
  }
  if (other.kind === 'git_commit' || other.kind === 'git_merge') {
    return paths.includes(resolve(other.repoRoot))
  }
  if (isOutputFileTarget(other)) {
    return pathIsInside(lifecycle.worktreePath, resolve(other.rootPath, other.relativePath))
  }
  if (other.kind === 'git_push' || other.kind === 'pull_request_create' || other.kind === 'issue_create') {
    return paths.includes(resolve(other.repoRoot))
  }
  if (other.kind === 'worktree_patch_apply') {
    return paths.includes(resolve(other.repoRoot)) || paths.includes(resolve(other.worktreePath))
  }
  if (other.kind === 'code_forge_patch') {
    return paths.includes(resolve(other.repoRoot)) || paths.includes(resolve(other.worktreePath))
  }
  return false
}

function codeForgeTargetConflicts(patch: CodeForgePatchTarget, other: EffectTarget): boolean {
  if (other.kind === 'code_forge_patch') {
    if (resolve(patch.artifactPath) === resolve(other.artifactPath)) return true
    return samePath(patch.worktreePath, other.worktreePath) && pathsOverlap(patch.changedPaths, other.changedPaths)
  }
  if (other.kind === 'worktree_patch_apply') {
    return samePath(patch.worktreePath, other.repoRoot) && pathsOverlap(patch.changedPaths, other.changedPaths)
  }
  if (other.kind === 'git_commit' || other.kind === 'git_merge') {
    return samePath(patch.worktreePath, other.repoRoot)
  }
  if (other.kind === 'git_index_update') {
    if (!samePath(patch.worktreePath, other.repoRoot) || other.operation === 'unstage_paths') return false
    return other.operation === 'stage_all' || pathsOverlap(patch.changedPaths, other.paths)
  }
  if (isWorktreeLifecycleTarget(other)) return worktreeLifecycleConflicts(other, patch)
  return false
}

function pathsOverlap(left: string[], right: string[]): boolean {
  const values = new Set(left)
  return right.some((value) => values.has(value))
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right)
}

function pathIsInside(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate))
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

function lifecycleGitDirMatchesIndex(
  lifecycle: WorktreeLifecycleTarget,
  index: GitIndexTarget
): boolean {
  if (sameStoredLocation(
    lifecycle.sourceWorktreeGitDir,
    lifecycle.sourceWorktreeGitDirIdentity,
    index.worktreeGitDir,
    index.worktreeGitDirIdentity
  )) return true
  if (lifecycle.kind !== 'git_worktree_remove') return false
  return sameStoredLocation(
    lifecycle.worktreeGitDir,
    lifecycle.worktreeGitDirIdentity,
    index.worktreeGitDir,
    index.worktreeGitDirIdentity
  )
}

function sameGitCommonDir(left: WorktreeLifecycleTarget, right: WorktreeLifecycleTarget): boolean {
  return sameStoredLocation(
    left.gitCommonDir,
    left.gitCommonDirIdentity,
    right.gitCommonDir,
    right.gitCommonDirIdentity
  )
}

function isWorktreeLifecycleTarget(target: EffectTarget): target is WorktreeLifecycleTarget {
  return target.kind === 'git_worktree_create' || target.kind === 'git_worktree_remove'
}

function sameIndexWorktree(left: GitIndexTarget, right: GitIndexTarget): boolean {
  return sameStoredLocation(
    left.worktreeGitDir,
    left.worktreeGitDirIdentity,
    right.worktreeGitDir,
    right.worktreeGitDirIdentity
  )
}

function sameCommitWorktree(index: GitIndexTarget, commit: GitCommitTarget): boolean {
  return resolve(index.repoRoot) === resolve(commit.repoRoot)
}

function sameMergeWorktree(index: GitIndexTarget, merge: GitMergeTarget): boolean {
  return sameStoredLocation(
    index.worktreeGitDir,
    index.worktreeGitDirIdentity,
    merge.worktreeGitDir,
    merge.worktreeGitDirIdentity
  )
}

function indexReadsFile(index: GitIndexTarget, file: OutputFileTarget): boolean {
  const relativePath = relativeGitPath(index.repoRoot, resolve(file.rootPath, file.relativePath))
  return relativePath !== undefined && indexReadsPath(index, relativePath)
}

function indexReadsPatchPaths(index: GitIndexTarget, patch: WorktreePatchTarget): boolean {
  if (!sameWorktreeRoot(index, patch)) return false
  if (index.operation === 'unstage_paths') return false
  if (index.operation === 'stage_all') return true
  const indexPaths = new Set(index.paths)
  return patch.changedPaths.some((path) => indexPaths.has(path))
}

function indexReadsPath(index: GitIndexTarget, relativePath: string): boolean {
  if (index.operation === 'unstage_paths') return false
  if (index.operation === 'stage_all') return true
  return index.paths.includes(relativePath)
}

function sameWorktreeRoot(index: GitIndexTarget, patch: WorktreePatchTarget): boolean {
  return sameStoredLocation(
    index.repoRoot,
    index.repoRootIdentity,
    patch.repoRoot,
    patch.repoRootIdentity
  )
}

function sameStoredLocation(
  leftPath: string,
  leftIdentity: FileSystemIdentity,
  rightPath: string,
  rightIdentity: FileSystemIdentity
): boolean {
  return sameIdentity(leftIdentity, rightIdentity) || resolve(leftPath) === resolve(rightPath)
}

function sameIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function relativeGitPath(root: string, fullPath: string): string | undefined {
  const value = relative(resolve(root), resolve(fullPath))
  if (!value || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) return undefined
  return value.split(sep).join('/')
}

function isOutputFileTarget(target: EffectTarget): target is OutputFileTarget {
  return target.kind === 'file_content' || target.kind === 'office_artifact' || target.kind === 'office_artifact_revision'
}
