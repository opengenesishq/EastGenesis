import type { CreateSessionOptions } from '../shared/types'

/** Validate before any canonical task or Session creation can publish records. */
export function parseSessionConversationSource(
  options: Pick<CreateSessionOptions, 'resumeSdkSessionId' | 'forkFromSdkSessionId' | 'forkCheckpointId'>
): { mode: 'resume' | 'fork'; sdkSessionId: string } | undefined {
  if (options.resumeSdkSessionId !== undefined && options.forkFromSdkSessionId !== undefined) {
    throw new Error('恢复会话与分叉会话不能同时指定')
  }
  if (options.forkCheckpointId !== undefined && options.forkFromSdkSessionId === undefined) {
    throw new Error('消息级分叉必须同时指定来源 sdkSessionId')
  }
  if (options.forkCheckpointId !== undefined &&
    (typeof options.forkCheckpointId !== 'string' || !options.forkCheckpointId.trim())) {
    throw new Error('分叉 checkpointId 不能为空')
  }
  const mode = options.forkFromSdkSessionId !== undefined ? 'fork' : 'resume'
  const raw = mode === 'fork' ? options.forkFromSdkSessionId : options.resumeSdkSessionId
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`${mode === 'fork' ? '分叉来源' : '历史会话'} sdkSessionId 不能为空`)
  }
  return { mode, sdkSessionId: raw.trim() }
}
