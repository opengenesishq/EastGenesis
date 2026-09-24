export const BROWSER_PAGE_TEXT_LIMIT = 24_000

export function pageSourceScript(): string {
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
