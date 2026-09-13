import type { StoreApi } from 'zustand'
import type { SendMessagePayload } from '../../../shared/types'
import type { AppStore } from '../store'

type StoreAccess = Pick<StoreApi<AppStore>, 'getState' | 'setState'> & { nextId(): string }

export async function sendActiveSessionMessage(
  store: StoreAccess,
  input: string | SendMessagePayload
): Promise<void> {
  const id = store.getState().activeId
  if (!id) return
  const payload: SendMessagePayload = typeof input === 'string'
    ? { text: input.trim() }
    : { text: input.text.trim(), images: input.images, documents: input.documents, officeRevisionIntent: input.officeRevisionIntent }
  const displayText = payload.text ||
    (payload.images?.length ? `图片输入 (${payload.images.length} 张)` : '') ||
    (payload.documents?.length ? `文档输入 (${payload.documents.length} 个)` : '')
  if (!displayText && !payload.images?.length && !payload.documents?.length) return
  const previousStatus = store.getState().sessions[id]?.meta.status
  if (!previousStatus) return
  const optimisticId = store.nextId()
  store.setState((state) => {
    const session = state.sessions[id]
    if (!session) return state
    return {
      sessions: {
        ...state.sessions,
        [id]: {
          ...session,
          items: [...session.items, {
            id: optimisticId,
            kind: 'user',
            text: displayText,
            attachments: payload.images?.map(({ id: imageId, mime, bytes }) => ({ id: imageId, mime, bytes }))
          }],
          meta: { ...session.meta, status: 'running' }
        }
      }
    }
  })
  if (await window.agentDesk.sendMessage(id, payload)) return
  store.setState((state) => {
    const session = state.sessions[id]
    if (!session) return state
    const meta = session.meta.status === 'running' && previousStatus !== 'running'
      ? { ...session.meta, status: previousStatus }
      : session.meta
    return { sessions: { ...state.sessions, [id]: {
      ...session,
      items: session.items.filter((item) => item.id !== optimisticId),
      meta
    } } }
  })
  throw new Error('消息未被执行引擎接受,请根据会话中的错误提示修复后重试。')
}
