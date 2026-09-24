import { redactSensitiveText } from '../security/secret-redaction'
import { assertWorkflowArtifactUriSafe, assertWorkflowEvidenceTextSafe } from '../task/workflow-ledger-artifact-security'

import { BROWSER_PAGE_TEXT_LIMIT, pageSourceScript } from '../../shared/browser-source-script'
export { BROWSER_PAGE_TEXT_LIMIT } from '../../shared/browser-source-script'
const SOURCE_WORLD_ID = 1001

export interface BrowserPageSource {
  url: string
  title: string
  text: string
  truncated: boolean
  observedAt: number
  filtered: boolean
}

/** Only Electron's main-frame WebContents is supplied here, never a model script. */
export interface BrowserPageSourcePort {
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  /** Monotonic main-frame navigation counter, including same-URL reloads. */
  getDocumentRevision(): number
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>
}

export async function readBrowserPageSource(port: BrowserPageSourcePort, now = Date.now): Promise<BrowserPageSource> {
  const documentRevision = port.getDocumentRevision()
  const url = requireSourceUrl(port.getURL())
  if (port.isLoading()) throw new Error('BROWSER_SOURCE_LOADING：页面仍在加载，请完成后再读取。')
  const title = safeSourceText(port.getTitle()).trim().slice(0, 240) || new URL(url).hostname
  // Isolated world keeps page-authored JS from replacing the reader's DOM APIs.
  const value = await port.executeJavaScriptInIsolatedWorld(SOURCE_WORLD_ID, [{ code: pageSourceScript() }])
  if (port.isLoading() || port.getURL() !== url || port.getDocumentRevision() !== documentRevision) throw new Error('BROWSER_SOURCE_CHANGED：读取期间页面已切换，未登记来源。')
  if (!value || typeof value !== 'object') throw new Error('BROWSER_SOURCE_INVALID：页面没有返回可核验正文。')
  const page = value as Record<string, unknown>
  if (page.url !== url || typeof page.text !== 'string' || typeof page.truncated !== 'boolean' || page.text.length > BROWSER_PAGE_TEXT_LIMIT) {
    throw new Error('BROWSER_SOURCE_INVALID：页面正文与主框架来源不一致。')
  }
  const text = safeSourceText(page.text).trim()
  if (!text || !text.replaceAll('[内容已隐藏]', '').trim()) throw new Error('BROWSER_SOURCE_EMPTY：未读到可引用正文，未登记来源。')
  return { url, title, text, truncated: page.truncated, observedAt: now(), filtered: text !== page.text.trim() }
}

export function requireSourceUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('BROWSER_SOURCE_URL：当前页面没有有效网页地址。') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('BROWSER_SOURCE_URL：仅 HTTP/S 网页可登记研究来源。')
  assertWorkflowArtifactUriSafe(value)
  return value
}

/** Do not send form values or credential-bearing lines to the model or ledger. */
export function safeSourceText(value: string): string {
  // Redact across DOM text-node boundaries first: a label and its value can
  // occupy separate lines, and private-key blocks span multiple lines.
  return redactSensitiveText(value).replace(/\[REDACTED[^\]]*\]/g, '[内容已隐藏]').split(/\r?\n/).map(clean => {
    try { assertWorkflowEvidenceTextSafe(clean, 'workflow evidence summary'); return clean }
    catch { return '[内容已隐藏]' }
  }).join('\n')
}
