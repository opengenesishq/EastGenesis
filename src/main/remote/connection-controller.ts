import { app, ipcMain, powerSaveBlocker } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isIP } from 'node:net'
import { createSecureContext } from 'node:tls'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { DEFAULT_REMOTE_CONNECTION, type RemoteConnectionSettings, type RemoteConnectionState } from '../../shared/remote-connection-types'
import { writeDurableFileSync } from '../durable-file'
import { assertTrustedWorkflowLedgerSender } from '../ipc/workflow-ledger-handlers'
import { startRemoteWebhookServer, stopRemoteWebhookServer } from './webhook-server'
import { getRemoteWebhookStatus, watchRemoteWebhookStatus } from './webhook-status'
import { startRemoteContinuationReconciler, stopRemoteContinuationReconciler } from './reconciler'
import { sessionManager } from '../sessionManager'
import { RemoteConnectionPower } from './connection-power'

let lastError: string | undefined
let pending = Promise.resolve()
const power = new RemoteConnectionPower(powerSaveBlocker)
let keepAwake = false, closing = false, powerLifecycleRegistered = false
function syncPower(): void {
  try { power.setActive(!closing && keepAwake && getRemoteWebhookStatus()?.running === true) }
  catch (error) { lastError = `保持本机唤醒失败：${error instanceof Error ? error.message : String(error)}` }
}
function registerPowerLifecycle(): void {
  if (powerLifecycleRegistered) return
  powerLifecycleRegistered = true
  const unsubscribe = watchRemoteWebhookStatus(syncPower)
  app.once('before-quit', () => { closing = true; syncPower(); unsubscribe() })
}
const path = (): string => join(app.getPath('userData'), 'remote', 'connection.json')
const loopback = (host: string): boolean => host === 'localhost' || host === '::1' || isIP(host) === 4 && host.startsWith('127.')
export function validateRemoteConnectionSettings(value: unknown): RemoteConnectionSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('远程连接设置无效。')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !Object.hasOwn(DEFAULT_REMOTE_CONNECTION, key))) throw new Error('未知的远程连接选项。')
  if (typeof input.enabled !== 'boolean' || !Number.isInteger(input.port) || Number(input.port) < 0 || Number(input.port) > 65535) throw new Error('端口应为 0 至 65535；0 表示自动选择。')
  if (input.keepAwake !== undefined && typeof input.keepAwake !== 'boolean') throw new Error('保持本机唤醒选项无效。')
  for (const key of ['host', 'advertisedHost', 'tlsCertPath', 'tlsKeyPath']) if (typeof input[key] !== 'string' || String(input[key]).length > 4096 || /[\0\r\n]/.test(String(input[key]))) throw new Error('远程连接地址或证书路径无效。')
  const settings = { ...input, keepAwake: input.keepAwake === true, host: String(input.host).trim(), advertisedHost: String(input.advertisedHost).trim(), tlsCertPath: String(input.tlsCertPath).trim(), tlsKeyPath: String(input.tlsKeyPath).trim() } as unknown as RemoteConnectionSettings
  if (settings.host !== 'localhost' && !isIP(settings.host)) throw new Error('监听地址应为本机 IP、127.0.0.1、0.0.0.0 或 ::。')
  if (settings.advertisedHost && !isIP(settings.advertisedHost) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(settings.advertisedHost)) throw new Error('手机访问地址只填主机名或 IP，不含协议和端口。')
  if (Boolean(settings.tlsCertPath) !== Boolean(settings.tlsKeyPath)) throw new Error('请同时选择 TLS 证书和私钥。')
  for (const item of [settings.tlsCertPath, settings.tlsKeyPath]) if (item && !isAbsolute(item)) throw new Error('证书和私钥必须使用绝对路径。')
  if (settings.enabled && !loopback(settings.host) && (!settings.tlsCertPath || !settings.advertisedHost)) throw new Error('手机连接需要 TLS 证书、私钥和手机可达的主机名或 IP。')
  if (settings.enabled && !loopback(settings.host) && (loopback(settings.advertisedHost) || ['0.0.0.0', '::'].includes(settings.advertisedHost))) throw new Error('手机访问地址不能是回环地址或通配监听地址。')
  return settings
}
function readSettings(): RemoteConnectionSettings {
  try { return validateRemoteConnectionSettings(JSON.parse(readFileSync(path(), 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_REMOTE_CONNECTION }; throw error }
}
function tls(settings: RemoteConnectionSettings): { cert: Buffer; key: Buffer } | undefined {
  if (!settings.tlsCertPath) return undefined
  const value = { cert: readFileSync(settings.tlsCertPath), key: readFileSync(settings.tlsKeyPath) }
  createSecureContext(value)
  const certificate = new X509Certificate(value.cert)
  if (!certificate.checkPrivateKey(createPrivateKey(value.key))) throw new Error('TLS 私钥与证书不匹配。')
  if (Date.now() < Date.parse(certificate.validFrom) || Date.now() >= Date.parse(certificate.validTo)) throw new Error('TLS 证书尚未生效或已过期。')
  const host = settings.advertisedHost || settings.host
  if (isIP(host) ? !certificate.checkIP(host) : !certificate.checkHost(host)) throw new Error('TLS 证书不包含手机访问地址。')
  return value
}
function state(): RemoteConnectionState {
  const current = getRemoteWebhookStatus(), settings = readSettings()
  const advertised = settings.advertisedHost || current?.host
  const host = advertised && isIP(advertised) === 6 ? `[${advertised}]` : advertised
  return { settings, running: current?.running ?? false, keepingAwake: power.active, address: current?.running ? `${current.protocol}://${host}:${current.port}` : undefined, error: lastError }
}
async function apply(settings: RemoteConnectionSettings): Promise<void> {
  const certificate = settings.enabled ? tls(settings) : undefined
  registerPowerLifecycle()
  keepAwake = false; syncPower()
  stopRemoteContinuationReconciler()
  await stopRemoteWebhookServer()
  try {
    if (settings.enabled) {
      const address = await startRemoteWebhookServer({ rootDir: app.getPath('userData'), host: settings.host, port: settings.port,
        advertisedHost: settings.advertisedHost, tls: certificate })
      // Save an automatic port so an existing mobile URL remains valid after restart.
      if (settings.port === 0) { settings.port = address.port; writeDurableFileSync(path(), JSON.stringify(settings)) }
      startRemoteContinuationReconciler(app.getPath('userData'))
      keepAwake = settings.keepAwake; syncPower()
    }
  } catch (error) {
    keepAwake = false; syncPower(); stopRemoteContinuationReconciler()
    await stopRemoteWebhookServer()
    throw error
  }
}
export async function initializeRemoteConnection(): Promise<void> {
  registerPowerLifecycle()
  const job = pending.catch(() => undefined).then(async () => {
    try {
      if (!existsSync(path()) && process.env.CAOGEN_ENABLE_REMOTE_CONTINUATION === '1') {
        const migrated = validateRemoteConnectionSettings({ ...DEFAULT_REMOTE_CONNECTION, enabled: true,
          host: process.env.CAOGEN_REMOTE_WEBHOOK_HOST || '127.0.0.1', port: Number(process.env.CAOGEN_REMOTE_WEBHOOK_PORT || 0),
          advertisedHost: process.env.CAOGEN_REMOTE_WEBHOOK_ADVERTISE_HOST || '',
          tlsCertPath: process.env.CAOGEN_REMOTE_WEBHOOK_TLS_CERT || '', tlsKeyPath: process.env.CAOGEN_REMOTE_WEBHOOK_TLS_KEY || '' })
        tls(migrated); writeDurableFileSync(path(), JSON.stringify(migrated))
      }
      const settings = readSettings()
      if (settings.enabled) await apply(settings)
    } catch (error) { lastError = error instanceof Error ? error.message : String(error) }
  })
  pending = job
  return job
}
export function registerRemoteConnectionIpc(): void {
  registerPowerLifecycle()
  ipcMain.handle('remote-connection:get', event => { assertTrustedWorkflowLedgerSender(event); return state() })
  ipcMain.handle('remote-connection:save', (event, input: unknown) => {
    assertTrustedWorkflowLedgerSender(event)
    const next = validateRemoteConnectionSettings(input)
    // Validate certificate before replacing a working listener or persisted preference.
    if (next.enabled) tls(next)
    const job = pending.catch(() => undefined).then(async () => {
      await sessionManager.whenInitialized()
      writeDurableFileSync(path(), JSON.stringify(next))
      lastError = undefined
      try { await apply(next) } catch (error) { lastError = error instanceof Error ? error.message : String(error) }
      return state()
    })
    pending = job.then(() => undefined, () => undefined)
    return job
  })
}
