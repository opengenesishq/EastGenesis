import type { CreateSessionOptions, SessionMeta } from '../shared/types'
import { prepareSessionCreationDraft, type SessionCreationDraft } from './session-create-lifecycle'

interface SessionCreationIdentityInput {
  options: CreateSessionOptions
  parentMeta?: SessionMeta
  reservedSessionId?: string
  hasSession(id: string): boolean
}

/** Claim a conversation before archive restore, placement or journal writes. */
export class SessionResumeCreationGuard {
  private readonly pending = new Set<string>()

  constructor(private readonly activeSessions: () => Iterable<SessionMeta>) {}

  async run<T>(options: CreateSessionOptions, create: () => Promise<T>): Promise<T> {
    const sdkSessionId = options.resumeSdkSessionId?.trim()
    if (!sdkSessionId) return create()
    const active = [...this.activeSessions()].find((meta) => meta.status !== 'closed' && meta.sdkSessionId === sdkSessionId)
    if (active) throw new Error(`会话已在运行:${active.id}；请打开现有会话，不能重复恢复`)
    if (this.pending.has(sdkSessionId)) throw new Error('该会话正在恢复，请等待当前恢复完成')
    this.pending.add(sdkSessionId)
    try { return await create() }
    finally { this.pending.delete(sdkSessionId) }
  }
}

/** Reserved identity is a main-only lifecycle capability, never a renderer Session option. */
export function prepareIdentifiedSessionDraft(input: SessionCreationIdentityInput): SessionCreationDraft {
  const draft = prepareSessionCreationDraft(input.options, input.parentMeta)
  if (input.reservedSessionId !== undefined) {
    if (!/^[a-f0-9-]{36}$/.test(input.reservedSessionId) || input.options.resumeSdkSessionId || input.options.forkFromSdkSessionId) {
      throw new Error('预留 Session 身份不能用于恢复或分叉请求')
    }
    draft.baseMeta.id = input.reservedSessionId
  }
  if (input.hasSession(draft.baseMeta.id)) throw new Error(`会话已在运行:${draft.baseMeta.id}`)
  return draft
}
