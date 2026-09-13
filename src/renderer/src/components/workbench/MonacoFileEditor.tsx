import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import 'monaco-editor/editor/browser/coreCommands'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import 'monaco-editor/editor/contrib/comment/browser/comment'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu'
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo'
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/folding/browser/folding'
import 'monaco-editor/editor/contrib/indentation/browser/indentation'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations'
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations'
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations'
import 'monaco-editor/languages/definitions/cpp/register'
import 'monaco-editor/languages/definitions/csharp/register'
import 'monaco-editor/languages/definitions/css/register'
import 'monaco-editor/languages/definitions/go/register'
import 'monaco-editor/languages/definitions/html/register'
import 'monaco-editor/languages/definitions/java/register'
import 'monaco-editor/languages/definitions/javascript/register'
import 'monaco-editor/languages/definitions/markdown/register'
import 'monaco-editor/languages/definitions/python/register'
import 'monaco-editor/languages/definitions/rust/register'
import 'monaco-editor/languages/definitions/scss/register'
import 'monaco-editor/languages/definitions/sql/register'
import 'monaco-editor/languages/definitions/typescript/register'
import 'monaco-editor/languages/definitions/xml/register'
import 'monaco-editor/languages/definitions/yaml/register'
import '../../../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css'
import '../../../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css'

export interface MonacoFileEditorHandle {
  focus: () => void
  getSelectionOffsets: () => { start: number; end: number }
  setSelectionOffset: (offset: number) => void
  revealLine: (line: number) => void
}

interface MonacoFileEditorProps {
  path: string
  value: string
  onChange: (value: string) => void
  onDefinition: () => void
  onCompletion: () => void
  onEscape: () => void
}

type MonacoEnvironmentWithWorker = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (_moduleId: string, label: string) => Worker
  }
}

const globalWithMonaco = globalThis as MonacoEnvironmentWithWorker
if (!globalWithMonaco.MonacoEnvironment) {
  globalWithMonaco.MonacoEnvironment = {
    getWorker: () => new EditorWorker()
  }
}

monaco.languages.register({
  id: 'json',
  extensions: ['.json', '.jsonc'],
  aliases: ['JSON', 'json'],
  mimetypes: ['application/json']
})
monaco.languages.setLanguageConfiguration('json', {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']']],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"', notIn: ['string'] }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '"', close: '"' }
  ]
})
monaco.languages.setMonarchTokensProvider('json', {
  defaultToken: '',
  tokenPostfix: '.json',
  tokenizer: {
    root: [
      [/[{}]/, 'delimiter.bracket'],
      [/[[\]]/, 'delimiter.array'],
      [/[,:]/, 'delimiter'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key'],
      [/"(?:[^"\\]|\\.)*"/, 'string.value'],
      [/"(?:[^"\\]|\\.)*$/, 'string.invalid'],
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment']
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment']
    ]
  }
})

const languageByExtension: Record<string, string> = {
  c: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  rs: 'rust',
  scss: 'scss',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml'
}

function languageForPath(filePath: string): string {
  const extension = filePath.split('.').at(-1)?.toLocaleLowerCase() ?? ''
  return languageByExtension[extension] ?? 'plaintext'
}

function themeForDocument(): 'vs' | 'vs-dark' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark'
}

function editorOptions(path: string): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    automaticLayout: true,
    ariaLabel: `Editor: ${path}`,
    bracketPairColorization: { enabled: true },
    codeLens: false,
    folding: true,
    fontFamily: 'var(--mono), SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12,
    glyphMargin: false,
    hover: { enabled: 'off' },
    lineNumbers: 'on',
    minimap: { enabled: false },
    padding: { top: 12, bottom: 12 },
    quickSuggestions: false,
    renderLineHighlight: 'line',
    renderWhitespace: 'selection',
    scrollBeyondLastLine: false,
    suggestOnTriggerCharacters: false,
    tabSize: 2,
    theme: themeForDocument(),
    wordWrap: 'off'
  }
}

const MonacoFileEditor = forwardRef<MonacoFileEditorHandle, MonacoFileEditorProps>(function MonacoFileEditor(
  { path, value, onChange, onDefinition, onCompletion, onEscape },
  ref
) {
  const language = languageForPath(path)
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const applyingExternalValueRef = useRef(false)
  const callbacksRef = useRef({ onChange, onDefinition, onCompletion, onEscape })
  callbacksRef.current = { onChange, onDefinition, onCompletion, onEscape }

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    getSelectionOffsets: () => {
      const editor = editorRef.current
      const model = modelRef.current
      if (!editor || !model) return { start: 0, end: 0 }
      const selection = editor.getSelection()
      if (!selection) return { start: 0, end: 0 }
      return {
        start: model.getOffsetAt({ lineNumber: selection.startLineNumber, column: selection.startColumn }),
        end: model.getOffsetAt({ lineNumber: selection.endLineNumber, column: selection.endColumn })
      }
    },
    setSelectionOffset: (offset) => {
      const editor = editorRef.current
      const model = modelRef.current
      if (!editor || !model) return
      const position = model.getPositionAt(Math.max(0, Math.min(offset, model.getValueLength())))
      editor.setPosition(position)
      editor.setSelection(new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column))
      editor.revealPositionInCenter(position)
      editor.focus()
    },
    revealLine: (line) => {
      const editor = editorRef.current
      const model = modelRef.current
      if (!editor || !model) return
      editor.revealLineInCenter(Math.max(1, Math.min(line, model.getLineCount())))
    }
  }), [])

  useEffect(() => {
    if (!containerRef.current) return undefined
    const model = monaco.editor.createModel(value, language)
    const editor = monaco.editor.create(containerRef.current, editorOptions(path))
    editor.setModel(model)
    modelRef.current = model
    editorRef.current = editor

    const changeSubscription = model.onDidChangeContent(() => {
      if (applyingExternalValueRef.current) return
      callbacksRef.current.onChange(model.getValue())
    })
    const updateCursorOffset = () => {
      const position = editor.getPosition()
      containerRef.current?.setAttribute(
        'data-file-editor-cursor-offset',
        String(position ? model.getOffsetAt(position) : 0)
      )
    }
    const cursorSubscription = editor.onDidChangeCursorPosition(updateCursorOffset)
    updateCursorOffset()
    const keySubscription = editor.onKeyDown((event: monaco.IKeyboardEvent) => {
      if (event.keyCode === monaco.KeyCode.F12) {
        event.preventDefault()
        callbacksRef.current.onDefinition()
      } else if (event.keyCode === monaco.KeyCode.Space && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        callbacksRef.current.onCompletion()
      } else if (event.keyCode === monaco.KeyCode.Escape) {
        callbacksRef.current.onEscape()
      }
    })
    const themeObserver = new MutationObserver(() => {
      monaco.editor.setTheme(themeForDocument())
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      themeObserver.disconnect()
      keySubscription.dispose()
      cursorSubscription.dispose()
      changeSubscription.dispose()
      editor.dispose()
      model.dispose()
      editorRef.current = null
      modelRef.current = null
    }
  }, [language, path])

  useEffect(() => {
    const model = modelRef.current
    if (!model || model.getValue() === value) return
    const currentPosition = editorRef.current?.getPosition()
    applyingExternalValueRef.current = true
    try {
      model.setValue(value)
    } finally {
      applyingExternalValueRef.current = false
    }
    if (currentPosition) editorRef.current?.setPosition(currentPosition)
  }, [value])

  return (
    <div
      ref={containerRef}
      className="file-editor-monaco"
      data-file-editor-language={language}
      data-file-editor-path={path}
    />
  )
})

export default MonacoFileEditor
