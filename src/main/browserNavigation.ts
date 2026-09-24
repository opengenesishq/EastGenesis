export const DEFAULT_BROWSER_URL = 'about:blank'

export function normalizeBrowserNavigationUrl(rawUrl: string): string {
  const text = rawUrl.trim()
  if (!text) throw new Error('URL 不能为空')
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(text) ? text : `https://${text}`
  const url = new URL(withProtocol)
  if (!['http:', 'https:', 'file:', 'about:'].includes(url.protocol)) {
    throw new Error('浏览器只允许 http、https、file 或 about URL')
  }
  return url.href
}
