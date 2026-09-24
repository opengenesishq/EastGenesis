import { createHash, randomUUID } from 'node:crypto'
import type { SessionMeta, TranscriptEntry } from '../../shared/types'
import type { ChatSnapshotMessage, ChatSnapshotSource, PrepareChatSnapshotInput } from '../../shared/chat-snapshot-share-types'
import { redactSensitiveText } from '../security/secret-redaction'

export const chatShareDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const chatShareBytesDigest = (value: string): string => createHash('sha256').update(value).digest('hex')
export function redactChatShareText(value: string, paths: string[]): string {
  let text = redactSensitiveText(value)
  for (const path of [...new Set(paths.filter(value => value.length > 1))].sort((a,b) => b.length - a.length)) text = text.split(path).join('[本机目录]')
  return text.replace(/(?:file:\/\/)?\/(?:Users|home)\/[^\s<>"'`]+/g, '[本机路径]')
    .replace(/\b[A-Z]:\\(?:Users|Documents and Settings)\\[^\r\n<>"'`]+/gi, '[本机路径]')
    .replace(/https?:\/\/[^\s\/@]+:[^\s\/@]+@[^\s<>"']+/gi, '[含凭据地址已遮盖]')
}
export function capturePublicChat(meta: SessionMeta, entries: TranscriptEntry[], paths: string[], now: number): ChatSnapshotSource {
  const messages: ChatSnapshotMessage[] = []
  let pending: { user: string; answer: string[] } | undefined, incompleteTurns = 0, omittedAttachments = 0, omittedEvents = 0, redactedMessages = 0
  const append = (role: ChatSnapshotMessage['role'], raw: string): void => {
    if (!raw.trim()) return
    const text = redactChatShareText(raw, paths)
    if (text !== raw) redactedMessages++
    messages.push({ id: randomUUID(), role, text })
  }
  for (const entry of entries) {
    const event = entry.event
    if (event.kind === 'user-message') {
      if (pending) incompleteTurns++
      pending = { user: event.text, answer: [] }; omittedAttachments += event.attachments?.length ?? 0
    } else if (event.kind === 'assistant-message') {
      if (pending) pending.answer.push(...event.blocks.flatMap(block => block.type === 'text' ? [block.text] : []))
      omittedEvents += event.blocks.filter(block => block.type !== 'text').length
    } else if (event.kind === 'turn-result') {
      if (pending) { append('user', pending.user); append('assistant', event.resultText || pending.answer.join('\n\n')); pending = undefined }
    } else omittedEvents++
  }
  if (pending) incompleteTurns++
  if (messages.length > 1000 || messages.reduce((sum,message) => sum + Buffer.byteLength(message.text), 0) > 2 * 1024 * 1024) throw new Error('已完成对话超过 1000 条或 2 MiB，请先在原任务分叉出需要分享的范围。')
  return { id: randomUUID(), sessionId: meta.id, title: redactChatShareText(meta.title, paths), capturedAt: now, expiresAt: now + 15*60_000,
    messages, redactedMessages, omittedEvents, omittedAttachments, incompleteTurns }
}
export function selectPublicChat(source: ChatSnapshotSource, input: PrepareChatSnapshotInput, paths: string[]): { title: string; messages: ChatSnapshotMessage[]; redactedMessages: number } {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['sourcePreviewId','title','selectedMessageIds','replacements'].includes(key)) ||
    typeof input.title !== 'string' || !input.title.trim() || input.title.length > 500 || !Array.isArray(input.selectedMessageIds) || !input.selectedMessageIds.length || input.selectedMessageIds.length > 1000 ||
    input.selectedMessageIds.some(id => typeof id !== 'string') || input.replacements !== undefined && (!input.replacements || typeof input.replacements !== 'object' || Array.isArray(input.replacements))) throw new Error('请选择消息并填写有效的公开标题。')
  const wanted = new Set(input.selectedMessageIds), selected = source.messages.filter(message => wanted.has(message.id))
  if (selected.length !== wanted.size || Object.keys(input.replacements ?? {}).some(id => !wanted.has(id))) throw new Error('消息不属于原脱敏预览。')
  let redactedMessages = 0
  const messages = selected.map(message => {
    const replacement = input.replacements?.[message.id], raw = replacement === undefined ? message.text : replacement
    if (typeof raw !== 'string' || raw.length > 300_000) throw new Error('公开消息长度无效。')
    const text = redactChatShareText(raw, paths); if (text !== raw) redactedMessages++
    return { id: message.id, role: message.role, text }
  })
  if (messages.reduce((sum,message) => sum + Buffer.byteLength(message.text), 0) > 2*1024*1024) throw new Error('公开正文超过 2 MiB。')
  return { title: redactChatShareText(input.title.trim(), paths), messages, redactedMessages: source.redactedMessages + redactedMessages }
}
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]!)
export function publicChatHtml(title: string, messages: ChatSnapshotMessage[], capturedAt: number): string {
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#f8f8f8;color:#202020;font:15px/1.7 system-ui,sans-serif}main{max-width:820px;margin:0 auto;padding:52px 24px}header{border-bottom:1px solid #ddd;padding-bottom:22px;margin-bottom:30px}h1{font-size:28px;line-height:1.25}header p,footer{color:#666;font-size:12px}.message{margin:22px 0;padding:20px;border-radius:14px;background:white;border:1px solid #e8e8e8}.user{background:#efefef;margin-left:36px}.role{font-size:12px;font-weight:600;color:#666;margin-bottom:8px}.body{white-space:pre-wrap;overflow-wrap:anywhere}footer{margin-top:38px}@media(prefers-color-scheme:dark){body{background:#181818;color:#eee}.message{background:#222;border-color:#333}.user{background:#2a2a2a}header{border-color:#444}header p,footer,.role{color:#aaa}}</style></head><body><main><header><h1>${escapeHtml(title)}</h1><p>EastGenesis · 只读聊天快照 · ${escapeHtml(new Date(capturedAt).toISOString())}</p></header>${messages.map(message => `<article class="message ${message.role}"><div class="role">${message.role === 'user' ? '用户' : 'EastGenesis'}</div><div class="body">${escapeHtml(message.text)}</div></article>`).join('\n')}<footer>这是发布时选定的静态内容，后续对话不会自动加入。</footer></main></body></html>\n`
}
