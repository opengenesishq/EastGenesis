import type { RoutingLegacyTransition, RoutingPreviewContext, RoutingRuleApi, RoutingRuleSetDraftV1 } from '../../../../../shared/routing-policy-types'
import type { RoutingComparisonResolution, RoutingControllerState } from './routing-controller-types'
import { requestRoutingPreview, requestRoutingRead, requestRoutingSave } from './routing-controller-commands'
import { createRoutingControllerState, editRoutingDraft, editRoutingMigration, resolveRoutingComparison, selectRoutingRule, setRoutingPreviewContext } from './routing-controller-state'
import { rejectRoutingOperation } from './routing-controller-results'
import { dispatchRoutingCommand, receiveRoutingCommand } from './routing-controller-dispatch'

interface Options {
  api: RoutingRuleApi
  initialState?: RoutingControllerState
  onStateChange(state: RoutingControllerState): void
}
const requests = { read: requestRoutingRead, preview: requestRoutingPreview, save: requestRoutingSave }

/** One editor lifetime owns dispatch and delivery. Constructing or restoring the
 * runner makes no API calls. A view owner can retain dispose()'s exact snapshot;
 * disposal cannot cancel an accepted save, so an unresolved save stays unknown. */
export function createRoutingControllerRunner({ api, initialState, onStateChange }: Options) {
  let state = interruptPending(structuredClone(initialState ?? createRoutingControllerState()))
  let disposed = false
  const getSnapshot = (): RoutingControllerState => structuredClone(state)
  function publish(next: RoutingControllerState): void {
    if (disposed || next === state) return
    state = next
    onStateChange(getSnapshot())
  }
  async function request(kind: keyof typeof requests): Promise<void> {
    if (disposed) return
    const transition = requests[kind](state)
    publish(transition.state)
    if (!transition.command || disposed) return
    // A subscriber can dispose this view during the pending notification. Never
    // dispatch after that boundary, and never deliver into a replacement view.
    const command = transition.command
    let reply: Awaited<ReturnType<typeof dispatchRoutingCommand>>
    try {
      reply = await dispatchRoutingCommand(api, command)
    } catch (error) {
      if (!disposed) publish(rejectRoutingOperation(state, command.requestId, operationMessage(error)))
      return
    }
    if (!disposed) publish(receiveRoutingCommand(state, reply))
  }
  return {
    getSnapshot,
    read: (): Promise<void> => request('read'),
    preview: (): Promise<void> => request('preview'),
    save: (): Promise<void> => request('save'),
    editDraft: (draft: RoutingRuleSetDraftV1): void => publish(editRoutingDraft(state, draft)),
    selectRule: (id: string): void => publish(selectRoutingRule(state, id)),
    editMigration: (migration: RoutingLegacyTransition): void => publish(editRoutingMigration(state, migration)),
    setContext: (context: RoutingPreviewContext): void => publish(setRoutingPreviewContext(state, context)),
    resolveComparison: (resolution: RoutingComparisonResolution): void => publish(resolveRoutingComparison(state, resolution)),
    dispose(): RoutingControllerState {
      state = interruptPending(state)
      disposed = true
      return getSnapshot()
    }
  }
}
function interruptPending(state: RoutingControllerState): RoutingControllerState {
  if (!state.pending) return state
  return rejectRoutingOperation(state, state.pending.requestId, '上次操作的返回结果尚未确认，请重新读取规则后核对。')
}
function operationMessage(error: unknown): string {
  return error instanceof Error ? error.message : '路由规则操作未能完成，草稿已保留。'
}
