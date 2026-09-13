import type {
  AgentEvent,
  CheckpointRestoreMode,
  CheckpointRestoreResult,
  TranscriptEntry
} from '../shared/types'
import { TranscriptWriter } from './transcript'

const UNSAFE_RESTORE_KINDS = new Set<AgentEvent['kind']>([
  'tool-start',
  'tool-result',
  'permission-request',
  'permission-resolved',
  'subagent-result',
  'task-dag-update',
  'checkpoint-restore'
])

export function providerChatCheckpointId(userMessageId: string): string {
  return `chat:${userMessageId}`
}

export function restoreProviderChatCheckpoint(
  transcript: TranscriptWriter,
  checkpointId: string,
  mode: CheckpointRestoreMode,
  dryRun: boolean,
  onApplied: (entries: TranscriptEntry[]) => void
): CheckpointRestoreResult {
  if (mode !== 'chat') {
    return unavailable(mode, checkpointId, '该 Provider 只支持安全恢复聊天，不支持文件回退')
  }
  const entries = transcript.readAll()
  // Checkpoints emitted by current native providers use a `chat:` namespace.
  // Older transcripts (and imported transcripts from another provider) stored
  // the user message id directly. Resolve that legacy form before planning so
  // a provider switch does not make an otherwise safe checkpoint unreachable.
  const requestedId = checkpointId.trim()
  const canonicalId = requestedId.startsWith('chat:')
    ? requestedId
    : providerChatCheckpointId(requestedId)
  const plan = transcript.planRestore(canonicalId)
  if (!plan.ok) {
    return {
      ...unavailable(mode, checkpointId, plan.reason ?? '找不到聊天检查点'),
      chat: plan
    }
  }
  if (crossesExternalEffects(entries, plan.removeFromSeq ?? Number.POSITIVE_INFINITY)) {
    return {
      ...unavailable(mode, checkpointId, '该位置之后包含工具或外部副作用，已阻止重复执行'),
      chat: plan
    }
  }
  if (dryRun) {
    return {
      mode,
      checkpointId,
      canRewind: true,
      applied: false,
      chat: plan,
      filesChanged: [],
      chatRemovedEntries: plan.removedEntries
    }
  }
  const restored = transcript.restore(canonicalId)
  if (!restored.plan.ok) {
    return {
      ...unavailable(mode, checkpointId, restored.plan.reason ?? '聊天恢复失败'),
      chat: restored.plan
    }
  }
  onApplied(restored.entries)
  return {
    mode,
    checkpointId,
    canRewind: true,
    applied: true,
    chat: restored.plan,
    transcript: restored.entries,
    filesChanged: [],
    chatRemovedEntries: restored.plan.removedEntries
  }
}

function crossesExternalEffects(entries: readonly TranscriptEntry[], removeFromSeq: number): boolean {
  return entries.some((entry) => {
    if (entry.seq < removeFromSeq) return false
    if (UNSAFE_RESTORE_KINDS.has(entry.event.kind)) return true
    return entry.event.kind === 'assistant-message' && entry.event.blocks.some((block) => block.type === 'tool_use')
  })
}

function unavailable(
  mode: CheckpointRestoreMode,
  checkpointId: string,
  error: string
): CheckpointRestoreResult {
  return { mode, checkpointId, canRewind: false, applied: false, error }
}
