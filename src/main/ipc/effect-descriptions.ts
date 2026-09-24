import type { EffectRecord, TaskSnapshotRecord } from '../../shared/types'
import { stableValueDigest } from '../task/tool-idempotency'

export function fallbackEffectTargetDescription(effect: EffectRecord): string {
  const queryable = queryableEffectTargetDescription(effect)
  if (queryable) return queryable
  if (effect.target.kind === 'unsupported') return `${effect.target.toolName}（无自动查询器）`
  return `${effect.toolName}（无自动查询器）`
}

export function fallbackEffectIntentDescription(
  snapshot: TaskSnapshotRecord,
  effect: EffectRecord
): string {
  const queryable = queryableEffectIntentDescription(effect)
  if (queryable) return queryable
  for (const entry of [...snapshot.transcript].reverse()) {
    if (entry.event.kind !== 'assistant-message') continue
    const block = entry.event.blocks.find(
      (item) => item.type === 'tool_use' && item.id === effect.toolUseId
    )
    if (!block || block.type !== 'tool_use') continue
    const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input)
      ? block.input as Record<string, unknown>
      : {}
    if (stableValueDigest(input) !== effect.inputDigest) break
    if (typeof input.command === 'string') return `command: ${redactEffectText(input.command)}`
    const path = input.path ?? input.file_path
    if (typeof path === 'string') return `path: ${redactEffectText(path)}`
    return `input keys: ${Object.keys(input).sort().join(', ') || '(none)'} · sha256 ${effect.inputDigest.slice(0, 16)}`
  }
  return `input sha256 ${effect.inputDigest.slice(0, 16)}（原始输入不可用）`
}

function queryableEffectTargetDescription(effect: EffectRecord): string | undefined {
  if (effect.target.kind === 'git_index_update') {
    return `${effect.target.repoRoot} · index ${effect.target.operation} · ${effect.target.paths.length} path(s)`
  }
  if (effect.target.kind === 'worktree_patch_apply') {
    return `${effect.target.repoRoot} · ${effect.target.mode === 'reverse' ? 'rollback' : 'patch'} ${effect.target.patchSha256.slice(0, 12)}`
  }
  if (effect.target.kind === 'code_forge_patch') {
    return `${effect.target.worktreePath} · artifact ${effect.target.patchSha256.slice(0, 12)}`
  }
  if (effect.target.kind === 'pull_request_create') {
    return `${effect.target.provider}:${effect.target.projectPath} ${effect.target.sourceBranch} -> ${effect.target.baseBranch}`
  }
  if (effect.target.kind === 'issue_create') {
    return `${effect.target.provider}:${effect.target.projectPath} · issue ${effect.target.titleDigest.slice(0, 12)}`
  }
  if (effect.target.kind === 'mcp_tool_call') {
    return `MCP ${effect.target.toolName} · server ${effect.target.serverIdentityDigest.slice(0, 12)}`
  }
  if (effect.target.kind === 'webhook_message_send') {
    return `${effect.target.channel} · connector ${effect.target.connectorId.slice(0, 12)}`
  }
  if (effect.target.kind === 'office_artifact') {
    return `${effect.target.artifactKind} · ${effect.target.relativePath}`
  }
  if (effect.target.kind === 'workspace_handoff') return `${effect.target.direction === 'local' ? '交接到本地目录' : '交接到 Worktree'} · ${effect.target.journalId}`
  if (effect.target.kind === 'git_worktree_create') {
    return `${effect.target.repoRoot} · create worktree ${effect.target.worktreePath}`
  }
  if (effect.target.kind === 'git_worktree_remove') {
    return `${effect.target.repoRoot} · remove worktree ${effect.target.worktreePath}`
  }
  return undefined
}

function queryableEffectIntentDescription(effect: EffectRecord): string | undefined {
  if (effect.target.kind === 'git_index_update') {
    return `index ${effect.target.preIndexEntriesDigest.slice(0, 12)} -> ${effect.target.expectedIndexEntriesDigest.slice(0, 12)}`
  }
  if (effect.target.kind === 'worktree_patch_apply') {
    return `${effect.target.mode === 'reverse' ? 'reverse' : 'apply'} ${effect.target.patchBytes} bytes · sha256 ${effect.target.patchSha256.slice(0, 16)}`
  }
  if (effect.target.kind === 'code_forge_patch') {
    return `publish ${effect.target.changedPaths.length} file patch · ${effect.target.patchBytes} bytes · sha256 ${effect.target.patchSha256.slice(0, 16)}`
  }
  if (effect.target.kind === 'pull_request_create') {
    return `marker ${stableValueDigest(effect.target.marker).slice(0, 16)} · head ${effect.target.sourceSha.slice(0, 16)}`
  }
  if (effect.target.kind === 'issue_create') {
    return `marker ${effect.target.markerToken.slice(-16)} · ${effect.target.labels.length} label(s)`
  }
  if (effect.target.kind === 'mcp_tool_call') {
    return `verify ${effect.target.queryToolName}${effect.target.jsonPointer} = ${effect.target.expectedValueDigest.slice(0, 16)}`
  }
  if (effect.target.kind === 'webhook_message_send') {
    return `message sha256 ${effect.target.payloadDigest.slice(0, 16)} · no automatic replay`
  }
  if (effect.target.kind === 'office_artifact') {
    return `generate ${effect.target.mediaType} · spec sha256 ${effect.target.specDigest.slice(0, 16)}`
  }
  if (effect.target.kind === 'workspace_handoff') return `${effect.target.direction === 'local' ? '交接到本地目录' : '交接到 Worktree'} · ${effect.target.journalId}`
  if (effect.target.kind === 'git_worktree_create') {
    return `create ${effect.target.branchRef} at ${effect.target.baseSha.slice(0, 16)}`
  }
  if (effect.target.kind === 'git_worktree_remove') {
    return `remove ${effect.target.branchRef} · force=${effect.target.force} · deleteBranch=${effect.target.deleteBranch}`
  }
  return undefined
}

function redactEffectText(value: string): string {
  const redacted = value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(api[-_]?key|token|password|secret|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(https?:\/\/)([^\s/@]+):([^\s/@]+)@/gi, '$1[REDACTED]@')
  return redacted.length > 600 ? `${redacted.slice(0, 600)}...[truncated]` : redacted
}
