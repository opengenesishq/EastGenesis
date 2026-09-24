import { BROWSER_STYLE_CSS_PROPERTIES } from '../../shared/browser-style-types'

export const BROWSER_STYLE_WORLD = 1004
const KEY = '__caogenTemporaryStylesV1'
/** Fixed native code only. Renderer input is serialized data, never script or cssText. */
export function browserStyleScript(operation: 'pick' | 'apply' | 'revert' | 'snapshot' | 'release', input: Record<string, unknown>, documentToken: string): string {
  if (operation === 'release') return `(() => globalThis[${JSON.stringify(KEY)}]?.release(${JSON.stringify(input)}) ?? { released: true, conflicts: [] })()`
  return `(async () => { try { return await (() => {
    const key = ${JSON.stringify(KEY)};
    if (!Object.prototype.hasOwnProperty.call(globalThis, key)) {
      const properties = ${JSON.stringify(BROWSER_STYLE_CSS_PROPERTIES)};
      const token = ${JSON.stringify(documentToken)}, entries = new Map();
      let picking;
      const cssPath = element => {
        const parts = []; let node = element;
        while (node && node instanceof HTMLElement) {
          const tag = node.tagName.toLowerCase();
          if (!/^[a-z][a-z0-9-]*$/.test(tag) || parts.length > 40) throw new Error('元素层级不受支持，请选择其他元素。');
          const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(child => child.tagName === node.tagName) : [node];
          parts.unshift(tag + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : ''));
          node = node.parentElement;
        }
        return parts.join(' > ');
      };
      const attributes = node => JSON.stringify(Array.from(node.attributes).filter(attr => attr.name !== 'style').map(attr => [attr.name, attr.value]).sort((a,b) => a[0].localeCompare(b[0])));
      const computed = node => { const style = getComputedStyle(node); return Object.fromEntries(Object.entries(properties).map(([name, css]) => [name, style.getPropertyValue(css).slice(0, 240)])); };
      const inline = (node, name) => ({ value: node.style.getPropertyValue(properties[name]), priority: node.style.getPropertyPriority(properties[name]) });
      const same = (left, right) => left.value === right.value && left.priority === right.priority;
      const connected = entry => entry.node.isConnected && entry.node.ownerDocument === document && document.querySelector(entry.selector) === entry.node;
      const get = input => {
        const entry = entries.get(input.previewId);
        if (!entry || input.documentToken !== token || input.nodeToken !== entry.nodeToken || !connected(entry)) throw new Error('原文档或元素已变化，请重新选择。');
        if (input.expectedRevision !== entry.revision) throw new Error('样式预览版本已变化，请重新载入。');
        return entry;
      };
      const view = entry => ({ documentToken: token, nodeToken: entry.nodeToken, revision: entry.revision, selector: entry.selector, tagName: entry.node.tagName.toLowerCase(),
        computed: computed(entry.node), status: entry.status, conflicts: entry.conflicts, changes: Object.entries(entry.after).map(([property, value]) => ({ property, before: entry.originalComputed[property], after: value.value })) });
      const restore = entry => {
        const conflicts = [];
        if (!entry.node.isConnected || entry.node.ownerDocument !== document) { entries.delete(entry.id); return Object.keys(entry.after); }
        for (const [name, last] of Object.entries(entry.after)) {
          if (!same(inline(entry.node, name), last)) { conflicts.push(name); continue; }
          const original = entry.before[name];
          if (original.value) entry.node.style.setProperty(properties[name], original.value, original.priority);
          else entry.node.style.removeProperty(properties[name]);
        }
        entry.after = {}; entry.conflicts = conflicts; entry.status = conflicts.length ? 'conflict' : 'reverted'; entry.revision++;
        return conflicts;
      };
      const release = input => {
        if (picking?.id === input.previewId) picking.cancel();
        const entry = entries.get(input.previewId);
        if (!entry || input.documentToken && input.documentToken !== token) return { released: true, conflicts: [] };
        const conflicts = restore(entry); entries.delete(input.previewId); return { released: true, conflicts };
      };
      const pick = input => new Promise((resolve, reject) => {
        if (picking) picking.cancel();
        const curtain = document.createElement('div');
        Object.assign(curtain.style, { position: 'fixed', inset: '0', cursor: 'crosshair', zIndex: '2147483646', background: 'transparent' });
        const overlay = document.createElement('div');
        Object.assign(overlay.style, { position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', border: '2px solid #4a9eff', background: '#4a9eff22', display: 'none' });
        document.documentElement.append(curtain, overlay);
        let current, timer, finished = false;
        const cleanup = () => { curtain.remove(); document.removeEventListener('keydown', keydown, true); overlay.remove(); clearTimeout(timer); if (picking?.id === input.previewId) picking = undefined; };
        const cancel = () => { if (finished) return; finished = true; cleanup(); resolve({ cancelled: true }); };
        const elementAt = event => { curtain.style.pointerEvents = 'none'; const node = document.elementFromPoint(event.clientX, event.clientY); curtain.style.pointerEvents = 'auto'; return node; };
        const move = event => {
          event.stopImmediatePropagation();
          const node = elementAt(event);
          if (!(node instanceof HTMLElement) || node === overlay) return;
          current = node; const box = node.getBoundingClientRect();
          Object.assign(overlay.style, { display: 'block', left: box.x + 'px', top: box.y + 'px', width: box.width + 'px', height: box.height + 'px' });
        };
        const click = event => {
          event.preventDefault(); event.stopImmediatePropagation();
          if (finished) return;
          const node = elementAt(event) || current;
          finished = true; cleanup();
          try {
            if (!(node instanceof HTMLElement)) throw new Error('请选择当前主页面中的 HTML 元素。');
            const selector = cssPath(node);
            if (document.querySelector(selector) !== node) throw new Error('元素路径已变化，请重新选择。');
            const entry = { id: input.previewId, node, selector, nodeToken: input.nodeToken, revision: 0, status: 'selected', conflicts: [],
              attributes: attributes(node), originalComputed: computed(node), before: Object.fromEntries(Object.keys(properties).map(name => [name, inline(node, name)])), after: {} };
            entries.set(entry.id, entry); resolve({ cancelled: false, ...view(entry) });
          } catch (error) { reject(error); }
        };
        const keydown = event => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } };
        picking = { id: input.previewId, cancel };
        curtain.addEventListener('mousemove', move, true); curtain.addEventListener('click', click, true); document.addEventListener('keydown', keydown, true);
        for (const name of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'contextmenu', 'wheel']) curtain.addEventListener(name, event => { event.preventDefault(); event.stopImmediatePropagation(); }, { capture: true, passive: false });
        timer = setTimeout(cancel, 60000);
      });
      const apply = input => {
        const entry = get(input), css = input.css;
        if (attributes(entry.node) !== entry.attributes) throw new Error('元素属性已变化，请撤回后重新选择。');
        for (const name of new Set([...Object.keys(entry.after), ...Object.keys(css)])) {
          if (!Object.prototype.hasOwnProperty.call(properties, name) || !same(inline(entry.node, name), entry.after[name] || entry.before[name])) throw new Error('页面已修改样式，请撤回后重新选择。');
        }
        for (const name of Object.keys(entry.after)) if (!Object.prototype.hasOwnProperty.call(css, name)) {
          const original = entry.before[name]; if (original.value) entry.node.style.setProperty(properties[name], original.value, original.priority); else entry.node.style.removeProperty(properties[name]);
          delete entry.after[name];
        }
        for (const [name, value] of Object.entries(css)) { entry.node.style.setProperty(properties[name], value, 'important'); entry.after[name] = inline(entry.node, name); }
        entry.revision++; entry.status = Object.keys(entry.after).length ? 'previewing' : 'reverted'; entry.conflicts = [];
        return view(entry);
      };
      const revert = input => { const entry = get(input); restore(entry); return view(entry); };
      const snapshot = input => { const entry = get(input); if (attributes(entry.node) !== entry.attributes || Object.entries(entry.after).some(([name, last]) => !same(inline(entry.node, name), last))) throw new Error('页面样式已变化，请重新选择。'); return view(entry); };
      Object.defineProperty(globalThis, key, { value: Object.freeze({ pick, apply, revert, snapshot, release }) });
    }
    return globalThis[key][${JSON.stringify(operation)}](${JSON.stringify(input)});
  })(); } catch (error) { return { styleError: String(error?.message || '网页样式预览失败，请重新选择。').slice(0, 300) }; } })()`
}
