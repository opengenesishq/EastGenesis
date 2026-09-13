import type { SendMessagePayload, SessionMeta, TaskRunRecord } from '../../shared/types'
import type { OfficeRevisionIntent } from '../../shared/office-revision-types'
import { isReadOnlyToolCall } from '../task/tool-idempotency'
import { taskRuntimeRegistry } from '../task/task-runtime-registry'
import { classifyToolCapabilities } from '../permission/tool-capabilities'
import { officeValueDigest } from './digest'
import { officeError } from './errors'
import { normalizeOfficeIntent } from './input'
import { getPreparedOfficePlan, officeIntentMatches } from './plans'
import { officeSessionScope, readScopedOfficeArtifact } from './scope'

interface BoundOfficeIntent { intent: OfficeRevisionIntent; runId: string; scopeDigest: string; userText: string; wireText: string }
const intents = new Map<string, BoundOfficeIntent>()
/** Manager invokes before model HTTP. Restart requires a new preview; frozen Effects reconcile independently. */
export async function authorizeOfficeRevisionSend(input: { meta: SessionMeta; payload: SendMessagePayload; run: TaskRunRecord; rootDir: string }): Promise<void> {
  const { meta, payload, run, rootDir } = input
  if (!payload.officeRevisionIntent) { intents.delete(meta.id); return }
  if (meta.taskStrategy !== 'execute') officeError('OFFICE_SCOPE_MISMATCH', '应用修订需要执行策略和原有工具审批。')
  const intent = normalizeOfficeIntent(payload.officeRevisionIntent)
  const prepared = getPreparedOfficePlan(meta.id, intent)
  const scope = await officeSessionScope({ meta, rootDir })
  if (officeValueDigest(scope) !== officeValueDigest(prepared.loaded.scope)) officeError('OFFICE_SCOPE_MISMATCH', '预览后任务归属改变。')
  const base = await readScopedOfficeArtifact({ meta, rootDir }, intent.baseArtifactId, intent.baseDigest)
  if (!base.latest) officeError('OFFICE_BASE_NOT_HEAD', '该原稿已有新版本，请重新预览。')
  const userText = payload.text
  // All native protocols consume text. The typed binding above remains the authority,
  // while this exact tool argument projection makes the already-approved plan callable.
  payload.text += `\n\n当前回合已绑定的Office修订参数（必须原样调用revise_office_artifact，不得更换原稿或计划）：\n${JSON.stringify(intent)}`
  intents.set(meta.id, { intent, runId: run.id, scopeDigest: officeValueDigest(scope), userText, wireText: payload.text })
}

/** Show the user's instruction while retaining the exact authorized model payload. */
export function officeRevisionUserMessageText(sessionId: string, text: string): string {
  const bound = intents.get(sessionId)
  return bound?.wireText === text ? bound.userText : text
}
/** Restrict every native side effect during a UI revision turn, not just the revision tool's arguments. */
export function officeRevisionToolGate(sessionId: string, toolName: string, args: Record<string, unknown>): string | undefined {
  const bound = intents.get(sessionId)
  if (!bound) return undefined
  const capabilities = classifyToolCapabilities(toolName, args)
  if (isReadOnlyToolCall(toolName, args) && !capabilities.includes('workspaceWrite') && !capabilities.includes('terminal')) return undefined
  if (taskRuntimeRegistry.get(sessionId)?.id !== bound.runId) return 'OFFICE_PLAN_MISMATCH：修订意图不属于当前执行回合，请重新预览。'
  if (toolName !== 'revise_office_artifact') return 'OFFICE_PLAN_MISMATCH：本回合只允许应用用户已审阅的Office选区修订，其他写操作已阻止。'
  try {
    if (!officeIntentMatches(normalizeOfficeIntent(args), bound.intent)) return 'OFFICE_PLAN_MISMATCH：模型修改了用户选定的原稿或预览摘要。'
  } catch (error) { return error instanceof Error ? error.message : String(error) }
  return undefined
}
export function assertOfficeRevisionIntent(sessionId: string, args: Record<string, unknown>): void {
  const error = officeRevisionToolGate(sessionId, 'revise_office_artifact', args)
  if (error) officeError('OFFICE_PLAN_MISMATCH', error)
}
