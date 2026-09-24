(() => {
  // src/shared/browser-dom-scripts.ts
  var ACTION_TARGET_KEY = "__caogenApprovedActionTargetV1";
  function clickSelectorScript(selector, guard2) {
    return `(() => {
    const selector = ${JSON.stringify(selector)};
    const el = document.querySelector(selector);
    if (!el) throw new Error('selector not found: ' + selector);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof el.focus === 'function') el.focus();
    ${guard2}
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`;
  }
  function typeTextScript(selector, text2, guard2) {
    return `(() => {
    const selector = ${JSON.stringify(selector)};
    const text = ${JSON.stringify(text2)};
    const el = document.querySelector(selector);
    if (!el) throw new Error('selector not found: ' + selector);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof el.focus === 'function') el.focus();
    ${guard2}
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
  })()`;
  }
  function mutationTargetCheckScript(kind, selector, target) {
    return `if (!globalThis[${JSON.stringify(ACTION_TARGET_KEY)}]?.check(${JSON.stringify(kind)}, ${JSON.stringify(selector ?? null)}, ${JSON.stringify(target ?? null)})) {
    throw new Error('\u6D4F\u89C8\u5668\u76EE\u6807\u6216\u8868\u5355\u5DF2\u53D8\u5316\uFF0C\u539F\u5BA1\u6279\u5931\u6548\uFF1B\u8BF7\u91CD\u65B0\u67E5\u770B\u5E76\u5BA1\u6279\u3002');
  }`;
  }
  function mutationTargetRuntimeScript() {
    return `if (!Object.prototype.hasOwnProperty.call(globalThis, ${JSON.stringify(ACTION_TARGET_KEY)})) {
    const identities = new WeakMap(), snapshots = new WeakMap(); let sequence = 0;
    const identity = object => { if (!identities.has(object)) identities.set(object, String(++sequence)); return identities.get(object); };
    const attributes = element => Array.from(element.attributes || [], attr => [attr.name, attr.value]).sort((a, b) => a[0].localeCompare(b[0]));
    const field = element => {
      const tag = element.tagName.toLowerCase();
      if (tag.includes('-')) throw new Error('\u81EA\u5B9A\u4E49\u8868\u5355\u63A7\u4EF6\u65E0\u6CD5\u6838\u9A8C\u63D0\u4EA4\u503C\uFF0C\u8BF7\u4EBA\u5DE5\u5904\u7406\u3002');
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
        if (!root) throw new Error('\u9875\u9762\u6CA1\u6709\u53EF\u6838\u9A8C\u7684\u6587\u6863\u3002');
        const controls = document.querySelectorAll('input,textarea,select,button');
        if (controls.length > 5000) throw new Error('\u9875\u9762\u8868\u5355\u72B6\u6001\u8FC7\u5927\uFF0C\u8BF7\u4F7F\u7528\u5177\u4F53\u70B9\u51FB\u6216\u8F93\u5165\u5DE5\u5177\u3002');
        return { node: root, snapshot: JSON.stringify({ html: root.outerHTML, controls: Array.from(controls, field) }) };
      }
      if (typeof selector !== 'string' || !selector.trim()) throw new Error('\u6D4F\u89C8\u5668\u64CD\u4F5C\u7F3A\u5C11\u76EE\u6807\u9009\u62E9\u5668\u3002');
      const element = document.querySelector(selector);
      if (!element) throw new Error('\u5BA1\u6279\u76EE\u6807\u5DF2\u4E0D\u5B58\u5728\uFF0C\u8BF7\u91CD\u65B0\u67E5\u770B\u9875\u9762\u3002');
      const owner = element.closest('button,input,a,label,[role="button"],[onclick]') || element;
      const control = owner.tagName === 'LABEL' ? owner.control : undefined;
      const form = element.form || owner.form || control?.form || element.closest('form');
      // Read native control state directly: constructing FormData would fire
      // page-authored formdata handlers during the read-only approval preview.
      if (form && form.elements.length > 5000) throw new Error('\u5173\u8054\u8868\u5355\u72B6\u6001\u8FC7\u5927\uFF0C\u65E0\u6CD5\u6838\u9A8C\u6B64\u6B21\u64CD\u4F5C\u3002');
      const formState = form ? { node: identity(form), attributes: attributes(form), action: form.action, method: form.method,
        enctype: form.enctype, target: form.target, noValidate: form.noValidate, controls: Array.from(form.elements, field) } : undefined;
      return { node: element, snapshot: JSON.stringify({ target: describe(element), action: describe(owner), linkedControl: control ? describe(control) : undefined, form: formState }) };
    };
    const capture = (kind, selector) => {
      const state = observe(kind, selector);
      if (state.snapshot.length > 2000000) throw new Error('\u5BA1\u6279\u76EE\u6807\u72B6\u6001\u8FC7\u5927\uFF0C\u8BF7\u7F29\u5C0F\u64CD\u4F5C\u8303\u56F4\u6216\u4EBA\u5DE5\u5904\u7406\u3002');
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
  }`;
  }
  function waitForSelectorScript(selector, timeoutMs) {
    return `new Promise((resolve, reject) => {
    const selector = ${JSON.stringify(selector)};
    const timeoutMs = ${Math.max(0, Math.min(6e4, Math.round(timeoutMs)))};
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
  })`;
  }

  // src/shared/browser-source-script.ts
  var BROWSER_PAGE_TEXT_LIMIT = 24e3;
  function pageSourceScript() {
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
  })()`;
  }

  // extensions/browser/service-worker.js
  var link;
  var queue = Promise.resolve();
  var text = (value, max = 4e3) => {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("\u53C2\u6570\u65E0\u6548\u3002");
    return value;
  };
  var http = (value) => {
    const url = new URL(text(value, 16384));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("\u53EA\u652F\u6301 HTTP(S) \u7F51\u9875\u3002");
    return url.href;
  };
  var hash = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  var current = (owner) => {
    if (link !== owner || owner.socket.readyState !== WebSocket.OPEN || !owner.epoch || !owner.capability) throw new Error("\u8FDE\u63A5\u5DF2\u65AD\u5F00\uFF0C\u8BF7\u91CD\u65B0\u914D\u5BF9\u3002");
  };
  var send = (owner, value) => {
    current(owner);
    owner.socket.send(JSON.stringify({ ...value, epoch: owner.epoch, capability: owner.capability }));
  };
  var page = (owner) => ({ tabId: `extension-tab:${owner.tabId}`, title: owner.title.slice(0, 500), url: owner.url, revision: owner.revision, loading: owner.loading });
  var assertPage = (owner, revision) => {
    current(owner);
    if (!owner.attached || owner.loading || owner.revision !== revision) throw new Error("\u539F\u6807\u7B7E\u6216\u6587\u6863\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u67E5\u770B\u5E76\u5BA1\u6279\u3002");
  };
  var debug = async (owner, method, args = {}) => {
    current(owner);
    if (!owner.attached) throw new Error("\u8BF7\u5148\u660E\u786E\u6388\u6743\u672C\u6807\u7B7E\u3002");
    return chrome.debugger.sendCommand({ tabId: owner.tabId }, method, args);
  };
  async function revoke(owner = link) {
    if (!owner) return;
    if (link === owner) link = void 0;
    clearInterval(owner.heartbeat);
    if (owner.socket.readyState === WebSocket.OPEN && owner.epoch) owner.socket.send(JSON.stringify({ type: "revoke", epoch: owner.epoch, capability: owner.capability }));
    owner.socket.close();
    owner.rejectPair?.(new Error("\u914D\u5BF9\u5DF2\u53D6\u6D88\u3002"));
    if (owner.attached) {
      owner.attached = false;
      await chrome.debugger.detach({ tabId: owner.tabId }).catch(() => void 0);
    }
    chrome.action.setBadgeText({ text: "" }).catch(() => void 0);
  }
  async function pair(code) {
    if (link) throw new Error("\u8BF7\u5148\u64A4\u9500\u5F53\u524D\u6269\u5C55\u8FDE\u63A5\u3002");
    const match = /^CG1\.(\d{4,5})\.([a-f0-9]{64})$/.exec(text(code, 100));
    if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) throw new Error("\u914D\u5BF9\u7801\u683C\u5F0F\u65E0\u6548\u3002");
    const socket = new WebSocket(`ws://127.0.0.1:${Number(match[1])}/bridge`);
    const owner = { socket, epoch: "", capability: "", taskTitle: "", revision: 1, title: "", url: "", loading: false, attached: false, contextId: void 0, frameId: void 0, seen: /* @__PURE__ */ new Set(), lastPong: Date.now() };
    link = owner;
    const paired = new Promise((resolve, reject) => {
      owner.resolvePair = resolve;
      owner.rejectPair = reject;
    });
    const timer = setTimeout(() => {
      void revoke(owner);
    }, 6e3);
    socket.onopen = () => socket.send(JSON.stringify({ type: "hello", protocol: 1, token: match[2] }));
    socket.onclose = () => {
      clearTimeout(timer);
      void revoke(owner);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      void revoke(owner);
    };
    socket.onmessage = (event) => {
      try {
        if (typeof event.data !== "string" || event.data.length > 2e5) throw new Error("\u65E0\u6548\u6D88\u606F\u3002");
        const message = JSON.parse(event.data);
        if (link !== owner) return;
        if (message.type === "paired" && !owner.epoch) {
          if (message.protocol !== 1 || typeof message.epoch !== "string" || typeof message.capability !== "string" || !/^[a-f0-9]{64}$/.test(message.capability) || typeof message.taskTitle !== "string") throw new Error("\u65E0\u6548\u914D\u5BF9\u54CD\u5E94\u3002");
          owner.epoch = message.epoch;
          owner.capability = message.capability;
          owner.taskTitle = message.taskTitle.slice(0, 200);
          clearTimeout(timer);
          owner.resolvePair();
          owner.rejectPair = void 0;
          owner.heartbeat = setInterval(() => {
            if (Date.now() - owner.lastPong > 6e4) void revoke(owner);
            else {
              try {
                send(owner, { type: "ping" });
              } catch {
                void revoke(owner);
              }
            }
          }, 2e4);
          return;
        }
        if (message.type === "revoked") {
          void revoke(owner);
          return;
        }
        if (message.type === "pong" && message.epoch === owner.epoch) {
          owner.lastPong = Date.now();
          return;
        }
        if (message.type !== "command" || message.protocol !== 1 || message.epoch !== owner.epoch || message.capability !== owner.capability || !owner.attached || message.tabId !== `extension-tab:${owner.tabId}` || typeof message.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(message.requestId) || owner.seen.has(message.requestId)) throw new Error("\u65E0\u6548\u64CD\u4F5C\u6216\u91CD\u653E\u3002");
        if (owner.seen.size >= 1e4) throw new Error("\u8FDE\u63A5\u5DF2\u8FBE\u5230\u64CD\u4F5C\u4E0A\u9650\uFF0C\u8BF7\u91CD\u65B0\u914D\u5BF9\u3002");
        owner.seen.add(message.requestId);
        queue = queue.catch(() => void 0).then(async () => {
          try {
            assertPage(owner, message.expectedRevision);
            const value = await execute(owner, message);
            current(owner);
            if (message.operation !== "navigate") assertPage(owner, message.expectedRevision);
            send(owner, { type: "result", requestId: message.requestId, tabId: message.tabId, revision: owner.revision, ok: true, value });
          } catch (cause) {
            if (link === owner && owner.socket.readyState === WebSocket.OPEN) send(owner, { type: "result", requestId: message.requestId, tabId: message.tabId, revision: owner.revision, ok: false, error: cause instanceof Error ? cause.message.slice(0, 400) : "\u64CD\u4F5C\u5931\u8D25\u3002" });
          }
        });
      } catch {
        void revoke(owner);
      }
    };
    await paired;
    return status();
  }
  async function authorize(tabId) {
    const owner = link;
    if (!owner) throw new Error("\u8BF7\u5148\u914D\u5BF9\u3002");
    current(owner);
    if (owner.attached || !Number.isSafeInteger(tabId)) throw new Error("\u6807\u7B7E\u6388\u6743\u65E0\u6548\u3002");
    const tab = await chrome.tabs.get(tabId);
    current(owner);
    if (!tab.active) throw new Error("\u8BF7\u5728\u8981\u6388\u6743\u7684\u6807\u7B7E\u4E0A\u70B9\u51FB\u6269\u5C55\u56FE\u6807\u3002");
    if (tab.url) http(tab.url);
    owner.url = tab.url || "";
    owner.title = tab.title || "";
    owner.tabId = tabId;
    await chrome.debugger.attach({ tabId }, "1.3");
    owner.attached = true;
    try {
      current(owner);
      const info = await debug(owner, "Page.getFrameTree");
      owner.frameId = info.frameTree.frame.id;
      owner.url = http(info.frameTree.frame.url);
      await debug(owner, "Page.enable");
      await debug(owner, "Runtime.enable");
      const actual = await chrome.tabs.get(tabId);
      current(owner);
      owner.url = http(actual.url || owner.url);
      owner.title = actual.title || "";
      owner.loading = actual.status === "loading";
      send(owner, { type: "ready", page: page(owner) });
      owner.ready = true;
      await chrome.action.setBadgeText({ text: "ON", tabId });
      return status();
    } catch (cause) {
      await revoke(owner);
      throw cause;
    }
  }
  async function isolated(owner, expression, revision) {
    assertPage(owner, revision);
    if (!owner.contextId) {
      const info = await debug(owner, "Page.getFrameTree");
      assertPage(owner, revision);
      owner.frameId = info.frameTree.frame.id;
      const world = await debug(owner, "Page.createIsolatedWorld", { frameId: owner.frameId, worldName: "caogen-extension-fixed-v1", grantUniveralAccess: false });
      assertPage(owner, revision);
      owner.contextId = world.executionContextId;
    }
    const result = await debug(owner, "Runtime.evaluate", { expression, contextId: owner.contextId, returnByValue: true, awaitPromise: true, userGesture: true });
    current(owner);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.slice(0, 350) || result.exceptionDetails.text || "\u7F51\u9875\u64CD\u4F5C\u5931\u8D25\u3002");
    return result.result?.value;
  }
  async function guard(owner, approved, kind) {
    if (!approved || approved.external?.tabId !== `extension-tab:${owner.tabId}` || approved.navigationRevision !== owner.revision || approved.external.pageRevision !== owner.revision || approved.actionTarget?.kind !== kind || typeof approved.documentToken !== "string" || approved.urlDigest !== await hash(owner.url)) throw new Error("\u5F53\u524D\u6269\u5C55\u6807\u7B7E\u4E0E\u5BA1\u6279\u4E0D\u4E00\u81F4\u3002");
    assertPage(owner, approved.navigationRevision);
    return `if(globalThis.__caogenExtensionDocumentV1 !== ${JSON.stringify(approved.documentToken)} || location.href !== ${JSON.stringify(owner.url)}) throw new Error('\u5BA1\u6279\u6587\u6863\u5DF2\u53D8\u5316\u3002');`;
  }
  async function execute(owner, message) {
    const { operation, args, expectedRevision: revision } = message;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("\u64CD\u4F5C\u53C2\u6570\u65E0\u6548\u3002");
    const fields = { read: [], capture: ["kind", "selector"], navigate: ["url", "approved"], click: ["selector", "approved"], type: ["selector", "text", "approved"], screenshot: ["selector"], wait: ["selector", "timeoutMs"] }[operation];
    if (!fields || Object.keys(args).some((key) => !fields.includes(key))) throw new Error("\u6269\u5C55\u4EC5\u63A5\u53D7\u56FA\u5B9A\u6D4F\u89C8\u5668\u52A8\u4F5C\u3002");
    if (operation === "read") return isolated(owner, pageSourceScript(), revision);
    if (operation === "capture") {
      if (!["browser_click", "browser_type", "browser_evaluate"].includes(args.kind)) throw new Error("\u5BA1\u6279\u7C7B\u578B\u65E0\u6548\u3002");
      const selector = args.kind === "browser_evaluate" ? null : text(args.selector);
      const value = await isolated(owner, `(() => { if(!Object.hasOwn(globalThis,'__caogenExtensionDocumentV1')) Object.defineProperty(globalThis,'__caogenExtensionDocumentV1',{value:${JSON.stringify(crypto.randomUUID())}}); ${mutationTargetRuntimeScript()}
      return {documentToken:globalThis.__caogenExtensionDocumentV1,...globalThis.__caogenApprovedActionTargetV1.capture(${JSON.stringify(args.kind)},${JSON.stringify(selector)})}; })()`, revision);
      if (!value || typeof value.snapshot !== "string" || value.snapshot.length > 2e6) throw new Error("\u5BA1\u6279\u5FEB\u7167\u65E0\u6548\u3002");
      const stateDigest = await hash(value.snapshot);
      assertPage(owner, revision);
      return { documentToken: value.documentToken, nodeToken: value.nodeToken, version: value.version, stateDigest };
    }
    if (operation === "click" || operation === "type" || operation === "navigate") {
      const kind = operation === "click" ? "browser_click" : operation === "type" ? "browser_type" : "browser_evaluate";
      const selector = operation === "navigate" ? void 0 : text(args.selector);
      const preamble = await guard(owner, args.approved, kind);
      const check = preamble + mutationTargetCheckScript(kind, selector, args.approved.actionTarget);
      if (operation === "click") return isolated(owner, clickSelectorScript(selector, check), revision);
      if (operation === "type") return isolated(owner, typeTextScript(selector, text(args.text, 65536), check), revision);
      const url = http(args.url);
      await isolated(owner, `(() => { ${check} location.assign(${JSON.stringify(url)});return true; })()`, revision);
      const deadline = Date.now() + 25e3;
      while (owner.revision === revision || owner.loading) {
        current(owner);
        if (Date.now() > deadline) throw new Error("\u5BFC\u822A\u7ED3\u679C\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u68C0\u67E5\u539F\u6807\u7B7E\u3002");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      current(owner);
      return page(owner);
    }
    if (operation === "wait") {
      if (typeof args.timeoutMs !== "number" || !Number.isFinite(args.timeoutMs) || args.timeoutMs < 0 || args.timeoutMs > 25e3) throw new Error("\u7B49\u5F85\u65F6\u95F4\u65E0\u6548\u3002");
      return isolated(owner, waitForSelectorScript(text(args.selector), args.timeoutMs), revision);
    }
    if (operation === "screenshot") {
      let clip;
      if (args.selector !== null && args.selector !== void 0) {
        const selector = text(args.selector);
        clip = await isolated(owner, `(() => { const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('\u622A\u56FE\u5143\u7D20\u4E0D\u5B58\u5728\u3002');const box=node.getBoundingClientRect();return {x:box.x+scrollX,y:box.y+scrollY,width:box.width,height:box.height,scale:1}; })()`, revision);
        if (!clip || ![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) || clip.width <= 0 || clip.height <= 0 || clip.width > 1e4 || clip.height > 1e4 || clip.x < 0 || clip.y < 0) throw new Error("\u622A\u56FE\u533A\u57DF\u65E0\u6548\u3002");
      }
      assertPage(owner, revision);
      const result = await debug(owner, "Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: !!clip, ...clip ? { clip } : {} });
      assertPage(owner, revision);
      if (typeof result.data !== "string" || result.data.length > 24e6) throw new Error("\u622A\u56FE\u8D85\u8FC7\u4E0A\u9650\u3002");
      return result.data;
    }
    throw new Error("\u4E0D\u652F\u6301\u7684\u6269\u5C55\u52A8\u4F5C\u3002");
  }
  function status() {
    if (!link) return { connected: false, extensionId: chrome.runtime.id };
    const url = link.url ? new URL(link.url) : null;
    if (url) {
      url.search = "";
      url.hash = "";
    }
    return { connected: !!link.epoch, attached: link.attached, taskTitle: link.taskTitle, tabId: link.tabId, url: url?.href, extensionId: chrome.runtime.id };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html") || sender.tab) return false;
    Promise.resolve().then(() => {
      if (message?.type === "status") return status();
      if (message?.type === "pair") return pair(message.code);
      if (message?.type === "authorize") return authorize(message.tabId);
      if (message?.type === "revoke") return revoke().then(status);
      throw new Error("\u4E0D\u652F\u6301\u7684\u6269\u5C55\u5165\u53E3\u3002");
    }).then((value) => respond({ ok: true, value }), (cause) => respond({ ok: false, error: cause instanceof Error ? cause.message : "\u64CD\u4F5C\u5931\u8D25\u3002" }));
    return true;
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (link?.attached && source.tabId === link.tabId) void revoke(link);
  });
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const owner = link;
    if (!owner?.attached || source.tabId !== owner.tabId) return;
    try {
      if (method === "Page.frameStartedLoading" && params.frameId === owner.frameId) owner.loading = true;
      else if (method === "Page.frameStoppedLoading" && params.frameId === owner.frameId) owner.loading = false;
      else if (method === "Page.frameNavigated" && !params.frame.parentId) {
        owner.frameId = params.frame.id;
        owner.url = http(params.frame.url);
        owner.revision++;
        owner.contextId = void 0;
      } else if (method === "Page.navigatedWithinDocument" && params.frameId === owner.frameId) {
        owner.url = http(params.url);
        owner.revision++;
      } else if (method === "Runtime.executionContextsCleared") {
        owner.revision++;
        owner.contextId = void 0;
      } else return;
      if (owner.ready) send(owner, { type: "page", page: page(owner) });
    } catch {
      void revoke(owner);
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (link?.tabId === tabId) void revoke(link);
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    const owner = link;
    if (owner?.ready && tabId === owner.tabId && typeof change.title === "string") {
      owner.title = change.title;
      try {
        send(owner, { type: "page", page: page(owner) });
      } catch {
        void revoke(owner);
      }
    }
  });
})();
