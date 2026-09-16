import { redactSensitiveText } from '../security/secret-redaction'
import { assertWorkflowArtifactUriSafe, assertWorkflowEvidenceTextSafe } from '../task/workflow-ledger-artifact-security'

export const BROWSER_PAGE_TEXT_LIMIT = 24_000
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

function pageSourceScript(): string {
  return `(() => {
    const limit = ${BROWSER_PAGE_TEXT_LIMIT};
    const root = document.body;
    if (!root) return { url: location.href, text: '', truncated: false };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = [];
    let length = 0, visited = 0, truncated = false, node;
    while ((node = walker.nextNode())) {
      if (++visited > 50000) { truncated = true; break; }
      const parent = node.parentElement;
      if (!parent || parent.closest('script,style,noscript,input,textarea,select,iframe,object,embed,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"]')) continue;
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') continue;
      const range = document.createRange(); range.selectNodeContents(node);
      if (!range.getClientRects().length) continue;
      const text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!text) continue;
      if (length + text.length + (parts.length ? 1 : 0) > limit) {
        const remaining = limit - length - (parts.length ? 1 : 0);
        if (remaining > 0) parts.push(text.slice(0, remaining));
        truncated = true; break;
      }
      parts.push(text); length += text.length + (parts.length > 1 ? 1 : 0);
    }
    return { url: location.href, text: parts.join('\\n'), truncated };
  })()`
}
