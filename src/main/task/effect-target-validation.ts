import { isOfficeRevisionTarget } from '../office-revision/target-validation'
import type { EffectTarget, FileSystemIdentity } from '../../shared/types'
import { isManagedPluginEffectTarget } from '../plugin/plugin-effect-target-validation'
import { isAbsolute } from 'node:path'

export function isEffectTarget(value: unknown): value is EffectTarget {
  if (!isRecord(value)) return false
  if (value.kind === 'gui_postcondition') return isGuiPostconditionTarget(value)
  if (value.kind === 'file_content') return isFileContentTarget(value)
  if (value.kind === 'git_commit') return isGitCommitTarget(value)
  if (value.kind === 'git_index_update') return isGitIndexUpdateTarget(value)
  if (value.kind === 'git_merge') return isGitMergeTarget(value)
  if (value.kind === 'git_push') return isGitPushTarget(value)
  if (value.kind === 'worktree_patch_apply') return isWorktreePatchTarget(value)
  if (value.kind === 'code_forge_patch') return isCodeForgePatchTarget(value)
  if (value.kind === 'git_worktree_create') return isGitWorktreeCreateTarget(value)
  if (value.kind === 'git_worktree_remove') return isGitWorktreeRemoveTarget(value)
  if (value.kind === 'managed_plugin_install' || value.kind === 'managed_plugin_uninstall') {
    return isManagedPluginEffectTarget(value)
  }
  if (value.kind === 'pull_request_create') return isPullRequestTarget(value)
  if (value.kind === 'issue_create') return isIssueTarget(value)
  if (value.kind === 'mcp_tool_call') return isMcpToolCallTarget(value)
  if (value.kind === 'webhook_message_send') return isWebhookMessageTarget(value)
  const office = OFFICE_TARGET_VALIDATORS[String(value.kind)]
  if (office) return office(value)
  if (value.kind === 'migration_operation') return isMigrationOperationTarget(value)
  if (value.kind === 'project_portable_export') return isProjectPortableExportTarget(value)
  if (value.kind === 'project_portable_import') return isProjectPortableImportTarget(value)
  if (value.kind === 'project_permanent_deletion') return isProjectPermanentDeletionTarget(value)
  if (value.kind === 'provider_profile_operation') return isProviderProfileOperationTarget(value)
  if (value.kind === 'media_job_operation') return isMediaJobOperationTarget(value)
  return value.kind === 'unsupported' && isString(value.toolName)
}

function isMediaJobOperationTarget(record: Record<string, unknown>): boolean {
  const operations = ['submit', 'poll', 'download', 'cancel', 'asset_import', 'compose']
  const statuses = ['submitting', 'running', 'downloading', 'succeeded', 'failed', 'cancelled', 'waiting_reconciliation']
  const identifiers = [
    'mediaJobId', 'externalJobId', 'projectId', 'goalId', 'workItemId', 'runId'
  ]
  const artifactFields = ['artifactId', 'evidenceId', 'acceptanceId']
  const hasArtifactFields = artifactFields.every((key) => isString(record[key]))
  const noArtifactFields = artifactFields.every((key) => record[key] === undefined)
  return operations.includes(String(record.operation)) && statuses.includes(String(record.expectedStatus)) &&
    identifiers.every((key) => isString(record[key])) && isSha256(record.idempotencyKeyDigest) &&
    (['download', 'asset_import', 'compose'].includes(String(record.operation)) ? hasArtifactFields : hasArtifactFields || noArtifactFields)
}

function isProviderProfileOperationTarget(record: Record<string, unknown>): boolean {
  const operations = ['profile_import', 'backup_restore', 'backup_delete', 'sync_publish', 'sync_apply']
  const transports = ['local', 'folder', 'webdav', 's3']
  const identifiers = [
    'projectId', 'goalId', 'workItemId', 'runId', 'artifactId', 'evidenceId', 'acceptanceId'
  ]
  return operations.includes(String(record.operation)) && transports.includes(String(record.transport)) &&
    identifiers.every((key) => isString(record[key])) &&
    (record.operation !== 'backup_delete' || isSha256(record.backupIdDigest))
}

function isProjectPortableExportTarget(record: Record<string, unknown>): boolean {
  const keys = [
    'projectId', 'goalId', 'workItemId', 'runId', 'artifactId', 'evidenceId', 'acceptanceId'
  ]
  return record.format === 'caogen.project-aggregate.v1' && keys.every((key) => isString(record[key]))
}

