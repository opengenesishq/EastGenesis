import { BROWSER_DEBUG_LIMITS } from '../../shared/browser-debug-types'
import { redactSensitiveText, redactSensitiveValue } from '../security/secret-redaction'

export function debugUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return '[non-http resource]'
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
    return redactSensitiveText(url.href).slice(0, BROWSER_DEBUG_LIMITS.text)
  } catch { return '' }
}
export function debugText(value: unknown): string {
  if (typeof value !== 'string') return ''
  if (value.length > 32_768) return '[oversized text omitted]'
  return redactSensitiveText(value)
    .replace(/https?:\/\/[^\s<>"']+/gi, match => debugUrl(match))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .slice(0, BROWSER_DEBUG_LIMITS.text)
}
export function debugRemoteValue(value: unknown): string {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  if (record.type === 'string') return debugText(record.value)
  if (record.type === 'number' && typeof record.value === 'number') return String(record.value)
  if (record.type === 'boolean' && typeof record.value === 'boolean') return String(record.value)
  if (record.subtype === 'null') return 'null'
  if (record.type === 'undefined') return 'undefined'
  // Do not expand live objects, getters, previews, descriptions, or object handles.
  return '[object omitted]'
}
export function debugEvaluationResult(value: unknown): unknown {
  let nodes = 0
  const limit = (input: unknown, depth: number): unknown => {
    if (++nodes > 500 || depth > 6) return '[truncated]'
    if (typeof input === 'string') return debugText(input)
    if (input === null || typeof input === 'number' || typeof input === 'boolean') return input
    if (Array.isArray(input)) return input.slice(0, 50).map(item => limit(item, depth + 1))
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).slice(0, 50).map(([key, item]) => [debugText(key), limit(item, depth + 1)]))
    return null
  }
  const result = limit(redactSensitiveValue(value), 0)
  return Buffer.byteLength(JSON.stringify(result)) <= BROWSER_DEBUG_LIMITS.resultBytes ? result : '[result exceeded 16 KiB; omitted]'
}
