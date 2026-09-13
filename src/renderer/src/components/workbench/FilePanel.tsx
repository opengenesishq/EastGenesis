import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Braces, CircleAlert, FolderTree, Info, Search, X } from 'lucide-react'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import type { ProjectDiagnostic, ProjectSymbolLocation, ProjectTextSearchMatch } from '../../../../shared/types'
import {
  buildProjectFileTree,
  filterProjectFileTree,
  visibleProjectFileNodes
} from './project-file-tree'
import { editorLocationForOffset, editorOffsetForLocation, editorWordRange, replaceEditorWord } from './editor-language-actions'
import {
  FileTreeRow,
  focusFileTreeEntry,
  formatFileBytes,
  handleFileTreeKeyDown,
  moveFileBrowserModeFocus,
  type FileBrowserMode
} from './file-panel-tree'
import type { MonacoFileEditorHandle } from './MonacoFileEditor'

const MonacoFileEditor = lazy(() => import('./MonacoFileEditor'))

interface LanguageSymbolResult extends ProjectSymbolLocation {
  insertText?: string
}
function supportsTypeScriptLanguageServer(path: string | null | undefined): boolean {
  return Boolean(path && /\.(?:cjs|js|jsx|mjs|ts|tsx)$/i.test(path))
}

function hoverDisplayText(markdown: string): string {
  return markdown
    .replace(/(?:^|\r?\n)```[^\r\n]*(?=\r?\n|$)/g, '')
    .trim()
}

function mergedDiagnostics(syntax: ProjectDiagnostic[], semantic: ProjectDiagnostic[]): ProjectDiagnostic[] {
  const seen = new Set<string>()
  return [...semantic, ...syntax].filter((diagnostic) => {
    const key = [
      diagnostic.path,
      diagnostic.line,
      diagnostic.column,
      diagnostic.endLine,
      diagnostic.endColumn,
      diagnostic.severity,
      diagnostic.message.trim().toLocaleLowerCase()
    ].join(':')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function SearchResultRow({ match, active, onOpen }: {
  match: ProjectTextSearchMatch
  active: boolean
  onOpen: (path: string) => void
}): React.JSX.Element {
  const before = match.snippet.slice(0, match.matchStart)
  const hit = match.snippet.slice(match.matchStart, match.matchStart + match.matchLength)
  const after = match.snippet.slice(match.matchStart + match.matchLength)
  return (
    <button
      type="button"
      className={`file-search-result ${active ? 'active' : ''}`}
      title={`${match.path}:${match.line}:${match.column}`}
      onClick={() => onOpen(match.path)}
    >
      <span className="file-search-result-path">{match.path}</span>
      <span className="file-search-result-position">{match.line}:{match.column}</span>
      <span className="file-search-result-snippet">{before}<mark>{hit}</mark>{after}</span>
    </button>
  )
}

function DiagnosticRow({ diagnostic, active, onOpen }: {
  diagnostic: ProjectDiagnostic
  active: boolean
  onOpen: (diagnostic: ProjectDiagnostic) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`file-diagnostic-row ${active ? 'active' : ''}`}
      data-diagnostic-path={diagnostic.path}
      data-diagnostic-source={diagnostic.source}
      data-diagnostic-code={diagnostic.code}
      title={`${diagnostic.path}:${diagnostic.line}:${diagnostic.column}\n${diagnostic.message}`}
      onClick={() => onOpen(diagnostic)}
    >
      <CircleAlert size={14} aria-hidden="true" />
      <span className="file-diagnostic-message">{diagnostic.message}</span>
      <span className="file-diagnostic-path">{diagnostic.path}</span>
      <span className="file-diagnostic-position">{diagnostic.line}:{diagnostic.column}</span>
    </button>
  )
}

function FileBrowserToolbar({
  mode,
  nameQuery,
  searchDraft,
  problemCount,
  searchLoading,
  setNameQuery,
  setSearchDraft,
  selectMode,
  submitSearch,
  t
}: {
  mode: FileBrowserMode
  nameQuery: string
  searchDraft: string
  problemCount: number
  searchLoading: boolean
  setNameQuery: (value: string) => void
  setSearchDraft: (value: string) => void
  selectMode: (mode: FileBrowserMode) => void
  submitSearch: () => void
  t: ReturnType<typeof useT>
}): React.JSX.Element {
  return (
    <div className="file-browser-toolbar">
      <div className="file-browser-modes" role="tablist" aria-label={t('fileBrowserMode')}>
        <FileBrowserModeButton mode="tree" active={mode === 'tree'} label={t('fileTreeMode')} selectMode={selectMode}>
          <FolderTree size={14} aria-hidden="true" />
        </FileBrowserModeButton>
        <FileBrowserModeButton mode="search" active={mode === 'search'} label={t('fileContentSearchMode')} selectMode={selectMode}>
          <Search size={14} aria-hidden="true" />
        </FileBrowserModeButton>
        <FileBrowserModeButton mode="problems" active={mode === 'problems'} label={t('fileProblemsMode')} selectMode={selectMode}>
          <CircleAlert size={14} aria-hidden="true" />{problemCount > 0 ? <span className="file-problem-count">{problemCount}</span> : null}
        </FileBrowserModeButton>
      </div>
      {mode === 'tree' ? (
        <input className="input file-search" value={nameQuery} placeholder={t('fileSearchPlaceholder')}
          onChange={(event) => setNameQuery(event.target.value)} />
      ) : mode === 'search' ? (
        <div className="file-content-search">
          <input className="input" value={searchDraft} placeholder={t('fileContentSearchPlaceholder')}
            onChange={(event) => setSearchDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') submitSearch() }} />
          <button type="button" className="btn btn-ghost btn-icon-sm" title={t('fileContentSearchAction')}
            aria-label={t('fileContentSearchAction')} disabled={searchLoading || !searchDraft.trim()} onClick={submitSearch}>
            <Search size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  )
}
function FileBrowserModeButton({
  mode,
  active,
  label,
  selectMode,
  children
}: {
  mode: FileBrowserMode
  active: boolean
  label: string
  selectMode: (mode: FileBrowserMode) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button type="button" role="tab" title={label} aria-label={label} aria-selected={active}
      tabIndex={active ? 0 : -1} data-file-browser-mode={mode} className={active ? 'active' : ''}
      onClick={() => selectMode(mode)} onKeyDown={(event) => moveFileBrowserModeFocus(event, mode, selectMode)}>
      {children}
    </button>
  )
}
export default function FilePanel(): React.JSX.Element {
  const t = useT()
  const activeId = useStore((s) => s.activeId)
  const {
    fileEntries,
    fileError,
    fileLoading,
    fileMessage,
    fileSaving,
    filesError,
    filesLoading,
    filesRoot,
    filesTruncated,
    fileSearchLoading,
    fileSearchQuery,
    fileSearchMatches,
    fileSearchFilesScanned,
    fileSearchFilesMatched,
    fileSearchTruncated,
    fileSearchError,
    fileDiagnosticsLoading,
    fileDiagnostics,
    fileDiagnosticsAnalyzedFiles,
    fileDiagnosticsSupportedFiles,
    fileDiagnosticsTruncated,
    fileDiagnosticsError,
    currentFileBytes,
    currentFileContent,
    currentFileMtimeMs,
    currentFilePath,
    savedFileContent,
    fileTabs
  } = useStore((s) => s.workbench)
  const refresh = useStore((s) => s.refreshFilesPanel)
  const searchProjectFiles = useStore((s) => s.searchProjectFiles)
  const clearProjectFileSearch = useStore((s) => s.clearProjectFileSearch)
  const refreshProjectDiagnostics = useStore((s) => s.refreshProjectDiagnostics)
  const close = useStore((s) => s.closeFilesPanel)
  const openFile = useStore((s) => s.openFile)
  const openPreview = useStore((s) => s.openPreviewPanel)
  const updateDraft = useStore((s) => s.updateFileDraft)
  const saveOpenFile = useStore((s) => s.saveOpenFile)
  const activateFileTab = useStore((s) => s.activateFileTab)
  const closeFileTab = useStore((s) => s.closeFileTab)
  const cycleFileTab = useStore((s) => s.cycleFileTab)
  const activePanelId = useStore((s) => s.workbench.activePanelId)
  const [mode, setMode] = useState<'tree' | 'search' | 'problems'>('tree')
  const [nameQuery, setNameQuery] = useState('')
  const [searchDraft, setSearchDraft] = useState('')
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const [focusedTreePath, setFocusedTreePath] = useState('')
  const [pendingLocation, setPendingLocation] = useState<{ path: string; line: number; column: number } | null>(null)
  const [pendingCaret, setPendingCaret] = useState<number | null>(null)
  const [symbolMode, setSymbolMode] = useState<'completion' | 'definition' | null>(null)
  const [symbolResults, setSymbolResults] = useState<LanguageSymbolResult[]>([])
  const [symbolLoading, setSymbolLoading] = useState(false)
  const [symbolError, setSymbolError] = useState('')
  const [symbolSource, setSymbolSource] = useState<'typescript-lsp' | 'project-index'>('project-index')
  const [hoverOpen, setHoverOpen] = useState(false)
  const [hoverLoading, setHoverLoading] = useState(false)
  const [hoverMarkdown, setHoverMarkdown] = useState('')
  const [hoverError, setHoverError] = useState('')
  const [semanticDiagnostics, setSemanticDiagnostics] = useState<ProjectDiagnostic[]>([])
  const [semanticDiagnosticsLoading, setSemanticDiagnosticsLoading] = useState(false)
  const [semanticDiagnosticsError, setSemanticDiagnosticsError] = useState('')
  const symbolRequestRef = useRef(0)
  const hoverRequestRef = useRef(0)
  const diagnosticsRequestRef = useRef(0)
  const editorRef = useRef<MonacoFileEditorHandle>(null)

  useEffect(() => {
    setMode('tree')
    setNameQuery('')
    setSearchDraft('')
    setExpandedPaths(new Set())
    setFocusedTreePath('')
    setHoverOpen(false)
    setSemanticDiagnostics([])
    setSemanticDiagnosticsError('')
    clearProjectFileSearch()
    if (activeId) void refresh()
  }, [activeId, clearProjectFileSearch, refresh])
  const dirty = currentFileContent !== savedFileContent
  const problemDiagnostics = useMemo(
    () => mergedDiagnostics(fileDiagnostics, semanticDiagnostics),
    [fileDiagnostics, semanticDiagnostics]
  )
  const sessionTabs = useMemo(
    () => fileTabs.filter((tab) => tab.sessionId === activeId),
    [activeId, fileTabs]
  )
  const requestCloseTab = useCallback((path: string): void => {
    const tab = sessionTabs.find((candidate) => candidate.path === path)
    if (!tab) return
    if (tab.content !== tab.savedContent && !window.confirm(t('closeDirtyFileConfirm', { name: fileName(path) }))) {
      return
    }
    closeFileTab(path)
  }, [closeFileTab, sessionTabs, t])
  useEffect(() => {
    if (activePanelId !== 'files') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key === 'Tab') {
        event.preventDefault()
        cycleFileTab(event.shiftKey ? -1 : 1)
      } else if (event.key.toLowerCase() === 's' && currentFilePath && dirty) {
        event.preventDefault()
        void saveOpenFile()
      } else if (event.key.toLowerCase() === 'w' && currentFilePath) {
        event.preventDefault()
        requestCloseTab(currentFilePath)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activePanelId, currentFilePath, cycleFileTab, dirty, requestCloseTab, saveOpenFile])
  const projectTree = useMemo(() => buildProjectFileTree(fileEntries), [fileEntries])
  const filteredTree = useMemo(() => filterProjectFileTree(projectTree, nameQuery), [nameQuery, projectTree])
  const visibleEntries = useMemo(
    () => visibleProjectFileNodes(filteredTree, expandedPaths, Boolean(nameQuery.trim())),
    [expandedPaths, filteredTree, nameQuery]
  )
  useEffect(() => {
    setFocusedTreePath((current) => {
      if (visibleEntries.some((item) => item.node.path === current)) return current
      if (currentFilePath && visibleEntries.some((item) => item.node.path === currentFilePath)) return currentFilePath
      return visibleEntries[0]?.node.path ?? ''
    })
  }, [currentFilePath, visibleEntries])
  const toggleDirectory = useCallback((path: string): void => {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])
  const submitSearch = useCallback((): void => {
    if (!searchDraft.trim()) {
      clearProjectFileSearch()
      return
    }
    void searchProjectFiles(searchDraft)
  }, [clearProjectFileSearch, searchDraft, searchProjectFiles])
  const selectMode = useCallback((next: FileBrowserMode): void => {
    setMode(next)
    if (next === 'problems') void refreshProjectDiagnostics()
  }, [refreshProjectDiagnostics])
  const openDiagnostic = useCallback((diagnostic: ProjectDiagnostic): void => {
    setPendingLocation(diagnostic)
    void openFile(diagnostic.path)
  }, [openFile])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !pendingLocation || currentFilePath !== pendingLocation.path || fileLoading) return
    const position = editorOffsetForLocation(currentFileContent, pendingLocation.line, pendingLocation.column)
    editor.setSelectionOffset(position)
    editor.revealLine(pendingLocation.line)
    setPendingLocation(null)
  }, [currentFileContent, currentFilePath, fileLoading, pendingLocation])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || pendingCaret === null) return
    editor.setSelectionOffset(pendingCaret)
    setPendingCaret(null)
  }, [currentFileContent, pendingCaret])

  const languageInput = useCallback(() => {
    const editor = editorRef.current
    if (!editor || !currentFilePath) return null
    const selection = editor.getSelectionOffsets()
    const location = editorLocationForOffset(currentFileContent, selection.start)
    return { path: currentFilePath, content: currentFileContent, ...location }
  }, [currentFileContent, currentFilePath])

  const requestHover = useCallback(async (): Promise<void> => {
    if (!activeId || !supportsTypeScriptLanguageServer(currentFilePath)) return
    const input = languageInput()
    if (!input) return
    const requestId = ++hoverRequestRef.current
    setSymbolMode(null)
    setHoverOpen(true)
    setHoverLoading(true)
    setHoverMarkdown('')
    setHoverError('')
    try {
      const result = await window.agentDesk.getTypeScriptHover(activeId, input)
      if (requestId !== hoverRequestRef.current) return
      if (!result.ok) setHoverError(result.error ?? t('fileSemanticFailed'))
      else setHoverMarkdown(result.markdown)
    } catch (error) {
      if (requestId === hoverRequestRef.current) setHoverError(error instanceof Error ? error.message : String(error))
    } finally {
      if (requestId === hoverRequestRef.current) setHoverLoading(false)
    }
  }, [activeId, currentFilePath, languageInput, t])

  useEffect(() => {
    hoverRequestRef.current += 1
    setHoverOpen(false)
    setHoverMarkdown('')
    setHoverError('')
  }, [currentFilePath])

  useEffect(() => {
    if (mode !== 'problems' || !activeId || !currentFilePath || !supportsTypeScriptLanguageServer(currentFilePath)) {
      diagnosticsRequestRef.current += 1
      setSemanticDiagnostics([])
      setSemanticDiagnosticsError('')
      setSemanticDiagnosticsLoading(false)
      return
    }
    const requestId = ++diagnosticsRequestRef.current
    setSemanticDiagnosticsLoading(true)
    setSemanticDiagnosticsError('')
    const timer = window.setTimeout(() => {
      const input = { path: currentFilePath, content: currentFileContent, line: 1, column: 1 }
      void window.agentDesk.getTypeScriptDiagnostics(activeId, input)
        .then((result) => {
          if (requestId !== diagnosticsRequestRef.current) return
          if (!result.ok) {
            setSemanticDiagnostics([])
            setSemanticDiagnosticsError(result.error ?? t('fileSemanticFailed'))
          } else {
            setSemanticDiagnostics(result.diagnostics)
          }
        })
        .catch((error) => {
          if (requestId === diagnosticsRequestRef.current) setSemanticDiagnosticsError(error instanceof Error ? error.message : String(error))
        })
        .finally(() => {
          if (requestId === diagnosticsRequestRef.current) setSemanticDiagnosticsLoading(false)
        })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [activeId, currentFileContent, currentFilePath, mode, t])

  const requestSymbols = useCallback(async (modeValue: 'completion' | 'definition'): Promise<void> => {
    const editor = editorRef.current
    if (!editor || !activeId || !currentFilePath) return
    const range = editorWordRange(currentFileContent, editor.getSelectionOffsets().start)
    const requestId = ++symbolRequestRef.current
    setHoverOpen(false)
    setSymbolLoading(true)
    setSymbolError('')
    setSymbolMode(modeValue)
    try {
      const input = languageInput()
      if (input && supportsTypeScriptLanguageServer(currentFilePath)) {
        if (modeValue === 'definition') {
          const semantic = await window.agentDesk.getTypeScriptDefinitions(activeId, input)
          if (requestId !== symbolRequestRef.current) return
          if (semantic.ok && semantic.locations.length > 0) {
            const locations: LanguageSymbolResult[] = semantic.locations.map((location) => ({
              name: fileName(location.path),
              kind: 'definition',
              path: location.path,
              line: location.line,
              column: location.column,
              endLine: location.endLine,
              signature: `${location.path}:${location.line}:${location.column}`,
              exported: false
            }))
            setSymbolSource('typescript-lsp')
            if (locations.length === 1) {
              setSymbolMode(null)
              setPendingLocation(locations[0])
              void openFile(locations[0].path)
            } else {
              setSymbolResults(locations)
            }
            return
          }
        } else {
          const semantic = await window.agentDesk.getTypeScriptCompletions(activeId, input)
          if (requestId !== symbolRequestRef.current) return
          if (semantic.ok && semantic.items.length > 0) {
            setSymbolSource('typescript-lsp')
            setSymbolResults(semantic.items.map((item) => ({
              name: item.label,
              kind: item.kind,
              path: currentFilePath,
              line: input.line,
              column: input.column,
              endLine: input.line,
              signature: item.detail,
              exported: false,
              insertText: item.insertText
            })))
            return
          }
        }
      }
      if (!range) {
        setSymbolResults([])
        return
      }
      const result = modeValue === 'definition'
        ? await window.agentDesk.resolveProjectDefinition(activeId, currentFilePath, range.word)
        : await window.agentDesk.searchProjectSymbols(activeId, range.word, 30)
      if (requestId !== symbolRequestRef.current) return
      setSymbolSource('project-index')
      if (!result.ok) {
        setSymbolResults([])
        setSymbolError(result.error ?? t('fileSymbolsFailed'))
      } else if (modeValue === 'definition' && result.symbols.length === 1) {
        const target = result.symbols[0]
        setSymbolMode(null)
        setPendingLocation(target)
        void openFile(target.path)
      } else {
        setSymbolResults(result.symbols)
      }
    } catch (error) {
      if (requestId === symbolRequestRef.current) setSymbolError(error instanceof Error ? error.message : String(error))
    } finally {
      if (requestId === symbolRequestRef.current) setSymbolLoading(false)
    }
  }, [activeId, currentFileContent, currentFilePath, languageInput, openFile, t])

  const selectSymbol = useCallback((symbol: LanguageSymbolResult): void => {
    if (symbolMode === 'definition') {
      setSymbolMode(null)
      setPendingLocation(symbol)
      void openFile(symbol.path)
      return
    }
    const editor = editorRef.current
    if (!editor) return
    const selection = editor.getSelectionOffsets()
    const range = editorWordRange(currentFileContent, selection.start) ?? {
      start: selection.start,
      end: selection.end,
      word: ''
    }
    const replacement = replaceEditorWord(currentFileContent, range, symbol.insertText ?? symbol.name)
    setSymbolMode(null)
    updateDraft(replacement.content)
    setPendingCaret(replacement.caret)
  }, [currentFileContent, openFile, symbolMode, updateDraft])

  return (
    <div className="file-panel">
      <header className="workspace-diff-top">
        <div>
          <div className="workspace-diff-title">{t('filePanelTitle')}</div>
          <div className="workspace-diff-sub">
            {filesRoot ?? ''}
            {filesTruncated ? ` · ${t('filesTruncated')}` : ''}
          </div>
        </div>
        <div className="workspace-diff-actions">
          <button className="btn btn-ghost btn-sm" disabled={filesLoading} onClick={() => void refresh()}>
            {filesLoading ? t('loadingDiff') : t('refresh')}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={close}>
            {t('close')}
          </button>
        </div>
      </header>

      {(filesError || fileError || fileSearchError || fileDiagnosticsError || (mode === 'problems' && semanticDiagnosticsError)) && (
        <div className="notice notice-error workspace-diff-notice">{filesError || fileError || fileSearchError || fileDiagnosticsError || semanticDiagnosticsError}</div>
      )}
      {fileMessage && <div className="notice notice-info workspace-diff-notice">{fileMessage}</div>}

      <div className="file-panel-body">
        <aside className="file-list">
          <FileBrowserToolbar
            mode={mode}
            nameQuery={nameQuery}
            searchDraft={searchDraft}
            problemCount={problemDiagnostics.length}
            searchLoading={fileSearchLoading}
            setNameQuery={setNameQuery}
            setSearchDraft={setSearchDraft}
            selectMode={selectMode}
            submitSearch={submitSearch}
            t={t}
          />
          {mode === 'search' && fileSearchQuery && (
            <div className="file-search-summary" aria-live="polite">
              {fileSearchLoading
                ? t('fileContentSearchLoading')
                : t('fileContentSearchSummary', { matches: fileSearchMatches.length, files: fileSearchFilesMatched ?? 0, scanned: fileSearchFilesScanned ?? 0 })}
              {fileSearchTruncated ? ` · ${t('fileContentSearchTruncated')}` : ''}
            </div>
          )}
          {mode === 'problems' && (
            <div className="file-search-summary" aria-live="polite">
              {fileDiagnosticsLoading || semanticDiagnosticsLoading
                ? t('fileProblemsLoading')
                : t('fileProblemsSummary', { problems: problemDiagnostics.length, analyzed: fileDiagnosticsAnalyzedFiles ?? 0, supported: fileDiagnosticsSupportedFiles ?? 0 })}
              {fileDiagnosticsTruncated ? ` · ${t('fileContentSearchTruncated')}` : ''}
              {supportsTypeScriptLanguageServer(currentFilePath) ? <span className="file-semantic-source">{t('fileSemanticSource')}</span> : null}
            </div>
          )}
          <div className="file-list-scroll" role={mode === 'tree' ? 'tree' : undefined}
            aria-label={mode === 'tree' ? t('fileTreeMode') : undefined}>
            {mode === 'problems' ? (
              (fileDiagnosticsLoading || semanticDiagnosticsLoading) && problemDiagnostics.length === 0 ? (
                <div className="workspace-diff-empty">{t('fileProblemsLoading')}</div>
              ) : problemDiagnostics.length === 0 ? (
                <div className="workspace-diff-empty">{t('fileProblemsEmpty')}</div>
              ) : (
                problemDiagnostics.map((diagnostic, index) => (
                  <DiagnosticRow key={`${diagnostic.path}:${diagnostic.line}:${diagnostic.column}:${index}`} diagnostic={diagnostic} active={diagnostic.path === currentFilePath} onOpen={openDiagnostic} />
                ))
              )
            ) : mode === 'search' ? (
              fileSearchLoading && fileSearchMatches.length === 0 ? (
                <div className="workspace-diff-empty">{t('fileContentSearchLoading')}</div>
              ) : fileSearchQuery && fileSearchMatches.length === 0 ? (
                <div className="workspace-diff-empty">{t('filesEmpty')}</div>
              ) : (
                fileSearchMatches.map((match, index) => (
                  <SearchResultRow key={`${match.path}:${match.line}:${match.column}:${index}`} match={match} active={match.path === currentFilePath} onOpen={(path) => void openFile(path)} />
                ))
              )
            ) : filesLoading && fileEntries.length === 0 ? (
              <div className="workspace-diff-empty">{t('loadingDiff')}</div>
            ) : visibleEntries.length === 0 ? (
              <div className="workspace-diff-empty">{t('filesEmpty')}</div>
            ) : (
              visibleEntries.map((item) => (
                <FileTreeRow
                  key={item.node.path}
                  item={item}
                  expanded={expandedPaths.has(item.node.path) || Boolean(nameQuery.trim())}
                  active={item.node.path === currentFilePath}
                  focused={item.node.path === focusedTreePath}
                  onToggle={toggleDirectory}
                  onOpen={(path) => void openFile(path)}
                  onPreview={(path) => void openPreview(path)}
                  onFocus={setFocusedTreePath}
                  onKeyDown={(event) => handleFileTreeKeyDown({
                    item,
                    event,
                    expandedPaths,
                    visibleEntries,
                    toggleDirectory,
                    openFile,
                    focusTreeEntry: (path) => focusFileTreeEntry(path, setFocusedTreePath)
                  })}
                  previewLabel={t('preview')}
                />
              ))
            )}
          </div>
        </aside>

        <section className="file-editor">
          {sessionTabs.length > 0 && (
            <div className="file-editor-tabs" role="tablist" aria-label={t('fileOpenTabs')}>
              {sessionTabs.map((tab) => {
                const active = tab.path === currentFilePath
                const tabDirty = tab.content !== tab.savedContent
                return (
                  <div
                    key={tab.path}
                    className={`file-editor-tab ${active ? 'active' : ''}`}
                    data-file-tab={tab.path}
                    data-file-tab-active={active || undefined}
                    data-file-tab-dirty={tabDirty || undefined}
                  >
                    <button
                      type="button"
                      className="file-editor-tab-select"
                      role="tab"
                      aria-selected={active}
                      title={tab.path}
                      onClick={() => activateFileTab(tab.path)}
                    >
                      <span className="file-editor-tab-name">{fileName(tab.path)}</span>
                      {tabDirty && <span className="file-editor-tab-dirty" aria-label={t('fileUnsaved')} />}
                    </button>
                    <button
                      type="button"
                      className="file-editor-tab-close"
                      data-file-tab-close={tab.path}
                      aria-label={t('closeFileTab', { name: fileName(tab.path) })}
                      title={t('close')}
                      disabled={fileSaving && active}
                      onClick={() => requestCloseTab(tab.path)}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          <div className="file-editor-head">
            <div className="file-editor-title" title={currentFilePath}>
              {currentFilePath ?? t('fileNoSelection')}
              {dirty ? ' *' : ''}
            </div>
            <div className="file-editor-meta">
              {currentFilePath
                ? `${formatFileBytes(currentFileBytes)}${currentFileMtimeMs ? ` · ${new Date(currentFileMtimeMs).toLocaleString()}` : ''}`
                : ''}
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-icon-sm file-editor-hover"
              title={t('fileSemanticHover')}
              aria-label={t('fileSemanticHover')}
              disabled={!supportsTypeScriptLanguageServer(currentFilePath) || hoverLoading}
              onClick={() => void requestHover()}
            >
              <Info size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon-sm file-editor-symbols"
              title={t('fileWorkspaceSymbols')}
              aria-label={t('fileWorkspaceSymbols')}
              disabled={!currentFilePath || symbolLoading}
              onClick={() => void requestSymbols('completion')}
            >
              <Braces size={14} aria-hidden="true" />
            </button>
            <button
              className="btn btn-ghost btn-sm"
              disabled={!currentFilePath}
              onClick={() => {
                if (currentFilePath) void openPreview(currentFilePath)
              }}
            >
              {t('preview')}
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={!currentFilePath || !dirty || fileSaving || fileLoading}
              onClick={() => void saveOpenFile()}
            >
              {fileSaving ? t('saving') : t('save')}
            </button>
          </div>
          {hoverOpen && (
            <div className="file-hover-popover" data-file-hover-popover aria-busy={hoverLoading || undefined}>
              <div className="file-symbol-menu-head">
                <div className="file-symbol-heading">
                  <strong>{t('fileSemanticHover')}</strong>
                  <span>{t('fileSemanticSource')}</span>
                </div>
                <button type="button" className="btn btn-ghost btn-icon-sm" title={t('close')} aria-label={t('close')} onClick={() => setHoverOpen(false)}><X size={13} aria-hidden="true" /></button>
              </div>
              {hoverLoading ? (
                <div className="file-symbol-empty">{t('fileSemanticLoading')}</div>
              ) : hoverError ? (
                <div className="file-symbol-empty">{hoverError}</div>
              ) : hoverMarkdown ? (
                <pre className="file-hover-content">{hoverDisplayText(hoverMarkdown)}</pre>
              ) : (
                <div className="file-symbol-empty">{t('fileSemanticEmpty')}</div>
              )}
            </div>
          )}
          {symbolMode && (
            <div className="file-symbol-menu" data-file-symbol-menu aria-busy={symbolLoading || undefined}>
              <div className="file-symbol-menu-head">
                <div className="file-symbol-heading">
                  <strong>{symbolMode === 'definition' ? t('fileDefinitions') : t('fileCompletions')}</strong>
                  <span data-file-symbol-source={symbolSource}>{symbolSource === 'typescript-lsp' ? t('fileSemanticSource') : t('fileIndexSource')}</span>
                </div>
                <button type="button" className="btn btn-ghost btn-icon-sm" title={t('close')} aria-label={t('close')} onClick={() => setSymbolMode(null)}><X size={13} aria-hidden="true" /></button>
              </div>
              {symbolLoading ? (
                <div className="workspace-diff-empty">{t('fileSymbolsLoading')}</div>
              ) : symbolError ? (
                <div className="file-symbol-empty">{symbolError}</div>
              ) : symbolResults.length === 0 ? (
                <div className="file-symbol-empty">{t('fileSymbolsEmpty')}</div>
              ) : (
                <div className="file-symbol-results">
                  {symbolResults.map((symbol, index) => (
                    <button type="button" key={`${symbol.path}:${symbol.line}:${symbol.name}:${index}`} className="file-symbol-result" onClick={() => selectSymbol(symbol)}>
                      <span className="file-symbol-kind">{symbol.kind}</span>
                      <strong>{symbol.name}</strong>
                      <span className="file-symbol-signature">{symbol.signature}</span>
                      <span className="file-symbol-location">{symbol.path}:{symbol.line}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {fileLoading ? (
            <div className="workspace-diff-empty">{t('fileLoading')}</div>
          ) : currentFilePath ? (
            <Suspense fallback={<div className="workspace-diff-empty">{t('fileLoading')}</div>}>
              <MonacoFileEditor
                ref={editorRef}
                path={currentFilePath}
                value={currentFileContent}
                onChange={updateDraft}
                onDefinition={() => void requestSymbols('definition')}
                onCompletion={() => void requestSymbols('completion')}
                onEscape={() => {
                  if (symbolMode || hoverOpen) {
                    setSymbolMode(null)
                    setHoverOpen(false)
                  }
                }}
              />
            </Suspense>
          ) : (
            <div className="workspace-diff-empty">{t('filePickHint')}</div>
          )}
        </section>
      </div>
    </div>
  )
}
