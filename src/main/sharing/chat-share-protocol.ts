import { z } from 'zod'
import type { ChatShareAccount } from '../../shared/chat-snapshot-share-types'
import { containsSensitiveText } from '../security/secret-redaction'

export const CHAT_SHARE_PROTOCOL = 'caogen-chat-share/1' as const
const identity = z.string().min(1).max(512).refine(value => !/[\x00-\x1f\x7f]/.test(value) && !containsSensitiveText(value))
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const accountSchema = z.object({ adapterNamespace: identity, accountScope: identity, targetId: identity, accountName: identity,
  capabilities: z.object({ publish: z.boolean(), revoke: z.boolean(), inspect: z.boolean(), idempotent: z.boolean(), conditionalRevoke: z.boolean() }).strict() }).strict()
export interface ChatShareRequest {
  protocol: typeof CHAT_SHARE_PROTOCOL; requestId: string; operationId: string; operation: 'describe' | 'publish' | 'revoke' | 'inspect'
  adapterNamespace?: string; accountScope?: string; targetId?: string
  shareId?: string; snapshotId?: string; manifestDigest?: string; expectedRevision?: string; directory?: string
  originalAction?: 'publish' | 'revoke'
}
export interface ChatShareResponse {
  account: ChatShareAccount; result?: 'applied' | 'not_applied' | 'unknown'
  publicState?: 'active' | 'revoked' | 'absent' | 'unknown'; revision?: string; url?: string
}
export function parseChatShareResponse(stdout: string, request: ChatShareRequest): ChatShareResponse {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith('CAOGEN_CHAT_SHARE_RESULT '))
  if (lines.length !== 1) throw new Error('分享适配器必须返回且只返回一个结构化回执。')
  const value = z.object({ protocol: z.literal(CHAT_SHARE_PROTOCOL), requestId: identity, operationId: identity,
    operation: z.enum(['describe','publish','revoke','inspect']), account: accountSchema,
    shareId: identity.optional(), snapshotId: identity.optional(), manifestDigest: digest.optional(), expectedRevision: identity.optional(),
    originalAction: z.enum(['publish','revoke']).optional(), result: z.enum(['applied','not_applied','unknown']).optional(),
    publicState: z.enum(['active','revoked','absent','unknown']).optional(), revision: identity.optional(), url: z.string().max(4096).optional()
  }).strict().parse(JSON.parse(lines[0].slice('CAOGEN_CHAT_SHARE_RESULT '.length)))
  for (const key of ['requestId','operationId','operation','shareId','snapshotId','manifestDigest','expectedRevision','originalAction'] as const) {
    if (request[key] !== undefined && value[key] !== request[key]) throw new Error(`分享回执的 ${key} 与原请求不匹配。`)
  }
  for (const key of ['adapterNamespace','accountScope','targetId'] as const) if (request[key] !== undefined && value.account[key] !== request[key]) throw new Error('分享适配器账号或目标已变化。')
  if (value.url) {
    const url = new URL(value.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || containsSensitiveText(value.url)) throw new Error('分享 URL 必须为不含凭据或查询令牌的 HTTPS 地址。')
  }
  if (request.operation !== 'describe') {
    if (!value.result || !value.publicState) throw new Error('分享适配器缺少明确操作结果。')
    const action = request.operation === 'inspect' ? request.originalAction : request.operation
    if (value.result === 'applied' && (!value.revision || action === 'publish' && (value.publicState !== 'active' || !value.url) || action === 'revoke' && value.publicState !== 'revoked' && value.publicState !== 'absent')) throw new Error('分享回执未确认原操作所需的状态。')
    if (value.result === 'not_applied' && action === 'publish' && value.publicState !== 'absent') throw new Error('未发布回执必须确认原分享不存在。')
    if (value.result === 'not_applied' && action === 'revoke' && (value.publicState !== 'active' || value.revision !== request.expectedRevision)) throw new Error('未撤销回执必须确认原版本仍可访问。')
  }
  return value
}
export function requireChatShareCapabilities(account: ChatShareAccount): void {
  if (Object.values(account.capabilities).some(value => value !== true)) throw new Error('适配器须支持单份分享、撤销、原操作核对、幂等发布和版本条件撤销。')
}
