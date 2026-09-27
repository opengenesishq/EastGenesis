import { redactSensitiveText } from './security/secret-redaction'
import { redactProviderErrorText } from './provider/openai-provider-utils'

export type UpdaterFailureEvent =
  | { kind: 'disabled'; reason: string }
  | { kind: 'error'; message: string }

/**
 * Convert an electron-updater failure into the small public event surface used
 * by the renderer. A missing release feed is expected for a local preview, but
 * authentication, transport and server failures must remain actionable errors.
 */
export function classifyUpdaterFailure(error: unknown): UpdaterFailureEvent {
  const rawMessage = errorMessage(error)
  if (isMissingReleaseFeed(rawMessage)) {
    return { kind: 'disabled', reason: '更新发布地址暂不可用；正式发布后再检查更新' }
  }
  return { kind: 'error', message: sanitizeUpdaterError(rawMessage) }
}

export function sanitizeUpdaterError(value: string): string {
  const redactedUrl = redactProviderErrorText(value)
  const redactedSecrets = redactSensitiveText(redactedUrl)
  return redactedSecrets
    .replace(/(\b(?:x-api-key|api-key|api_key|authorization|proxy-authorization)\b\s*[:=])\s*[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

function isMissingReleaseFeed(value: string): boolean {
  // electron-updater reports missing metadata as either "404 Not Found" or a
  // bare 404. Require both the status and a release-feed marker so an unrelated
  // API 404 is never hidden as an unavailable update channel.
  return /\b404\b/i.test(value) &&
    /(?:latest(?:-[a-z0-9._-]+)?\.ya?ml|releases?\.atom|\/releases?\/(?:latest|download)|\b(?:update|release)\s+(?:feed|metadata)\b)/i.test(value)
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}