function isProjectPortableImportTarget(record: Record<string, unknown>): boolean {
  const keys = [
    'operationId', 'importedProjectId', 'projectId', 'goalId', 'workItemId', 'runId',
    'artifactId', 'evidenceId', 'acceptanceId'
  ]
  return record.format === 'caogen.project-aggregate.v1' && keys.every((key) => isString(record[key])) &&
    isSha256(record.exportDigest) && isSha256(record.sourceAggregateDigest)
}

function isProjectPermanentDeletionTarget(record: Record<string, unknown>): boolean {
  const keys = [
    'deletionOperationId', 'deletedProjectId', 'projectId', 'goalId', 'workItemId', 'runId',
    'artifactId', 'evidenceId', 'acceptanceId'
  ]
  return keys.every((key) => isString(record[key])) &&
    Number.isSafeInteger(record.expectedWorkspaceRevision) && Number(record.expectedWorkspaceRevision) >= 1
}

function isSha256(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isMigrationOperationTarget(record: Record<string, unknown>): boolean {
  if (!isRecord(record.kindCounts)) return false
  const kindCountKeys = ['rules', 'mcp', 'config', 'skill', 'prompt', 'usage', 'hook', 'memory', 'routine', 'channel']
  const counts = record.kindCounts
  return [
    record.operation === 'apply' || record.operation === 'rollback',
    record.backupRef === 'caogen-private:migration-backups' ||
      (isString(record.backupRoot) && isAbsolute(record.backupRoot)),
    record.backupRef === undefined || record.backupRef === 'caogen-private:migration-backups',
    record.backupRoot === undefined || (isString(record.backupRoot) && isAbsolute(record.backupRoot)),
    typeof record.backupId === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(record.backupId),
    isNonNegativeInteger(record.assetCount),
    Object.keys(counts).length === kindCountKeys.length,
    kindCountKeys.every((key) => isNonNegativeInteger(counts[key])),
    Object.values(counts).reduce<number>((sum, value) => sum + Number(value), 0) === record.assetCount,
    typeof record.selectionDigest === 'string' && /^[a-f0-9]{64}$/.test(record.selectionDigest),
    record.expectedState === (record.operation === 'apply' ? 'committed' : 'rolled_back')
  ].every(Boolean)
}

function isGuiPostconditionTarget(record: Record<string, unknown>): boolean {
  if (!isRecord(record.postcondition)) return false
  const postcondition = record.postcondition
  const windowIdMatches = record.platform === 'win32'
    ? typeof postcondition.windowId === 'string' && /^win32:\d+$/.test(postcondition.windowId)
    : record.platform === 'darwin' && typeof postcondition.windowId === 'string' && /^darwin:\d+:\d+$/.test(postcondition.windowId)
  const windowState = postcondition.state === 'exists' || postcondition.state === 'absent'
  const elementState = windowState || postcondition.state === 'enabled' || postcondition.state === 'disabled' ||
    postcondition.state === 'visible' || postcondition.state === 'hidden'
  const toolName = record.toolName === 'gui_activate_window' || record.toolName === 'gui_click' ||
    record.toolName === 'gui_type' || record.toolName === 'gui_scroll' || record.toolName === 'gui_hotkey'
  return Boolean(
    toolName && windowIdMatches && record.preconditionSatisfied === false &&
    (postcondition.kind === 'window'
      ? windowState && postcondition.elementId === undefined
      : postcondition.kind === 'element' && elementState && isString(postcondition.elementId)) &&
    (postcondition.maxElements === undefined ||
      (Number.isInteger(postcondition.maxElements) && Number(postcondition.maxElements) >= 1 && Number(postcondition.maxElements) <= 300))
  )
}

function isOfficeArtifactTarget(record: Record<string, unknown>): boolean {
  return [
    record.artifactKind === 'document' || record.artifactKind === 'spreadsheet' ||
      record.artifactKind === 'presentation' || record.artifactKind === 'pdf',
    isString(record.rootPath),
    isFileSystemIdentity(record.rootIdentity),
    isString(record.relativePath),
    isString(record.workspacePath),
    isString(record.specDigest),
    isOptionalOfficeOutputIdentity(
      record.outputBindingVersion,
      record.expectedSha256,
      record.expectedBytes,
      record.sourceSnapshots
    ),
    isString(record.mediaType),
    isStringArray(record.sourceRefs),
    record.sourceSnapshots === undefined || isOfficeSourceSnapshots(record.sourceSnapshots, record.sourceRefs),
    isString(record.title)
  ].every(Boolean)
}

function isOptionalOfficeOutputIdentity(
  version: unknown,
  sha256: unknown,
  bytes: unknown,
  sourceSnapshots: unknown
): boolean {
  if (version === undefined && sha256 === undefined && bytes === undefined) return true
  return version === 1 && isString(sha256) && /^sha256:[a-f0-9]{64}$/.test(sha256) &&
    isNonNegativeInteger(bytes) && Array.isArray(sourceSnapshots)
}

function isOfficeSourceSnapshots(value: unknown, sourceRefs: unknown): boolean {
  if (!Array.isArray(value) || !Array.isArray(sourceRefs) || value.length !== sourceRefs.length) return false
  return value.every((candidate, index) => {
    if (!isRecord(candidate)) return false
    return candidate.path === sourceRefs[index] &&
      isFileSystemIdentity(candidate.identity) &&
      isString(candidate.sha256) &&
      /^sha256:[a-f0-9]{64}$/.test(candidate.sha256) &&
      isNonNegativeInteger(candidate.bytes)
  })
}

function isGitIndexUpdateTarget(record: Record<string, unknown>): boolean {
  return [
    isString(record.repoRoot),
    isFileSystemIdentity(record.repoRootIdentity),
    isString(record.gitCommonDir),
    isFileSystemIdentity(record.gitCommonDirIdentity),
    isString(record.worktreeGitDir),
    isFileSystemIdentity(record.worktreeGitDirIdentity),
    isString(record.objectDir),
    isFileSystemIdentity(record.objectDirIdentity),
    record.objectFormat === 'sha1' || record.objectFormat === 'sha256',
    isString(record.indexPath),
    record.preHeadState === 'commit' || record.preHeadState === 'unborn',
    isOptionalString(record.preHead),
    isOptionalString(record.headRef),
    record.preIndexState === 'absent' || record.preIndexState === 'file',
    isOptionalFileSystemIdentity(record.preIndexIdentity),
    isOptionalString(record.preIndexSha256),
    isOptionalNonNegativeInteger(record.preIndexBytes),
    isString(record.preIndexEntriesDigest),
    isString(record.expectedIndexEntriesDigest),
    isGitIndexOperation(record.operation),
    isStringArray(record.paths),
    record.worktreeReadScope === 'none' || record.worktreeReadScope === 'paths' || record.worktreeReadScope === 'all',
    isOptionalString(record.scopePath),
    isOptionalString(record.patchSha256),
    isOptionalNonNegativeInteger(record.patchBytes),
    isString(record.artifactRoot),
    isFileSystemIdentity(record.artifactRootIdentity),
    isString(record.indexArtifactPath),
    isFileSystemIdentity(record.indexArtifactIdentity),
    isString(record.indexArtifactSha256),
    isNonNegativeInteger(record.indexArtifactBytes),
    isString(record.objectManifestPath),
    isFileSystemIdentity(record.objectManifestIdentity),
    isString(record.objectManifestSha256),
    isNonNegativeInteger(record.objectCount)
  ].every(Boolean)
}

function isGitIndexOperation(value: unknown): boolean {
  return value === 'stage_paths' || value === 'stage_all' || value === 'unstage_paths' || value === 'apply_cached_hunk'
}

function isFileContentTarget(record: Record<string, unknown>): boolean {
  return [
    isString(record.rootPath),
    isOptionalFileSystemIdentity(record.rootIdentity),
    isString(record.relativePath),
    record.preState === 'absent' || record.preState === 'file',
    isOptionalFileSystemIdentity(record.preFileIdentity),
    isOptionalString(record.preSha256),
    record.expectedState === undefined || record.expectedState === 'absent' || record.expectedState === 'file',
    isString(record.expectedSha256),
    isOptionalNonNegativeInteger(record.expectedBytes),
    record.expectedBytes !== undefined
  ].every(Boolean)
}

function isGitCommitTarget(record: Record<string, unknown>): boolean {
  return [
    isString(record.repoRoot),
    isString(record.branch),
    isString(record.preHead),
    isString(record.stagedDiffDigest),
    isString(record.messageDigest)
  ].every(Boolean)
}

function isGitMergeTarget(record: Record<string, unknown>): boolean {
  return [
    isString(record.repoRoot),
    isString(record.gitCommonDir),
    isString(record.worktreeGitDir),
    isFileSystemIdentity(record.repoRootIdentity),
    isFileSystemIdentity(record.gitCommonDirIdentity),
    isFileSystemIdentity(record.worktreeGitDirIdentity),
    isString(record.destinationRef),
    isString(record.preHead),
    isString(record.preTree),
    isString(record.sourceRef),
    isString(record.sourceSha),
    typeof record.sourceWasAncestor === 'boolean',
    record.mode === 'no_ff_v1'
  ].every(Boolean)
}

function isGitPushTarget(record: Record<string, unknown>): boolean {
  return [
    isString(record.repoRoot),
    isString(record.remote),
    isString(record.pushUrlDigest),
    isString(record.branch),
    isString(record.ref),
    isString(record.intendedSha)
  ].every(Boolean)
}

function isWorktreePatchTarget(record: Record<string, unknown>): boolean {
  return [
    isString(record.repoRoot),
    isFileSystemIdentity(record.repoRootIdentity),
    isString(record.gitCommonDir),
    isFileSystemIdentity(record.gitCommonDirIdentity),
    isString(record.worktreePath),
    isFileSystemIdentity(record.worktreeRootIdentity),
    isString(record.baseSha),
    isString(record.headSha),
    isString(record.preHead),
    isString(record.patchPath),
    isFileSystemIdentity(record.patchFileIdentity),
    isString(record.patchSha256),
    isOptionalNonNegativeInteger(record.patchBytes),
    record.patchBytes !== undefined,
    isStringArray(record.changedPaths),
    record.mode === undefined || record.mode === 'apply' || record.mode === 'reverse'
  ].every(Boolean)
}

function isCodeForgePatchTarget(record: Record<string, unknown>): boolean {
  return [
    record.targetKind === 'repository' || record.targetKind === 'managed-worktree',
    isOptionalString(record.sessionId),
    isString(record.repoRoot),
    isFileSystemIdentity(record.repoRootIdentity),
    isString(record.gitCommonDir),
    isFileSystemIdentity(record.gitCommonDirIdentity),
    isString(record.worktreePath),
    isFileSystemIdentity(record.worktreeRootIdentity),
    isString(record.worktreeGitDir),
    isFileSystemIdentity(record.worktreeGitDirIdentity),
    isOptionalString(record.branch),
    isOptionalNullableString(record.baseBranch),
    isString(record.baseSha),
    isString(record.headSha),
    isStringArray(record.changedPaths),
    isNonNegativeInteger(record.insertions),
    isNonNegativeInteger(record.deletions),
    record.conflictRisk === undefined || record.conflictRisk === 'low' || record.conflictRisk === 'medium' || record.conflictRisk === 'unknown',
    record.canApply === undefined || typeof record.canApply === 'boolean',
    isOptionalString(record.applyError),
    record.conflictFiles === undefined || isStringArray(record.conflictFiles),
    isString(record.sourceStateDigest),
    isString(record.artifactRoot),
    isFileSystemIdentity(record.artifactRootIdentity),
    isString(record.artifactPath),
    record.artifactPreState === 'absent' || record.artifactPreState === 'file',
    isOptionalFileSystemIdentity(record.artifactPreFileIdentity),
    isOptionalString(record.artifactPreSha256),
    isOptionalNonNegativeInteger(record.artifactPreBytes),
    isString(record.patchSha256),
    isNonNegativeInteger(record.patchBytes)
  ].every(Boolean)
}

function isGitWorktreeCreateTarget(record: Record<string, unknown>): boolean {
  return [
    isManagedWorktreeMetadata(record),
    isString(record.sourceCwd),
    isFileSystemIdentity(record.sourceCwdIdentity),
    isString(record.sourceWorktreeGitDir),
    isFileSystemIdentity(record.sourceWorktreeGitDirIdentity),
    isString(record.worktreeParentPath),
    record.worktreeParentPreState === 'absent' || record.worktreeParentPreState === 'directory',
    isOptionalFileSystemIdentity(record.worktreeParentPreIdentity),
    isString(record.worktreeParentAnchorPath),
    isFileSystemIdentity(record.worktreeParentAnchorIdentity),
    isOptionalNullableString(record.sourceHeadRef)
  ].every(Boolean)
}

function isGitWorktreeRemoveTarget(record: Record<string, unknown>): boolean {
  return [
    isManagedWorktreeMetadata(record),
    isString(record.sourceCwd),
    isFileSystemIdentity(record.sourceCwdIdentity),
    isString(record.sourceWorktreeGitDir),
    isFileSystemIdentity(record.sourceWorktreeGitDirIdentity),
    isString(record.sourceHead),
    isOptionalNullableString(record.sourceHeadRef),
    isFileSystemIdentity(record.worktreeRootIdentity),
    isString(record.worktreeGitDir),
    isFileSystemIdentity(record.worktreeGitDirIdentity),
    isString(record.branchSha),
    isString(record.headSha),
    isString(record.worktreeStatusDigest),
    isString(record.worktreeOperationStateDigest),
    isString(record.preStateDigest),
    typeof record.force === 'boolean',
    typeof record.deleteBranch === 'boolean'
  ].every(Boolean)
}

function isManagedWorktreeMetadata(record: Record<string, unknown>): boolean {
  return [
    isString(record.sessionId),
    isString(record.repoRoot),
    isFileSystemIdentity(record.repoRootIdentity),
    isString(record.gitCommonDir),
    isFileSystemIdentity(record.gitCommonDirIdentity),
    isString(record.worktreePath),
    isString(record.worktreeCwd),
    isString(record.sourcePrefix),
    isString(record.branch),
    isString(record.branchRef),
    isString(record.baseSha),
    isOptionalNullableString(record.baseBranch),
    isManagedWorktreeProjectionRecord(record.registryRecord)
  ].every(Boolean)
}

function isManagedWorktreeProjectionRecord(value: unknown): boolean {
  if (!isRecord(value)) return false
  return [
    isString(value.sessionId),
    isString(value.repoRoot),
    isString(value.sourceCwd),
    isString(value.worktreePath),
    isString(value.cwd),
    isString(value.branch),
    isString(value.baseSha),
    isOptionalNullableString(value.baseBranch),
    value.state === 'active' || value.state === 'removed',
    isNonNegativeFiniteNumber(value.createdAt),
    isNonNegativeFiniteNumber(value.updatedAt)
  ].every(Boolean)
}

function isNonNegativeFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isPullRequestTarget(record: Record<string, unknown>): boolean {
  return [
    record.provider === 'github' || record.provider === 'gitlab',
    isString(record.repoRoot),
    isFileSystemIdentity(record.repoRootIdentity),
    isString(record.remote),
    isString(record.remoteUrlDigest),
    isString(record.host),
    isString(record.projectPath),
    isString(record.repositoryDigest),
    isString(record.sourceBranch),
    isString(record.sourceSha),
    isString(record.baseBranch),
    isString(record.titleDigest),
    isString(record.bodyDigest),
    isString(record.marker)
  ].every(Boolean)
}

function isIssueTarget(record: Record<string, unknown>): boolean {
  return [
    record.provider === 'github' || record.provider === 'gitlab',
    isString(record.repoRoot),
    isFileSystemIdentity(record.repoRootIdentity),
    isString(record.remote),
    isString(record.remoteUrlDigest),
    isString(record.host),
    isString(record.projectPath),
    isString(record.repositoryDigest),
    isString(record.titleDigest),
    isString(record.bodyDigest),
    isStringArray(record.labels),
    isString(record.labelsDigest),
    isString(record.markerToken),
    isString(record.marker)
  ].every(Boolean)
}

function isMcpToolCallTarget(record: Record<string, unknown>): boolean {
  return [
    record.transport === 'stdio' || record.transport === 'http' || record.transport === 'sse',
    isOptionalString(record.command),
    record.commandArgs === undefined || isStringArray(record.commandArgs),
    isOptionalString(record.url),
    isString(record.serverIdentityDigest),
    isOptionalString(record.pluginRegistryItemKey),
    isOptionalString(record.pluginContentDigest),
    isOptionalString(record.pluginCapabilityDigest),
    isOptionalString(record.pluginServerId),
    isString(record.discoveryDigest),
    isString(record.toolName),
    isString(record.toolArgumentsDigest),
    isString(record.queryToolName),
    isRecord(record.queryArguments),
    isString(record.queryArgumentsDigest),
    isString(record.jsonPointer),
    isString(record.expectedValueDigest),
    record.transport === 'stdio'
      ? isString(record.command) && record.url === undefined
      : isString(record.url) && record.command === undefined && record.commandArgs === undefined
  ].every(Boolean)
}

function isWebhookMessageTarget(record: Record<string, unknown>): boolean {
  return [
    isString(record.connectorId),
    isNonNegativeInteger(record.connectorRevision),
    record.channel === 'feishu' || record.channel === 'dingtalk',
    isString(record.webhookDigest),
    isString(record.payloadDigest),
    isString(record.titleDigest),
    isString(record.textDigest),
    isOptionalString(record.linkUrlDigest)
  ].every(Boolean)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isOptionalFileSystemIdentity(value: unknown): boolean {
  return value === undefined || isFileSystemIdentity(value)
}

function isFileSystemIdentity(value: unknown): value is FileSystemIdentity {
  if (!isRecord(value)) return false
  return [isString(value.device), isString(value.inode)].every(Boolean)
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isString)
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0)
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

const OFFICE_TARGET_VALIDATORS: Record<string, ((value: Record<string, unknown>) => boolean) | undefined> = {
  office_artifact: isOfficeArtifactTarget, office_artifact_revision: isOfficeRevisionTarget
}
