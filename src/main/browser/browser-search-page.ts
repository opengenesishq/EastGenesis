import { createHash } from 'node:crypto'
import { safeSourceText, type BrowserPageSourcePort } from './browser-page-source'
import { assertWorkflowArtifactUriSafe } from '../task/workflow-ledger-artifact-security'
import type { SearchAdapterResult } from '../search/search-broker'

export const BROWSER_SEARCH_ENDPOINT = 'https://www.bing.com/search'
const SEARCH_HOSTS = new Set(['www.bing.com', 'cn.bing.com', 'bing.com'])
export interface BrowserSearchPagePort extends BrowserPageSourcePort {
  navigate(url: string): Promise<unknown>
  stopOwnedNavigation(): void
}

export function browserSearchUrl(query: string): string {
  const url = new URL(BROWSER_SEARCH_ENDPOINT)
  url.searchParams.set('q', query)
  return url.href
}

export function isBrowserSearchPage(value: string, query: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      SEARCH_HOSTS.has(url.hostname) && url.pathname === '/search' && url.searchParams.get('q') === query
  } catch { return false }
}

/** Fixed endpoint + isolated main-frame DOM selectors; callers cannot supply JS or result objects. */
export async function searchBrowserPage(port: BrowserSearchPagePort, query: string, signal: AbortSignal): Promise<SearchAdapterResult> {
  const assertActive = () => { if (signal.aborted) throw new Error('BROWSER_SEARCH_CANCELLED') }
  assertActive()
  const abort = () => port.stopOwnedNavigation()
  signal.addEventListener('abort', abort, { once: true })
  try {
    await port.navigate(browserSearchUrl(query))
    assertActive()
    const url = port.getURL()
    const revision = port.getDocumentRevision()
    // loadURL resolves after the main document commits, but Chromium can keep
    // a subresource spinner alive. The isolated DOM read below is the actual
    // readiness signal for the search result page.
    if (!isBrowserSearchPage(url, query)) throw new Error('BROWSER_SEARCH_PAGE_UNAVAILABLE')
    const raw = await port.executeJavaScriptInIsolatedWorld(1002, [{ code: searchResultsScript() }])
    assertActive()
    if (port.getURL() !== url || port.getDocumentRevision() !== revision || port.isLoading()) throw new Error('BROWSER_SEARCH_PAGE_CHANGED')
    if (!raw || typeof raw !== 'object' || (raw as { url?: unknown }).url !== url || !Array.isArray((raw as { results?: unknown }).results)) throw new Error('BROWSER_SEARCH_INVALID_RESULT')
    const observedAt = Date.now()
    const endpoint = new URL(url); endpoint.search = ''; endpoint.hash = ''
    const citations: SearchAdapterResult['citations'] = []
    const seen = new Set<string>()
    for (const row of (raw as { results: unknown[] }).results.slice(0, 20)) {
      if (!row || typeof row !== 'object') continue
      const entry = row as Record<string, unknown>
      if (typeof entry.href !== 'string' || typeof entry.title !== 'string' || typeof entry.snippet !== 'string') continue
      const target = resultTarget(entry.href)
      if (!target || seen.has(target)) continue
      const title = safeSourceText(entry.title).trim().slice(0, 240)
      const snippet = safeSourceText(entry.snippet).trim().slice(0, 700)
      if (!title || !snippet || !snippet.replaceAll('[内容已隐藏]', '').trim()) continue
      const summary = `搜索摘要（未读取原网页）：${title}\n${snippet}`
      seen.add(target)
      citations.push({ url: target, summary, fetchedAt: observedAt,
        contentDigest: `sha256:${createHash('sha256').update(summary, 'utf8').digest('hex')}`,
        contentKind: 'search_snippet', sourcePageUrl: endpoint.href })
    }
    return { citations, routeReason: 'browser_fallback:bing:main_frame_search_snippets' }
  } finally { signal.removeEventListener('abort', abort) }
}

function resultTarget(value: string): string | undefined {
  try {
    let url = new URL(value)
    // Bing's result href may contain its encoded destination. Decode only this
    // supported redirect shape; never derive a URL from displayed text.
    if (SEARCH_HOSTS.has(url.hostname) && url.pathname === '/ck/a') {
      const target = url.searchParams.get('u')
      if (!target?.startsWith('a1')) return undefined
      url = new URL(Buffer.from(target.slice(2), 'base64url').toString('utf8'))
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || SEARCH_HOSTS.has(url.hostname)) return undefined
    if (/^(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])$/i.test(url.hostname)) return undefined
    assertWorkflowArtifactUriSafe(url.href)
    return url.href
  } catch { return undefined }
}

function searchResultsScript(): string {
  return `(() => {
    const visible = element => element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    const results = [];
    for (const item of Array.from(document.querySelectorAll('#b_results .b_algo')).slice(0, 20)) {
      const link = item.querySelector('h2 a[href]');
      const caption = item.querySelector('.b_caption p, .b_snippet');
      if (!visible(item) || !visible(link) || !visible(caption)) continue;
      results.push({ href: link.href, title: (link.innerText || '').slice(0, 1000), snippet: (caption.innerText || '').slice(0, 4000) });
    }
    return { url: location.href, results };
  })()`
}
