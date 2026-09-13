import type { RoutingRuleSaveInput } from '../../../../../shared/routing-policy-types'
import type { RoutingControllerState, RoutingControllerTransition, RoutingEditorCommand } from './routing-controller-types'
import { routingOutcomeUnknown } from './routing-controller-state'
import { legacyReviewProgress } from './routing-editor-state'

function blocked(state: RoutingControllerState, message: string): RoutingControllerTransition {
  return { state: { ...state, error: { kind: 'blocked', message } } }
}
function begin(state: RoutingControllerState, command: RoutingEditorCommand): RoutingControllerTransition {
  return { state: { ...state, pending: structuredClone(command), nextRequestId: state.nextRequestId + 1, error: undefined }, command }
}
export function requestRoutingRead(state: RoutingControllerState): RoutingControllerTransition {
  if (state.pending) return blocked(state, '当前操作尚未结束。')
  return begin(state, { kind: 'read', requestId: state.nextRequestId })
}
function preparationError(state: RoutingControllerState): string | undefined {
  if (state.pending) return '当前操作尚未结束。'
  if (routingOutcomeUnknown(state)) return '保存结果尚未确认，请先重读并比较。'
  if (state.comparison) return '请先明确处理最新内容与本地草稿的差异。'
  if (!state.read || state.read.mode === 'invalid_v1' || !state.draft) return '规则尚未有效读取，草稿已保留。'
  return undefined
}
export function requestRoutingPreview(state: RoutingControllerState): RoutingControllerTransition {
  const error = preparationError(state)
  if (error) return blocked(state, error)
  if (!state.context || !state.draft) return blocked(state, '请先提供用于检查的任务。')
  return begin(state, { kind: 'preview', requestId: state.nextRequestId,
    input: structuredClone({ draft: state.draft, context: state.context }) })
}
export function requestRoutingSave(state: RoutingControllerState): RoutingControllerTransition {
  const error = preparationError(state)
  if (error) return blocked(state, error)
  if (!state.dirty) return blocked(state, '没有需要保存的修改。')
  const { read, draft } = state
  if (!read || !draft || read.mode === 'invalid_v1') return blocked(state, '规则尚未有效读取。')
  const progress = legacyReviewProgress({ read, draft, migration: state.migration })
  if (!progress.complete) return blocked(state, progress.reason ?? '旧规则尚未处理完整。')
  const input = saveInput({ ...state, read, draft })
  return begin({ ...state, lastSave: undefined }, { kind: 'save', requestId: state.nextRequestId, input })
}
function saveInput(state: RoutingControllerState & { read: Exclude<NonNullable<RoutingControllerState['read']>, { mode: 'invalid_v1' }>; draft: NonNullable<RoutingControllerState['draft']> }): RoutingRuleSaveInput {
  const input: RoutingRuleSaveInput = { expectedRevision: state.read.mode === 'v1_active' ? state.read.ruleSet.revision : 0,
    draft: structuredClone(state.draft) }
  if (state.read.mode === 'legacy_active') input.migration = structuredClone(state.migration ?? { legacyDigest: state.read.legacyDigest, resolutions: [] })
  if (state.preview?.status === 'ready') {
    const { draftDigest, catalogDigest, contextDigest, previewDigest } = state.preview
    input.preview = { draftDigest, catalogDigest, contextDigest, previewDigest }
  }
  return input
}
