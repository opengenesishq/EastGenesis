import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  NotificationConnectorChannel,
  NotificationConnectorInput,
  NotificationConnectorView
} from '../../shared/types'
import {
  ProviderCredentialBroker,
  type ProviderCredentialRecord
} from '../providerCredentialBroker'
import { protectedStorage } from '../security/protected-storage-runtime'
import { stableValueDigest } from '../task/tool-idempotency'

interface StoredNotificationConnector {
  schemaVersion: 1
  id: string
  name: string
  channel: NotificationConnectorChannel
  enabled: boolean
  isDefault: boolean
  webhook: ProviderCredentialRecord
  secret?: ProviderCredentialRecord
  webhookDigest: string
  revision: number
  createdAt: number
  updatedAt: number
}

export interface ResolvedNotificationConnector extends NotificationConnectorView {
  webhookUrl: string
  secret?: string
}

const credentialBroker = new ProviderCredentialBroker(protectedStorage)
let cache: StoredNotificationConnector[] | null = null

export function listNotificationConnectors(): NotificationConnectorView[] {
  return load().map(toView).sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name))
}

export function createNotificationConnector(input: NotificationConnectorInput): NotificationConnectorView {
  const webhookUrl = validatedWebhookUrl(input.webhookUrl, input.channel)
  const channel = input.channel ?? detectChannel(webhookUrl)
  const now = Date.now()
  const id = randomUUID()
  const current = cloneConnectors(load())
  const makeDefault = input.makeDefault === true || !current.some((item) => item.channel === channel && item.isDefault)
  const credentialSnapshot = credentialBroker.snapshotProvider(providerRef(id))
  try {
    const connector: StoredNotificationConnector = {
      schemaVersion: 1,
      id,
      name: normalizedName(input.name, channel),
      channel,
      enabled: true,
      isDefault: makeDefault,
      webhook: credentialBroker.store(ref(id, 'webhook'), webhookUrl),
      ...(optionalSecret(input.secret) ? { secret: credentialBroker.store(ref(id, 'secret'), input.secret!.trim()) } : {}),
      webhookDigest: stableValueDigest(webhookUrl),
      revision: 1,
      createdAt: now,
      updatedAt: now
    }
    if (makeDefault) {
      for (const item of current) {
        if (item.channel === channel) item.isDefault = false
      }
    }
    current.push(connector)
    persist(current)
    return toView(connector)
  } catch (error) {
    credentialBroker.restoreProvider(providerRef(id), credentialSnapshot)
    throw error
  }
}

export function deleteNotificationConnector(id: string): boolean {
  const current = cloneConnectors(load())
  const index = current.findIndex((item) => item.id === id)
  if (index < 0) return false
  const [removed] = current.splice(index, 1)
  if (removed.isDefault) {
    const fallback = current.find((item) => item.channel === removed.channel && item.enabled)
    if (fallback) fallback.isDefault = true
  }
  persist(current)
  credentialBroker.forgetProvider(providerRef(removed.id))
  return true
}

export function setDefaultNotificationConnector(id: string): NotificationConnectorView {
  const current = cloneConnectors(load())
  const selected = current.find((item) => item.id === id)
  if (!selected) throw new Error('未找到通知连接器')
  const now = Date.now()
  for (const item of current) {
    if (item.channel !== selected.channel) continue
    const nextDefault = item.id === selected.id
    if (item.isDefault === nextDefault) continue
    item.isDefault = nextDefault
    item.revision += 1
    item.updatedAt = now
  }
  persist(current)
  return toView(selected)
}

export function resolveNotificationConnector(
  connectorId: string | undefined,
  channel: NotificationConnectorChannel | undefined
): ResolvedNotificationConnector {
  const candidates = load().filter((item) => item.enabled)
  const stored = connectorId
    ? candidates.find((item) => item.id === connectorId)
    : candidates.find((item) => item.channel === channel && item.isDefault)
  if (!stored) throw new Error(connectorId ? '未找到可用通知连接器' : `未配置 ${channel ?? '指定渠道'} 默认连接器`)
  if (channel && stored.channel !== channel) throw new Error('通知渠道与连接器不一致')
  const webhook = credentialBroker.resolve(ref(stored.id, 'webhook'), stored.webhook)
  if (!webhook.available) throw new Error('通知连接器凭据在当前设备不可用，请重新配置')
  const secret = stored.secret
    ? credentialBroker.resolve(ref(stored.id, 'secret'), stored.secret)
    : undefined
  if (stored.secret && !secret?.available) throw new Error('通知连接器签名密钥在当前设备不可用，请重新配置')
  return {
    ...toView(stored),
    webhookUrl: webhook.token,
    ...(secret?.available ? { secret: secret.token } : {})
  }
}

function load(): StoredNotificationConnector[] {
  if (cache) return cache
  const file = connectorsFile()
  if (!existsSync(file)) {
    cache = []
    return cache
  }
  try {
    if (process.platform !== 'win32') chmodSync(file, 0o600)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!Array.isArray(parsed) || !parsed.every(isStoredConnector)) {
      throw new Error('连接器记录格式无效')
    }
    assertConnectorSet(parsed)
    cache = cloneConnectors(parsed)
  } catch (error) {
    throw new Error(`通知连接器存储损坏，已拒绝覆盖:${errorText(error)}`)
  }
  return cache
}

