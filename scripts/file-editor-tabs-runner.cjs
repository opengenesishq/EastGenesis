const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const repoRoot = path.resolve(__dirname, '..')
const outMain = path.join(repoRoot, 'out', 'main', 'index.js')
const root = requiredEnv('CAOGEN_FILE_EDITOR_ROOT')
const statePath = requiredEnv('CAOGEN_FILE_EDITOR_STATE')
const screenshotDir = requiredEnv('CAOGEN_FILE_EDITOR_SCREENSHOTS')
const userDataDir = path.join(root, 'userData')
const projectDir = path.join(root, 'project')
process.env.CAOGEN_USER_DATA_DIR = userDataDir
process.env.CAOGEN_MEMORY_DIR = path.join(root, 'memory')
fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })
fs.mkdirSync(path.join(projectDir, 'src', 'components'), { recursive: true })
fs.writeFileSync(path.join(projectDir, 'src', 'a.ts'), 'export const a = 1\n')
fs.writeFileSync(path.join(projectDir, 'src', 'b.ts'), 'export const b = 1\n')
const searchSource = 'export const searchTarget = "needle-e2e"\nexport function calculateInvoice(total: number): number { return total * 2 }\n'
fs.writeFileSync(path.join(projectDir, 'src', 'components', 'search.ts'), searchSource)
fs.writeFileSync(path.join(projectDir, 'src', 'broken.py'), 'def broken():\n    return (\n')
fs.writeFileSync(path.join(projectDir, 'src', 'semantic.ts'), 'export const total: number = "wrong"\n')
const jsonFixture = '{\n  "name": "CaoGen",\n  "count": 2,\n  "enabled": true,\n  "optional": null\n}\n'
fs.writeFileSync(path.join(projectDir, 'src', 'config.json'), jsonFixture)
const consumerDraft = "import { calculateInvoice } from './components/search'\nexport const invoice = calculateInvo(21)\n"
const consumerCompleted = consumerDraft.replace('calculateInvo(21)', 'calculateInvoice(21)')
fs.writeFileSync(path.join(projectDir, 'src', 'consumer.ts'), consumerDraft)

