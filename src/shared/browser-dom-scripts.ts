import type { EffectTarget } from './effect-types'
type BrowserMutationPage = NonNullable<Extract<EffectTarget, { kind: 'unsupported' }>['browserPage']>
type BrowserMutationKind = NonNullable<BrowserMutationPage['actionTarget']>['kind']
const ACTION_TARGET_KEY = '__caogenApprovedActionTargetV1'

export function clickSelectorScript(selector: string, guard: string): string {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const el = document.querySelector(selector);
    if (!el) throw new Error('selector not found: ' + selector);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof el.focus === 'function') el.focus();
    ${guard}
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`
}

export function typeTextScript(selector: string, text: string, guard: string): string {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const text = ${JSON.stringify(text)};
    const el = document.querySelector(selector);
    if (!el) throw new Error('selector not found: ' + selector);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof el.focus === 'function') el.focus();
    ${guard}
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      el.value = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    }
    throw new Error('selector is not a text input: ' + selector);
  })()`
}

export function mutationTargetCheckScript(kind: BrowserMutationKind, selector: string | undefined, target: BrowserMutationPage['actionTarget']): string {
  return `if (!globalThis[${JSON.stringify(ACTION_TARGET_KEY)}]?.check(${JSON.stringify(kind)}, ${JSON.stringify(selector ?? null)}, ${JSON.stringify(target ?? null)})) {
    throw new Error('浏览器目标或表单已变化，原审批失效；请重新查看并审批。');
  }`
}

/** Raw contents are held only in memory; only their digest is persisted by
 * the host. Comparing the isolated cached bytes is synchronous with the
 * action, without an asynchronous hash gap before a click or text edit. */
export function mutationTargetRuntimeScript(): string {
  return `if (!Object.prototype.hasOwnProperty.call(globalThis, ${JSON.stringify(ACTION_TARGET_KEY)})) {
    const identities = new WeakMap(), snapshots = new WeakMap(); let sequence = 0;
    const identity = object => { if (!identities.has(object)) identities.set(object, String(++sequence)); return identities.get(object); };
    const attributes = element => Array.from(element.attributes || [], attr => [attr.name, attr.value]).sort((a, b) => a[0].localeCompare(b[0]));
    const field = element => {
      const tag = element.tagName.toLowerCase();
      if (tag.includes('-')) throw new Error('自定义表单控件无法核验提交值，请人工处理。');
      return { node: identity(element), tag, attributes: attributes(element), disabled: element.matches(':disabled'),
        value: typeof element.value === 'string' ? element.value : undefined,
        checked: typeof element.checked === 'boolean' ? element.checked : undefined,
        selected: tag === 'select' ? Array.from(element.options, option => ({ node: identity(option), value: option.value, selected: option.selected, disabled: option.disabled })) : undefined,
        files: element.files ? Array.from(element.files, file => ({ node: identity(file), name: file.name, type: file.type, size: file.size, modified: file.lastModified })) : undefined };
    };
    const describe = element => ({ node: identity(element), tag: element.tagName, attributes: attributes(element),
      content: element.innerHTML, value: typeof element.value === 'string' ? element.value : undefined,
      checked: typeof element.checked === 'boolean' ? element.checked : undefined,
      disabled: element.matches(':disabled'), editable: element.isContentEditable,
      href: typeof element.href === 'string' ? element.href : undefined,
      formAction: typeof element.formAction === 'string' ? element.formAction : undefined });
    const observe = (kind, selector) => {
      if (kind === 'browser_evaluate') {
        const root = document.documentElement;
        if (!root) throw new Error('页面没有可核验的文档。');
        const controls = document.querySelectorAll('input,textarea,select,button');
        if (controls.length > 5000) throw new Error('页面表单状态过大，请使用具体点击或输入工具。');
        return { node: root, snapshot: JSON.stringify({ html: root.outerHTML, controls: Array.from(controls, field) }) };
      }
      if (typeof selector !== 'string' || !selector.trim()) throw new Error('浏览器操作缺少目标选择器。');
      const element = document.querySelector(selector);
      if (!element) throw new Error('审批目标已不存在，请重新查看页面。');
      const owner = element.closest('button,input,a,label,[role="button"],[onclick]') || element;
      const control = owner.tagName === 'LABEL' ? owner.control : undefined;
      const form = element.form || owner.form || control?.form || element.closest('form');
      // Read native control state directly: constructing FormData would fire
      // page-authored formdata handlers during the read-only approval preview.
      if (form && form.elements.length > 5000) throw new Error('关联表单状态过大，无法核验此次操作。');
      const formState = form ? { node: identity(form), attributes: attributes(form), action: form.action, method: form.method,
        enctype: form.enctype, target: form.target, noValidate: form.noValidate, controls: Array.from(form.elements, field) } : undefined;
      return { node: element, snapshot: JSON.stringify({ target: describe(element), action: describe(owner), linkedControl: control ? describe(control) : undefined, form: formState }) };
    };
    const capture = (kind, selector) => {
      const state = observe(kind, selector);
      if (state.snapshot.length > 2000000) throw new Error('审批目标状态过大，请缩小操作范围或人工处理。');
      let entries = snapshots.get(state.node); if (!entries) { entries = new Map(); snapshots.set(state.node, entries); }
      const prior = entries.get(kind);
      const version = prior ? prior.version + (prior.snapshot === state.snapshot ? 0 : 1) : 1;
      entries.set(kind, { version, snapshot: state.snapshot });
      return { nodeToken: identity(state.node), version, snapshot: state.snapshot };
    };
    const check = (kind, selector, expected) => {
      if (!expected || expected.kind !== kind) return false;
      const state = observe(kind, selector), prior = snapshots.get(state.node)?.get(kind);
      return expected.nodeToken === identity(state.node) && prior?.version === expected.version && prior.snapshot === state.snapshot;
    };
    Object.defineProperty(globalThis, ${JSON.stringify(ACTION_TARGET_KEY)}, { value: Object.freeze({ capture, check }) });
  }`
}

export function waitForSelectorScript(selector: string, timeoutMs: number): string {
  return `new Promise((resolve, reject) => {
    const selector = ${JSON.stringify(selector)};
    const timeoutMs = ${Math.max(0, Math.min(60_000, Math.round(timeoutMs)))};
    const startedAt = Date.now();
    const tick = () => {
      const el = document.querySelector(selector);
      if (el) { resolve(true); return; }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('selector timeout: ' + selector));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  })`
}