function persist(value: StoredNotificationConnector[]): void {
  assertConnectorSet(value)
  const file = connectorsFile()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`
  try {
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
    if (process.platform !== 'win32') chmodSync(file, 0o600)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* best effort */ }
    throw error
  }
  cache = cloneConnectors(value)
}

function connectorsFile(): string {
  return join(app.getPath('userData'), 'notification-connectors.json')
}

function toView(stored: StoredNotificationConnector): NotificationConnectorView {
  const webhook = credentialBroker.resolve(ref(stored.id, 'webhook'), stored.webhook)
  const secret = stored.secret ? credentialBroker.resolve(ref(stored.id, 'secret'), stored.secret) : undefined
  const available = webhook.available && (!stored.secret || secret?.available === true)
  return {
    id: stored.id,
    name: stored.name,
    channel: stored.channel,
    enabled: stored.enabled,
    isDefault: stored.isDefault,
    available,
    credentialStorage: webhook.storage === 'encrypted' && (!secret || secret.storage === 'encrypted')
      ? 'encrypted'
      : available
        ? 'session'
        : 'unavailable',
    webhookDigest: stored.webhookDigest,
    revision: stored.revision,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt
  }
}

function cloneConnectors(value: StoredNotificationConnector[]): StoredNotificationConnector[] {
  return value.map((item) => ({
    ...item,
    webhook: { ...item.webhook },
    ...(item.secret ? { secret: { ...item.secret } } : {})
  }))
}

function validatedWebhookUrl(value: string, requested?: NotificationConnectorChannel): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8_192 || /[\0\r\n]/.test(value)) {
    throw new Error('Webhook URL 不能为空、过长或包含控制字符')
  }
  const url = new URL(value.trim())
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Webhook 必须使用无 userinfo/fragment 的 HTTPS URL')
  }
  const detected = detectChannel(url.toString())
  if (requested && requested !== detected) throw new Error('Webhook URL 与选择的通知渠道不匹配')
  return url.toString()
}

function detectChannel(value: string): NotificationConnectorChannel {
  const url = new URL(value)
  const host = url.hostname.toLowerCase()
  if ((host === 'open.feishu.cn' || host === 'open.larksuite.com') && url.pathname.includes('/open-apis/bot/v2/hook/')) return 'feishu'
  if (host === 'oapi.dingtalk.com' && url.pathname === '/robot/send' && url.searchParams.has('access_token')) return 'dingtalk'
  throw new Error('无法识别 Webhook 渠道；仅支持飞书和钉钉官方机器人地址')
}

function normalizedName(value: string | undefined, channel: NotificationConnectorChannel): string {
  const name = value?.trim()
  if (name && (name.length > 80 || /[\0\r\n]/.test(name))) throw new Error('连接器名称过长或包含控制字符')
  if (name) return name
  return channel === 'feishu' ? '飞书' : '钉钉'
}

function optionalSecret(value: string | undefined): boolean {
  if (value === undefined || value === '') return false
  if (typeof value !== 'string' || !value.trim() || value.length > 8_192 || /[\0\r\n]/.test(value)) {
    throw new Error('签名密钥无效')
  }
  return true
}

function providerRef(id: string): string {
  return `notification:${id}`
}

function ref(id: string, keyId: 'webhook' | 'secret'): { providerId: string; keyId: string } {
  return { providerId: providerRef(id), keyId }
}

function isStoredConnector(value: unknown): value is StoredNotificationConnector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.schemaVersion === 1 &&
    safeStoredText(record.id, 200) &&
    safeStoredText(record.name, 80) &&
    (record.channel === 'feishu' || record.channel === 'dingtalk') &&
    typeof record.enabled === 'boolean' &&
    typeof record.isDefault === 'boolean' &&
    isCredentialRecord(record.webhook) &&
    (record.secret === undefined || isCredentialRecord(record.secret)) &&
    typeof record.webhookDigest === 'string' && /^[a-f0-9]{64}$/.test(record.webhookDigest) &&
    typeof record.revision === 'number' && Number.isSafeInteger(record.revision) && record.revision >= 1 &&
    typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) && record.createdAt >= 0 &&
    typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) && record.updatedAt >= record.createdAt
}

function isCredentialRecord(value: unknown): value is ProviderCredentialRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.encryptedToken === 'string' && record.encryptedToken.length <= 65_536 &&
    (record.sessionOnly === undefined || typeof record.sessionOnly === 'boolean')
}

function safeStoredText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= maxLength && !/[\0\r\n]/.test(value)
}

function assertConnectorSet(value: StoredNotificationConnector[]): void {
  const ids = new Set<string>()
  const defaults = new Set<NotificationConnectorChannel>()
  for (const item of value) {
    if (ids.has(item.id)) throw new Error(`通知连接器 ID 重复:${item.id}`)
    ids.add(item.id)
    if (!item.isDefault) continue
    if (defaults.has(item.channel)) throw new Error(`通知渠道存在多个默认连接器:${item.channel}`)
    defaults.add(item.channel)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
