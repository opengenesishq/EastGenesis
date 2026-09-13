import type { EffectTarget, NotificationConnectorChannel } from '../../shared/types'
import { unresolved, type EffectReconciliationResult } from '../task/effect-reconciliation-result'
import { stableValueDigest } from '../task/tool-idempotency'
import { buildDingTalkWebhookPayload, sendDingTalkNotification } from './dingtalk'
import { buildFeishuWebhookPayload, sendFeishuNotification } from './feishu'
import {
  resolveNotificationConnector,
  type ResolvedNotificationConnector
} from './notification-connector-store'

type WebhookMessageTarget = Extract<EffectTarget, { kind: 'webhook_message_send' }>

interface MessageInput {
  connectorId?: string
  channel?: NotificationConnectorChannel
  title: string
  text: string
  linkUrl?: string
}

export interface MessageSendExecutionResult {
  ok: boolean
  sent: boolean
  channel: NotificationConnectorChannel
  connectorId: string
  status?: number
  responseDigest?: string
  error?: string
}

export function buildWebhookMessageEffectTarget(input: Record<string, unknown>): WebhookMessageTarget {
  const message = messageInput(input)
  const connector = resolveNotificationConnector(message.connectorId, message.channel)
  const payload = messagePayload(connector.channel, message)
  return {
    kind: 'webhook_message_send',
    connectorId: connector.id,
    connectorRevision: connector.revision,
    channel: connector.channel,
    webhookDigest: connector.webhookDigest,
    payloadDigest: stableValueDigest(payload),
    titleDigest: stableValueDigest(message.title),
    textDigest: stableValueDigest(message.text),
    ...(message.linkUrl ? { linkUrlDigest: stableValueDigest(message.linkUrl) } : {})
  }
}

export async function executeWebhookMessageEffectTarget(
  target: WebhookMessageTarget,
  input: Record<string, unknown>
): Promise<MessageSendExecutionResult> {
  const message = messageInput(input)
  const connector = resolveNotificationConnector(target.connectorId, target.channel)
  assertMessageTarget(target, connector, message)
  const options = {
    webhookUrl: connector.webhookUrl,
    secret: connector.secret,
    dryRun: false
  }
  const result = connector.channel === 'feishu'
    ? await sendFeishuNotification(message, options)
    : await sendDingTalkNotification(message, options)
  const receipt = notificationDeliveryReceipt(connector.channel, result)
  return {
    ok: result.ok && result.sent && receipt.confirmed,
    sent: result.sent,
    channel: connector.channel,
    connectorId: connector.id,
    ...(typeof result.status === 'number' ? { status: result.status } : {}),
    ...(typeof result.responseText === 'string' && result.responseText
      ? { responseDigest: stableValueDigest(result.responseText) }
      : {}),
    ...(result.error || receipt.error ? { error: receipt.error ?? '通知发送失败，结果未知' } : {})
  }
}

export function reconcileWebhookMessageEffectTarget(
  target: WebhookMessageTarget
): EffectReconciliationResult {
  return unresolved({
    kind: target.kind,
    connectorId: target.connectorId,
    connectorRevision: target.connectorRevision,
    channel: target.channel,
    webhookDigest: target.webhookDigest,
    payloadDigest: target.payloadDigest,
    reason: 'Webhook 消息平台没有可靠的只读投递查询；未知结果必须人工确认，禁止自动重发'
  })
}

function assertMessageTarget(
  target: WebhookMessageTarget,
  connector: ResolvedNotificationConnector,
  message: MessageInput
): void {
  if (
    connector.id !== target.connectorId ||
    connector.channel !== target.channel ||
    connector.revision !== target.connectorRevision ||
    connector.webhookDigest !== target.webhookDigest
  ) {
    throw new Error('通知连接器已偏离效果审批时版本')
  }
  if (
    stableValueDigest(messagePayload(connector.channel, message)) !== target.payloadDigest ||
    stableValueDigest(message.title) !== target.titleDigest ||
    stableValueDigest(message.text) !== target.textDigest ||
    (message.linkUrl ? stableValueDigest(message.linkUrl) : undefined) !== target.linkUrlDigest
  ) {
    throw new Error('通知消息已偏离效果审批时意图')
  }
}

function messageInput(input: Record<string, unknown>): MessageInput {
  const connectorId = optionalText(input.connectorId, 200)
  const channel = notificationChannel(input.channel)
  if (!connectorId && !channel) throw new Error('send_notification 需要 connectorId 或 channel')
  const title = requiredText(input.title, 'title', 200)
  const text = requiredText(input.text, 'text', 20_000)
  const linkUrl = optionalText(input.linkUrl, 2_048)
  if (linkUrl) {
    const url = new URL(linkUrl)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      throw new Error('linkUrl 只支持无 userinfo 的 HTTP/HTTPS URL')
    }
  }
  return { connectorId, channel, title, text, linkUrl }
}

function messagePayload(channel: NotificationConnectorChannel, input: MessageInput): unknown {
  if (channel === 'feishu') return buildFeishuWebhookPayload(input)
  return buildDingTalkWebhookPayload(input)
}

function notificationChannel(value: unknown): NotificationConnectorChannel | undefined {
  return value === 'feishu' || value === 'dingtalk' ? value : undefined
}

function notificationDeliveryReceipt(
  channel: NotificationConnectorChannel,
  result: { ok: boolean; sent: boolean; responseText?: string }
): { confirmed: boolean; error?: string } {
  if (!result.sent) return { confirmed: false, error: '通知请求未发出' }
  if (!result.ok) return { confirmed: false, error: '通知平台返回非成功 HTTP 状态' }
  if (!result.responseText) return { confirmed: false, error: '通知平台未返回可验证的投递回执' }
  try {
    const parsed = JSON.parse(result.responseText) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { confirmed: false, error: '通知平台投递回执格式无效' }
    }
    const record = parsed as Record<string, unknown>
    const code = channel === 'feishu'
      ? record.code ?? record.StatusCode ?? record.status_code
      : record.errcode
    if (code === 0 || code === '0') return { confirmed: true }
    return { confirmed: false, error: '通知平台回执未确认投递成功' }
  } catch {
    return { confirmed: false, error: '通知平台投递回执不是有效 JSON' }
  }
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /\0/.test(value)) {
    throw new Error(`文本字段无效或超过 ${maxLength} 字符`)
  }
  return value.trim()
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = optionalText(value, maxLength)
  if (!text) throw new Error(`${field} 不能为空`)
  return text
}