const checks = []
function check(name, condition, detail = '') {
  checks.push({ name, status: condition ? 'pass' : 'fail', detail })
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`)
  if (!condition) throw new Error(`${name}: ${detail || 'failed'}`)
}

async function run() {
  require(outMain)
  await waitFor(() => ipcMain._invokeHandlers?.has('providers:create') && ipcMain._invokeHandlers?.has('sessions:create'), 10_000)
  const provider = await invoke('providers:create', {
    name: 'File Editor Mock',
    baseUrl: 'http://127.0.0.1:9',
    token: 'test-only',
    models: ['mock-editor'],
    engine: 'openai',
    openaiProtocol: 'responses'
  })
  const alpha = await createSession(provider.id, 'Editor Alpha')
  const beta = await createSession(provider.id, 'Editor Beta')
  await invoke('settings:update', { defaultProviderId: provider.id, defaultModel: 'mock-editor', experienceMode: 'studio' })
  const win = await waitForWindow()
  win.setSize(1200, 800)
  win.webContents.reload()
  await waitForRenderer(win, `document.body.innerText.includes('CaoGen')`)
  await openSessionFiles(win, alpha.id)

  await verifyWorkbenchKeyboard(win)
  await verifySessionTabs(win, alpha.id, beta.id)

  await verifySearchAndCompletion(win)
  await rendererValue(win, `document.querySelector('.file-hover-popover .file-symbol-menu-head button')?.click()`)
  await selectFileBrowserMode(win, 'tree')
  await openFile(win, 'src/semantic.ts')
  await selectFileBrowserMode(win, 'problems')
  await waitForRenderer(win, `document.querySelector('[data-diagnostic-path="src/semantic.ts"][data-diagnostic-code="2322"]') !== null`, 20_000)
  check('Problems view includes a genuine TS2322 semantic type error',
    await rendererValue(win, `Boolean(document.querySelector('[data-diagnostic-path="src/semantic.ts"][data-diagnostic-code="2322"]'))`))
  await rendererValue(win, `document.querySelector('[data-diagnostic-path="src/semantic.ts"][data-diagnostic-code="2322"]')?.click()`)
  await waitForEditorPath(win, 'src/semantic.ts')
  await setEditorText(win, 'export const total: number = 42\n')
  await key(win, 's', { ctrlKey: true })
  await waitForRenderer(win, `document.querySelector('[data-diagnostic-path="src/semantic.ts"]') === null`, 20_000)
  check('fixing and saving clears the semantic diagnostic', await rendererValue(win, `document.querySelector('[data-diagnostic-path="src/semantic.ts"]') === null`))
  check('non-TypeScript files keep the Tree-sitter diagnostics fallback',
    await rendererValue(win, `(() => {
      const row = document.querySelector('[data-diagnostic-path="src/broken.py"][data-diagnostic-source="tree-sitter"]');
      return Boolean(row && row.querySelector('.file-diagnostic-message')?.textContent && row.querySelector('.file-diagnostic-position')?.textContent);
    })()`))
  const pythonPosition = await rendererValue(win, `document.querySelector('[data-diagnostic-path="src/broken.py"] .file-diagnostic-position')?.textContent || ''`)
  await rendererValue(win, `document.querySelector('[data-diagnostic-path="src/broken.py"]')?.click()`)
  await waitForEditorPath(win, 'src/broken.py', 20_000)
  await settleRenderer(win)
  const pythonCaret = await rendererValue(win, `Number(document.querySelector('.file-editor-monaco')?.getAttribute('data-file-editor-cursor-offset') ?? -1)`)
  const [pythonLine, pythonColumn] = pythonPosition.split(':').map(Number)
  const expectedPythonCaret = offsetForLocation(await editorText(win), pythonLine, pythonColumn)
  check('opening a Problem reuses the editor tab path and positions the caret',
    await tabState(win, 'src/broken.py') === 'active' && pythonCaret === expectedPythonCaret,
    `position=${pythonPosition}, caret=${pythonCaret}, expected=${expectedPythonCaret}`)
  await capture(win, 'file-editor-problems.png')
  await setEditorText(win, 'def fixed():\n    return True\n')
  await key(win, 's', { ctrlKey: true })
  await waitForRenderer(win, `document.querySelectorAll('.file-diagnostic-row').length === 0 && document.querySelector('.file-search-summary')?.textContent.trim().startsWith('0')`)
  check('saving a syntax fix refreshes and clears the Problems view', await rendererValue(win, `document.querySelectorAll('.file-diagnostic-row').length === 0`))
  await closeTab(win, 'src/b.ts')
  await closeTab(win, 'src/consumer.ts')
  await closeTab(win, 'src/components/search.ts')
  await closeTab(win, 'src/semantic.ts')
  await selectFileBrowserMode(win, 'tree')
  await openFile(win, 'src/config.json')
  await waitForRenderer(win, `document.querySelector('.file-editor-monaco')?.getAttribute('data-file-editor-language') === 'json'`)
  await waitForRenderer(win, `(() => {
    const spans = [...document.querySelectorAll('.file-editor-monaco .view-lines .view-line span')]
      .filter((span) => span.textContent?.trim());
    return spans.length >= 8 && new Set(spans.map((span) => getComputedStyle(span).color)).size >= 3;
  })()`)
  const jsonRendering = await rendererValue(win, `(() => {
    const root = document.querySelector('.file-editor-monaco');
    const spans = [...document.querySelectorAll('.file-editor-monaco .view-lines .view-line span')]
      .filter((span) => span.textContent?.trim());
    const colors = [...new Set(spans.map((span) => getComputedStyle(span).color))];
    return {
      language: root?.getAttribute('data-file-editor-language') || null,
      text: [...document.querySelectorAll('.file-editor-monaco .view-lines > .view-line')]
        .map((line) => line.textContent || '').join('\\n').replaceAll(String.fromCharCode(160), ' '),
      tokenCount: spans.length,
      colors
    };
  })()`)
  check('JSON files render through the local Monaco language and Monarch token pipeline',
    jsonRendering.language === 'json'
      && jsonRendering.text.includes('"name": "CaoGen"')
      && jsonRendering.text.includes('"count": 2')
      && jsonRendering.text.includes('"enabled": true')
      && jsonRendering.tokenCount >= 8
      && jsonRendering.colors.length >= 3,
    JSON.stringify(jsonRendering))
  await capture(win, 'file-editor-json-highlighting.png')
  await closeTab(win, 'src/config.json')

  await verifyToolDrawerKeyboard(win)

  await settleRenderer(win)
  const desktop = await layoutState(win)
  check('multi-tab editor fits and fills the desktop workbench panel',
    !desktop.documentOverflow && desktop.tabsContained && desktop.panelFillsSide && desktop.filePanelFillsPanel,
    JSON.stringify(desktop))
  check('desktop file actions and editor stay usable inside the panel',
    desktop.controlsContained && desktop.editorUsable && desktop.treeRowsAligned,
    JSON.stringify(desktop))
  await capture(win, 'file-editor-tabs-desktop.png')
  win.setContentSize(960, 640)
  await waitForRenderer(win, `window.innerWidth === 960 && window.innerHeight === 640 && getComputedStyle(document.querySelector('.workbench')).flexDirection === 'row'`)
  await settleRenderer(win)
  const compact = await layoutState(win)
  check('compact desktop file panel fills its workbench side without document overflow',
    !compact.documentOverflow && compact.panelFillsSide && compact.filePanelFillsPanel && !compact.sideFillsViewport,
    JSON.stringify(compact))
  check('compact desktop tabs, actions, and editor remain contained and usable',
    compact.tabsContained && compact.controlsContained && compact.editorUsable && compact.treeViewportUsable && compact.treeRowsAligned,
    JSON.stringify(compact))
  await capture(win, 'file-editor-tabs-compact-desktop.png')

  fs.writeFileSync(statePath, `${JSON.stringify({
    ok: true,
    generatedAt: new Date().toISOString(),
    pass: checks.length,
    total: checks.length,
    screenshots: ['file-editor-content-search.png', 'file-editor-symbol-completion.png', 'file-editor-semantic-hover.png', 'file-editor-problems.png', 'file-editor-json-highlighting.png', 'file-editor-tabs-desktop.png', 'file-editor-tabs-compact-desktop.png'],
    checks
  }, null, 2)}\n`)
  app.exit(0)
}

async function verifySearchAndCompletion(win) {
  await selectFileBrowserMode(win, 'search')
  await setInputValue(win, '.file-content-search input', 'needle-e2e')
  await rendererValue(win, `document.querySelector('.file-content-search button')?.click()`)
  await waitForRenderer(win, `document.querySelectorAll('.file-search-result').length === 1`)
  check('full-text search returns bounded path, line, column, and highlighted snippet',
    await rendererValue(win, `(() => {
      const row = document.querySelector('.file-search-result');
      return row?.querySelector('.file-search-result-path')?.textContent === 'src/components/search.ts'
        && row?.querySelector('.file-search-result-position')?.textContent === '1:30'
        && row?.querySelector('mark')?.textContent === 'needle-e2e';
    })()`))
  await rendererValue(win, `document.querySelector('.file-search-result')?.click()`)
  await waitForEditorPath(win, 'src/components/search.ts')
  check('opening a search result reuses the multi-tab editor path',
    await tabState(win, 'src/components/search.ts') === 'active' && await tabCount(win) === 2)
  await capture(win, 'file-editor-content-search.png')
  await selectFileBrowserMode(win, 'tree')
  await openFile(win, 'src/consumer.ts')
  await setEditorSelection(win, consumerDraft.lastIndexOf('calculateInvo') + 'calculateInvo'.length)
  await nativeKey(win, 'SPACE', [primaryModifier()])
  await waitForRenderer(win, `[...document.querySelectorAll('.file-symbol-result strong')].some((item) => item.textContent === 'calculateInvoice')`, 20_000)
  check('Ctrl+Space returns context-aware completion from the TypeScript LSP', await rendererValue(win, `document.querySelector('[data-file-symbol-source="typescript-lsp"]') !== null && [...document.querySelectorAll('.file-symbol-result strong')].filter((item) => item.textContent === 'calculateInvoice').length === 1`))
  await capture(win, 'file-editor-symbol-completion.png')
  await rendererValue(win, `[...document.querySelectorAll('.file-symbol-result')].find((item) => item.querySelector('strong')?.textContent === 'calculateInvoice')?.click()`)
  await waitFor(() => editorText(win).then((value) => value.includes('calculateInvoice(21)')), 10_000)
  check('selecting an LSP completion replaces only the identifier at the caret', await editorText(win) === consumerCompleted)
  await key(win, 's', { ctrlKey: true })
  await setEditorSelection(win, consumerCompleted.lastIndexOf('calculateInvoice') + 5)
  await nativeKey(win, 'F12')
  await waitForEditorPath(win, 'src/components/search.ts', 20_000)
  check('F12 resolves and opens the LSP source definition', await tabState(win, 'src/components/search.ts') === 'active')
  await setEditorSelection(win, searchSource.indexOf('calculateInvoice') + 5)
  await rendererValue(win, `document.querySelector('.file-editor-hover')?.click()`)
  await waitForRenderer(win, `document.querySelector('.file-hover-content')?.textContent.includes('calculateInvoice')`, 20_000)
  const hoverText = await rendererValue(win, `document.querySelector('[data-file-hover-popover]')?.textContent || ''`)
  check('semantic hover shows the real imported function signature',
    hoverText.includes('TypeScript LSP') && hoverText.includes('calculateInvoice') && /number|\(total: number\)/i.test(hoverText),
    JSON.stringify(hoverText))
  await capture(win, 'file-editor-semantic-hover.png')
}

async function verifySessionTabs(win, alphaId, betaId) {
  await openFile(win, 'src/b.ts')
  check('opening another file keeps both tabs', await tabCount(win) === 2)
  const secondFileState = await editorState(win, 'src/b.ts')
  check('second file becomes active with disk content',
    secondFileState.text === 'export const b = 1\n' && secondFileState.tab === 'active',
    JSON.stringify(secondFileState))
  await activateTab(win, 'src/a.ts')
  const restoredDraftState = await editorState(win, 'src/a.ts')
  check('returning to the first tab restores its unsaved draft',
    restoredDraftState.text === 'export const a = 2\n',
    JSON.stringify(restoredDraftState))
  await key(win, 'Tab', { ctrlKey: true })
  check('Ctrl+Tab cycles to the next open file', await tabState(win, 'src/b.ts') === 'active')
  await key(win, 'Tab', { ctrlKey: true, shiftKey: true })
  check('Ctrl+Shift+Tab cycles backward', await tabState(win, 'src/a.ts') === 'active')
  await openSessionFiles(win, betaId)
  check('a different Session starts with no inherited tabs', await tabCount(win) === 0)
  await openFile(win, 'src/a.ts')
  check('same path in another Session reads the saved disk version', await editorText(win) === 'export const a = 1\n')
  await setEditorText(win, 'export const beta = 1\n')
  await openSessionFiles(win, alphaId)
  check('switching back restores the original Session tab set and draft',
    await tabCount(win) === 2 && await editorText(win) === 'export const a = 2\n')
  await rendererValue(win, `(window.confirm = () => false, true)`)
  await closeTab(win, 'src/a.ts')
  check('cancelling dirty close preserves the tab and draft',
    await tabCount(win) === 2 && await editorText(win) === 'export const a = 2\n')
  await rendererValue(win, `(window.confirm = () => true, true)`)
  await closeTab(win, 'src/a.ts')
  check('confirming dirty close discards only that tab and activates its neighbor',
    await tabCount(win) === 1 && await tabState(win, 'src/b.ts') === 'active')
  await setEditorText(win, 'export const b = 2\n')
  await key(win, 's', { ctrlKey: true })
  await waitFor(() => fs.readFileSync(path.join(projectDir, 'src', 'b.ts'), 'utf8') === 'export const b = 2\n', 10_000)
  await waitForRenderer(win, `document.querySelector('[data-file-tab-active="true"]')?.getAttribute('data-file-tab-dirty') !== 'true'`)
  check('Ctrl+S saves through the production file Effect path', !await tabDirty(win, 'src/b.ts'))
}

async function verifyWorkbenchKeyboard(win) {
  const widthBeforeKeyboardResize = await rendererValue(win, `Number(document.querySelector('.workbench-side-gutter')?.getAttribute('aria-valuenow'))`)
  await rendererValue(win, `document.querySelector('.workbench-side-gutter')?.focus()`)
  await key(win, 'ArrowLeft')
  check('vertical workbench separator supports keyboard resizing',
    await rendererValue(win, `Number(document.querySelector('.workbench-side-gutter')?.getAttribute('aria-valuenow')) > ${widthBeforeKeyboardResize}`))
  await rendererValue(win, `document.querySelector('[data-developer-view="files"]')?.focus()`)
  await key(win, 'ArrowRight')
  await waitForRenderer(win, `document.querySelector('[data-developer-view="tests"]')?.getAttribute('aria-selected') === 'true'`)
  check('ArrowRight moves the Code workspace tab and roving focus to Tests', await rendererValue(win, `document.activeElement?.getAttribute('data-developer-view') === 'tests'`))
  await key(win, 'ArrowLeft')
  await waitForRenderer(win, `document.querySelector('[data-developer-view="files"]')?.getAttribute('aria-selected') === 'true'`)
  check('ArrowLeft returns the Code workspace tab and focus to Files', await rendererValue(win, `document.activeElement?.getAttribute('data-developer-view') === 'files'`))
  check('project browser renders hierarchical directory rows with basename labels', await rendererValue(win, `document.querySelector('.file-row-directory[title="src"] .file-row-path')?.textContent === 'src'`))
  await rendererValue(win, `document.querySelector('[data-file-browser-mode="tree"]')?.focus()`)
  await key(win, 'ArrowRight')
  await waitForRenderer(win, `document.querySelector('[data-file-browser-mode="search"]')?.getAttribute('aria-selected') === 'true'`)
  check('file browser tabs support ArrowRight selection and roving focus', await rendererValue(win, `document.activeElement?.getAttribute('data-file-browser-mode') === 'search'`))
  await key(win, 'ArrowLeft')
  await waitForRenderer(win, `document.querySelector('[data-file-browser-mode="tree"]')?.getAttribute('aria-selected') === 'true'`)
  await rendererValue(win, `document.querySelector('[data-file-tree-path="src"]')?.focus()`)
  await key(win, 'ArrowLeft')
  await waitForRenderer(win, `document.querySelector('[data-file-tree-path="src"]')?.getAttribute('aria-expanded') === 'false'`)
  await key(win, 'ArrowRight')
  await waitForRenderer(win, `document.querySelector('[data-file-tree-path="src"]')?.getAttribute('aria-expanded') === 'true'`)
  await key(win, 'ArrowDown')
  check('file tree arrows collapse, expand, and enter the first child', await rendererValue(win, `document.activeElement?.getAttribute('data-file-tree-path')?.startsWith('src/') === true`))
  await rendererValue(win, `document.querySelector('[data-file-tree-path="src/a.ts"]')?.focus()`)
  await key(win, 'Enter')
  await waitForEditorPath(win, 'src/a.ts')
  check('Enter opens the focused file tree item as the only active tab',
    await tabState(win, 'src/a.ts') === 'active' && await tabCount(win) === 1)
  await setEditorText(win, 'export const a = 2\n')
  check('typing marks the active tab dirty', await tabDirty(win, 'src/a.ts'))
}

async function verifyToolDrawerKeyboard(win) {
  await rendererValue(win, `document.querySelector('.desk-rail-drawer-anchor .desk-rail-button')?.click()`)
  await waitForRenderer(win, `document.activeElement?.getAttribute('role') === 'menuitem'`)
  await key(win, 'End')
  check('tool drawer supports Home/End and arrow-style menu focus', await rendererValue(win, `document.activeElement === document.querySelector('.desk-tool-item:last-child')`))
  await key(win, 'Escape')
  check('Escape closes the tool drawer and restores trigger focus', await rendererValue(win, `document.querySelector('.desk-tool-drawer') === null && document.activeElement === document.querySelector('.desk-rail-drawer-anchor .desk-rail-button')`))
}

async function createSession(providerId, title) {
  return invoke('sessions:create', {
    cwd: projectDir,
    engine: 'openai',
    providerId,
    model: 'mock-editor',
    routingScope: 'fixed',
    taskStrategy: 'execute',
    isolated: false,
    title
  })
}

async function openSessionFiles(win, sessionId) {
  await selectSession(win, sessionId)
  await openFiles(win)
  const activePath = await rendererValue(win, `document.querySelector('[data-file-tab-active="true"]')?.getAttribute('data-file-tab') || null`)
  if (activePath) await waitForEditorPath(win, activePath)
}

async function selectSession(win, sessionId) {
  await waitForRenderer(win, `Boolean(document.querySelector('.session-card[data-session-id="${sessionId}"]'))`)
  await rendererValue(win, `document.querySelector('.session-card[data-session-id="${sessionId}"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.session-card[data-session-id="${sessionId}"]')?.classList.contains('active')`)
  await settleRenderer(win)
}

async function openFiles(win) {
  await rendererValue(win, `document.querySelector('[data-experience-mode-option="studio"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.experience-pane')?.getAttribute('data-experience-mode') === 'studio'`)
  await waitForRenderer(win, `document.querySelector('[data-studio-projection-tab="session"]') !== null`)
  await rendererValue(win, `document.querySelector('[data-studio-projection-tab="session"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('[data-studio-projection-tab="session"]')?.getAttribute('aria-selected') === 'true'`)
  await rendererValue(win, `document.querySelector('[aria-label="打开工具抽屉"]')?.click()`)
  await waitForRenderer(win, `document.querySelector('.desk-tool-drawer') !== null`)
  await rendererValue(win, `[...document.querySelectorAll('.desk-tool-item')].find((button) => button.textContent.trim() === '文件')?.click()`)
  await waitForRenderer(win, `document.querySelector('.file-panel') !== null`)
  await waitForRenderer(win, `document.querySelector('.file-row-directory[title="src"]') !== null`)
  await expandDirectory(win, 'src')
  await waitForRenderer(win, `document.querySelectorAll('.file-row-file').length >= 2`)
}

async function openFile(win, filePath) {
  const segments = filePath.split('/')
  for (let index = 1; index < segments.length; index += 1) {
    await expandDirectory(win, segments.slice(0, index).join('/'))
  }
  await rendererValue(win, `document.querySelector('.file-row[title=${JSON.stringify(filePath)}]')?.click()`)
  await waitForEditorPath(win, filePath)
}

async function expandDirectory(win, directoryPath) {
  await waitForRenderer(win, `document.querySelector('.file-row-directory[title=${JSON.stringify(directoryPath)}]') !== null`)
  const expanded = await rendererValue(win, `document.querySelector('.file-row-directory[title=${JSON.stringify(directoryPath)}]')?.getAttribute('aria-expanded') === 'true'`)
  if (!expanded) {
    await rendererValue(win, `document.querySelector('.file-row-directory[title=${JSON.stringify(directoryPath)}]')?.click()`)
    await waitForRenderer(win, `document.querySelector('.file-row-directory[title=${JSON.stringify(directoryPath)}]')?.getAttribute('aria-expanded') === 'true'`)
  }
}

async function selectFileBrowserMode(win, mode) {
  const index = mode === 'tree' ? 1 : mode === 'search' ? 2 : 3
  await rendererValue(win, `document.querySelector('.file-browser-modes button:nth-child(${index})')?.click()`)
  await waitForRenderer(win, `document.querySelector('.file-browser-modes button:nth-child(${index})')?.getAttribute('aria-selected') === 'true'`)
}

async function setInputValue(win, selector, value) {
  await rendererValue(win, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await waitForRenderer(win, `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`)
}

async function activateTab(win, filePath) {
  await rendererValue(win, `document.querySelector('[data-file-tab=${JSON.stringify(filePath)}] .file-editor-tab-select')?.click()`)
  await waitForRenderer(win, `document.querySelector('[data-file-tab=${JSON.stringify(filePath)}]')?.getAttribute('data-file-tab-active') === 'true'`)
  await waitForEditorPath(win, filePath)
}

async function closeTab(win, filePath) {
  await rendererValue(win, `document.querySelector('[data-file-tab-close=${JSON.stringify(filePath)}]')?.click()`)
  await settleRenderer(win)
}

async function setEditorText(win, value) {
  await focusEditor(win)
  await nativeKey(win, 'A', [primaryModifier()])
  // Monaco applies language auto-indent while pasting multiline text. Strip
  // explicit line prefixes for the paste, then remove the auto-indent that
  // remains on the final empty line so the fixture matches the requested text.
  const insertion = value.replace(/\n[ \t]+/g, '\n')
  await win.webContents.insertText(insertion)
  let current = await editorText(win)
  while (current.length > value.length && current.startsWith(value) && /^\s+$/.test(current.slice(value.length))) {
    await nativeKey(win, 'BACKSPACE')
    current = await editorText(win)
  }
  await waitFor(
    () => editorText(win).then((current) => current === value),
    10_000,
    async () => JSON.stringify({
      expected: value,
      actual: await editorText(win),
      active: await rendererValue(win, `document.activeElement?.outerHTML?.slice(0, 240) || null`)
    })
  )
  await waitForRenderer(win, `document.querySelector('[data-file-tab-active="true"]')?.getAttribute('data-file-tab-dirty') === 'true'`)
}

async function setEditorSelection(win, position) {
  await focusEditor(win)
  await nativeKey(win, 'A', [primaryModifier()])
  await nativeKey(win, 'LEFT')
  for (let offset = 0; offset < Number(position); offset += 1) {
    sendNativeKey(win, 'RIGHT')
    if (offset % 16 === 15) await settleRenderer(win)
  }
  await settleRenderer(win)
  await waitForRenderer(win, `Number(document.querySelector('.file-editor-monaco')?.getAttribute('data-file-editor-cursor-offset')) === ${Number(position)}`)
}

function editorText(win) {
  return rendererValue(win, `(() => {
    const lines = [...document.querySelectorAll('.file-editor-monaco .view-lines > .view-line')];
    return lines.map((line) => line.textContent || '').join('\\n').replaceAll(String.fromCharCode(160), ' ');
  })()`)
}

async function editorState(win, filePath) {
  return {
    path: await rendererValue(win, `document.querySelector('.file-editor-monaco')?.getAttribute('data-file-editor-path') || null`),
    tab: await tabState(win, filePath),
    label: await rendererValue(win, `document.querySelector('.file-editor-monaco [role="textbox"]')?.getAttribute('aria-label') || null`),
    lineCount: await rendererValue(win, `document.querySelectorAll('.file-editor-monaco .view-lines > .view-line').length`),
    text: await editorText(win)
  }
}

function waitForEditorPath(win, filePath, timeoutMs = 10_000) {
  const pathValue = JSON.stringify(filePath)
  const labelValue = JSON.stringify(`Editor: ${filePath}`)
  return waitForRenderer(win, `(() => {
    const root = document.querySelector('.file-editor-monaco');
    const input = root?.querySelector('[role="textbox"]');
    return root?.getAttribute('data-file-editor-path') === ${pathValue}
      && input?.getAttribute('aria-label') === ${labelValue}
      && root.querySelectorAll('.view-lines > .view-line').length > 0;
  })()`, timeoutMs)
}

async function focusEditor(win) {
  await rendererValue(win, `document.querySelector('.file-editor-monaco [role="textbox"]')?.focus()`)
  await waitForRenderer(win, `document.activeElement?.matches('.file-editor-monaco [role="textbox"]') === true`)
}

async function nativeKey(win, keyCode, modifiers = []) {
  sendNativeKey(win, keyCode, modifiers)
  await settleRenderer(win)
}

function sendNativeKey(win, keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

function primaryModifier() {
  return process.platform === 'darwin' ? 'meta' : 'control'
}

function offsetForLocation(content, lineValue, columnValue) {
  const lines = content.split('\n')
  const line = Math.max(1, Math.min(Math.floor(lineValue), lines.length))
  return Math.min(content.length, lines.slice(0, line - 1).reduce((total, item) => total + item.length + 1, 0) + Math.max(0, Math.floor(columnValue) - 1))
}

function tabCount(win) {
  return rendererValue(win, `document.querySelectorAll('[data-file-tab]').length`)
}

function tabState(win, filePath) {
  return rendererValue(win, `document.querySelector('[data-file-tab=${JSON.stringify(filePath)}]')?.getAttribute('data-file-tab-active') === 'true' ? 'active' : 'inactive'`)
}

function tabDirty(win, filePath) {
  return rendererValue(win, `document.querySelector('[data-file-tab=${JSON.stringify(filePath)}]')?.getAttribute('data-file-tab-dirty') === 'true'`)
}

async function key(win, keyValue, modifiers = {}) {
  await rendererValue(win, `(() => {
    const target = ${modifiers.ctrlKey && (keyValue === 's' || keyValue === 'Tab') ? 'window' : '(document.activeElement instanceof HTMLElement ? document.activeElement : window)'};
    const event = new KeyboardEvent('keydown', {
      key: ${JSON.stringify(keyValue)},
      code: ${JSON.stringify(modifiers.code || '')},
      bubbles: true,
      cancelable: true,
      ctrlKey: ${Boolean(modifiers.ctrlKey)},
      shiftKey: ${Boolean(modifiers.shiftKey)}
    });
    target.dispatchEvent(event);
  })()`)
  await settleRenderer(win)
}

async function layoutState(win) {
  return rendererValue(win, `(() => {
    const tabs = [...document.querySelectorAll('[data-file-tab]')];
    const side = document.querySelector('.workbench-side');
    const panel = document.querySelector('.workbench-side > .workbench-panel:not([aria-hidden="true"])');
    const filePanel = document.querySelector('.file-panel');
    const treeViewport = document.querySelector('.file-list-scroll');
    const editor = document.querySelector('.file-editor-monaco');
    const controls = [...document.querySelectorAll('.workspace-diff-actions .btn, .file-row-preview, .file-editor-tab-close, .file-editor-head .btn')];
    const treeRow = document.querySelector('.file-row-directory[title="src"]');
    const sideRect = side?.getBoundingClientRect();
    const panelRect = panel?.getBoundingClientRect();
    const fileRect = filePanel?.getBoundingClientRect();
    const treeViewportRect = treeViewport?.getBoundingClientRect();
    const editorRect = editor?.getBoundingClientRect();
    const treeRowRect = treeRow?.getBoundingClientRect();
    const treeRowChildren = treeRow ? [...treeRow.children].map((child) => {
      const rect = child.getBoundingClientRect();
      return [child.className, rect.left, rect.right];
    }) : [];
    const isContained = (rect, container) => rect.left >= container.left - 1
      && rect.right <= container.right + 1
      && rect.top >= container.top - 1
      && rect.bottom <= container.bottom + 1;
    const controlStates = controls.map((control) => {
      const rect = control.getBoundingClientRect();
      return {
        name: control.getAttribute('aria-label') || control.getAttribute('title') || control.textContent.trim(),
        rect: [rect.left, rect.top, rect.right, rect.bottom],
        contained: Boolean(fileRect && rect.width > 0 && rect.height > 0 && isContained(rect, fileRect))
      };
    });
    return {
      width: window.innerWidth,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      tabsContained: tabs.every((tab) => tab.scrollWidth <= tab.clientWidth + 1 && (!fileRect || isContained(tab.getBoundingClientRect(), fileRect))),
      panelFillsSide: Boolean(sideRect && panelRect && Math.abs(sideRect.width - panelRect.width) <= 1),
      filePanelFillsPanel: Boolean(panelRect && fileRect && Math.abs(panelRect.width - fileRect.width) <= 1),
      sideFillsViewport: Boolean(sideRect && sideRect.left <= 1 && sideRect.right >= document.documentElement.clientWidth - 1),
      controlsContained: Boolean(fileRect && controls.length >= 6 && controlStates.every((control) => control.contained)),
      editorUsable: Boolean(editorRect && fileRect && editorRect.width >= 160 && editorRect.height >= 80 && isContained(editorRect, fileRect)),
      treeViewportUsable: Boolean(treeViewportRect && treeViewportRect.height >= 48 && fileRect && isContained(treeViewportRect, fileRect)),
      treeRowsAligned: Boolean(treeRowRect && treeRowChildren.length === 3 && treeRowChildren[2][1] - treeRowRect.left <= 60),
      sideWidth: sideRect?.width || 0,
      panelWidth: panelRect?.width || 0,
      filePanelWidth: fileRect?.width || 0,
      editorSize: editorRect ? [editorRect.width, editorRect.height] : [0, 0],
      treeViewportHeight: treeViewportRect?.height || 0,
      treeRowLayout: treeRow ? {
        display: getComputedStyle(treeRow).display,
        columns: getComputedStyle(treeRow).gridTemplateColumns,
        justifyContent: getComputedStyle(treeRow).justifyContent,
        rect: treeRowRect ? [treeRowRect.left, treeRowRect.right] : [],
        children: treeRowChildren
      } : null,
      controlCount: controls.length,
      uncontainedControls: controlStates.filter((control) => !control.contained)
    };
  })()`)
}

async function capture(win, name) {
  await settleRenderer(win)
  fs.writeFileSync(path.join(screenshotDir, name), (await win.capturePage()).toPNG())
}

async function invoke(channel, ...args) {
  const handler = ipcMain._invokeHandlers?.get(channel)
  if (!handler) throw new Error(`IPC channel not registered: ${channel}`)
  const win = await waitForWindow()
  await waitForRenderer(win, `location.protocol === 'file:'`)
  return handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args)
}

function waitForWindow() {
  return waitFor(() => BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()), 10_000)
}

function waitForRenderer(win, expression, timeoutMs = 10_000) {
  return waitFor(async () => {
    try { return await rendererValue(win, expression) } catch { return false }
  }, timeoutMs, async () => {
    try {
      return await rendererValue(win, `JSON.stringify({
        expression: ${JSON.stringify(expression)},
        url: location.href,
        activeElement: document.activeElement?.outerHTML?.slice(0, 240) || null,
        bodyText: document.body?.innerText?.slice(0, 600) || '',
        hydrated: Boolean(window.__caogenStoreHydrated || document.querySelector('[data-store-hydrated="true"]')),
        sessionCardCount: document.querySelectorAll('.session-card').length,
        sidebarText: document.querySelector('.sidebar-scroll')?.innerText?.slice(0, 400) || null,
        developerTabs: [...document.querySelectorAll('[data-developer-view]')].map((tab) => ({
          view: tab.getAttribute('data-developer-view'),
          selected: tab.getAttribute('aria-selected'),
          tabIndex: tab.tabIndex
        }))
      })`)
    } catch (error) {
      return JSON.stringify({ expression, diagnosticError: String(error) })
    }
  })
}

function rendererValue(win, expression) { return win.webContents.executeJavaScript(expression, true) }

async function settleRenderer(win) {
  await rendererValue(win, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  win.webContents.invalidate()
  await new Promise((resolve) => setTimeout(resolve, 180))
}

function waitFor(predicate, timeoutMs, diagnostic) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await predicate()
        if (value) return resolve(value)
      } catch {
        // Main and renderer state settle independently.
      }
      if (Date.now() - started > timeoutMs) {
        const detail = diagnostic ? await diagnostic() : ''
        return reject(new Error(`file editor E2E wait timed out${detail ? `: ${detail}` : ''}`))
      }
      setTimeout(() => void poll(), 80)
    }
    void poll()
  })
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`missing ${name}`)
  return value
}

app.whenReady().then(() => run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  app.exit(1)
}))
