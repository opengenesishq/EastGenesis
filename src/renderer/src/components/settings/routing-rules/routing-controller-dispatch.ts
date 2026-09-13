import type { RoutingRuleApi, RoutingRulePreviewResult, RoutingRuleReadResult, RoutingRuleSaveResult } from '../../../../../shared/routing-policy-types'
import type { RoutingControllerState, RoutingEditorCommand } from './routing-controller-types'
import { receiveRoutingPreview, receiveRoutingRead, receiveRoutingSave } from './routing-controller-results'

type Reply =
  | { kind: 'read'; requestId: number; result: RoutingRuleReadResult }
  | { kind: 'preview'; requestId: number; result: RoutingRulePreviewResult }
  | { kind: 'save'; requestId: number; result: RoutingRuleSaveResult }

/** Only the injected API supplies results. This adapter never simulates a saved
 * receipt and never changes the frozen input kept by the controller. */
export async function dispatchRoutingCommand(api: RoutingRuleApi, command: RoutingEditorCommand): Promise<Reply> {
  const { requestId } = command
  switch (command.kind) {
    case 'read': return { kind: 'read', requestId, result: await api.getRoutingRuleSet() }
    case 'preview': return { kind: 'preview', requestId, result: await api.previewRoutingRuleSet(structuredClone(command.input)) }
    case 'save': return { kind: 'save', requestId, result: await api.saveRoutingRuleSet(structuredClone(command.input)) }
  }
}
export function receiveRoutingCommand(state: RoutingControllerState, reply: Reply): RoutingControllerState {
  switch (reply.kind) {
    case 'read': return receiveRoutingRead(state, reply.requestId, reply.result)
    case 'preview': return receiveRoutingPreview(state, reply.requestId, reply.result)
    case 'save': return receiveRoutingSave(state, reply.requestId, reply.result)
  }
}
