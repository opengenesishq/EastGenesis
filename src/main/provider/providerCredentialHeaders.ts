import type { Provider, ProviderInput } from '../../shared/types'
import {
  inspectProviderCustomHeaders,
  isAllowedProviderManagedCredentialHeaderName
} from '../providerCredentialBroker'
import { validateProviderCredentialInput } from './credentialInput'

const BLOCKED_MANAGED_CREDENTIAL_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authorization',
  'set-cookie',
  'transfer-encoding'
])
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

type ProviderCredentialHeaderSource = Pick<
  Provider,
  'authMode' | 'credentialHeaderNames' | 'credentialMigrationRequired'
> & Partial<Pick<Provider, 'engine'>>

type ProviderCredentialHeaderDefaults = Partial<Pick<
  Provider,
  'authMode' | 'credentialHeaderNames' | 'engine'
>>

export function normalizedCustomHeaders(value: string | undefined): string | undefined {
  const inspected = inspectProviderCustomHeaders(value ?? '')
  if (inspected.rejectedNames.length > 0) {
    throw new Error(`自定义请求头只允许非敏感路由元数据字段;已拒绝: ${inspected.rejectedNames.join(', ')}。凭据请使用 API 密钥字段。`)
  }
  return inspected.safeValue.trim() || undefined
}

export function inspectCredentialHeaderNames(value: unknown): { names: string[]; rejected: string[] } {
  if (value === undefined) return { names: [], rejected: [] }
  if (!Array.isArray(value)) return { names: [], rejected: ['credentialHeaderNames'] }
  const names: string[] = []
  const rejected: string[] = []
  const seen = new Set<string>()
  for (const item of value) inspectCredentialHeaderName(item, names, rejected, seen)
  return { names, rejected }
}

export function normalizedCredentialHeaderNames(value: unknown): string[] | undefined {
  const inspected = inspectCredentialHeaderNames(value)
  if (inspected.rejected.length > 0) {
    throw new Error(`受管凭据头名称无效或不安全: ${inspected.rejected.join(', ')}`)
  }
  return inspected.names.length > 0 ? inspected.names : undefined
}

export function resolvedProviderCredentialHeaderNames(
  provider: ProviderCredentialHeaderDefaults | undefined
): string[] {
  const { names } = inspectCredentialHeaderNames(provider?.credentialHeaderNames)
  if (names.length > 0) return names
  if (provider?.authMode === 'none') return []
  if (provider?.engine === 'anthropic') return ['x-api-key']
  if (provider?.engine === 'gemini') return ['x-goog-api-key']
  return ['authorization']
}

export function providerCredentialHeaders(
  provider: ProviderCredentialHeaderSource | undefined,
  token: string
): Record<string, string> {
  if (!token || provider?.authMode === 'none' || provider?.credentialMigrationRequired === true) return {}
  const names = resolvedProviderCredentialHeaderNames(provider)
  return Object.fromEntries(names.map((name) => [
    name,
    name === 'authorization' ? `Bearer ${token}` : token
  ]))
}

export function providerCredentialHeaderLines(
  provider: ProviderCredentialHeaderSource | undefined,
  token: string
): string {
  return Object.entries(providerCredentialHeaders(provider, token))
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

export function assertProviderCredentialInput(input: Partial<ProviderInput>): void {
  validateProviderCredentialInput(input)
}

function inspectCredentialHeaderName(
  value: unknown,
  names: string[],
  rejected: string[],
  seen: Set<string>
): void {
  if (typeof value !== 'string') {
    rejected.push('(non-string header name)')
    return
  }
  const name = value.trim()
  const normalized = name.toLowerCase()
  if (!isSafeManagedCredentialHeaderName(name, normalized)) {
    rejected.push('(unsupported or invalid header name)')
    return
  }
  if (seen.has(normalized)) return
  if (names.length >= 8) {
    rejected.push(name)
    return
  }
  seen.add(normalized)
  names.push(normalized)
}

function isSafeManagedCredentialHeaderName(name: string, normalized: string): boolean {
  return Boolean(name)
    && name.length <= 80
    && HTTP_HEADER_NAME.test(name)
    && !BLOCKED_MANAGED_CREDENTIAL_HEADERS.has(normalized)
    && isAllowedProviderManagedCredentialHeaderName(name)
}
