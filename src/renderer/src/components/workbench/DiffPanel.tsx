import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, FlaskConical, LoaderCircle, Play, RotateCcw, XCircle } from 'lucide-react'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import type { GitFileStatus, WorkspaceDiffFile, WorkspaceDiffHunk, WorkspaceDiffLine } from '../../../../shared/types'
import { useProjectTests } from './useProjectTests'
import { expandGitTextTemplate, normalizeDesktopGitPreferences } from '../../../../shared/desktop-git-preferences'

function fileLabel(file: WorkspaceDiffFile): string {
  if (file.status === 'renamed') return `${file.oldPath} -> ${file.newPath}`
  return file.newPath || file.oldPath
}

function Line({ line }: { line: WorkspaceDiffLine }): React.JSX.Element {
  const cls =
    line.type === 'add'
      ? 'workspace-diff-line-add'
      : line.type === 'delete'
        ? 'workspace-diff-line-del'
        : 'workspace-diff-line-context'
  const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '
  return (
    <div className={`workspace-diff-line ${cls}`}>
      <span className="workspace-diff-num">{line.oldLine ?? ''}</span>
      <span className="workspace-diff-num">{line.newLine ?? ''}</span>
      <span className="workspace-diff-code">
        {prefix}
        {line.text}
      </span>
    </div>
  )
}

function statusLabel(file: GitFileStatus): string {
  if (file.untracked) return 'untracked'
  const flags = []
  if (file.staged) flags.push('staged')
  if (file.unstaged) flags.push('unstaged')
  return flags.join(' + ') || file.kind
}

type ProjectTests = ReturnType<typeof useProjectTests>

function gitTestState(tests: ProjectTests): string {
  const required = tests.commands.length > 0
  if (tests.loading || tests.runningHere) return 'loading'
  if (tests.stale) return 'stale'
  if (gitTestEvidenceFailed(tests)) return 'evidence-failed'
  if (!required) return 'not-required'
  if (gitTestPassed(tests)) return 'passed'
  return tests.result ? 'failed' : 'required'
}

function gitTestLabel(tests: ProjectTests, t: (key: string) => string): string {
  if (tests.stale) return t('projectReviewTestsStale')
  if (gitTestEvidenceFailed(tests)) return t('projectReviewTestEvidenceFailed')
  if (tests.commands.length === 0) return t('projectReviewNoTests')
  if (gitTestPassed(tests)) return t('projectReviewTestsPassed')
  return tests.result ? t('projectReviewTestsFailed') : t('projectReviewNeedsTest')
}

function gitTestPassed(tests: ProjectTests): boolean {
  return tests.result?.status === 'passed' && Boolean(tests.result.evidenceId) && !tests.result.evidenceError && !tests.stale
}

function gitTestEvidenceFailed(tests: ProjectTests): boolean {
  return Boolean(tests.result?.evidenceError || (tests.result?.status === 'passed' && !tests.result.evidenceId))
}

function GitTestIcon({ tests }: { tests: ProjectTests }): React.JSX.Element {
  if (tests.loading || tests.runningHere) return <LoaderCircle className="test-spin" size={14} />
  if (gitTestEvidenceFailed(tests)) return <XCircle size={14} />
  if (gitTestPassed(tests) || tests.commands.length === 0) return <CheckCircle2 size={14} />
  if (tests.result && !tests.stale) return <XCircle size={14} />
  return <FlaskConical size={14} />
}

function GitTestReview({
  tests,
  pendingChanges,
  openLatestRewindPanel,
  t
}: {
  tests: ProjectTests
  pendingChanges: number
  openLatestRewindPanel: (source?: 'command' | 'button' | 'shortcut') => void
  t: (key: string) => string
}): React.JSX.Element {
  const defaultTest = tests.commands.find((command) => command.default) ?? tests.commands[0]
  return (
    <div className="project-review-flow" data-project-review-state={gitTestState(tests)}>
      <div className="project-review-status">
        <span className="project-review-status-icon" aria-hidden="true">
          <GitTestIcon tests={tests} />
        </span>
        <span>{gitTestLabel(tests, t)}</span>
        {pendingChanges > 0 && <span className="project-review-pending">{pendingChanges} {t('projectReviewPendingChanges')}</span>}
      </div>
      <div className="project-review-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={!defaultTest || tests.loading || Boolean(tests.runningCommandId)} onClick={() => defaultTest && void tests.run(defaultTest)}>
          {tests.runningHere ? <LoaderCircle className="test-spin" size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          {t('projectReviewRunDefault')}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => openLatestRewindPanel('button')}>
          <RotateCcw size={14} aria-hidden="true" />
          {t('projectReviewUndo')}
        </button>
      </div>
    </div>
  )
}

function GitFileSelection({
  files,
  selected,
  allSelected,
  onToggleAll,
  onToggle
}: {
  files: GitFileStatus[]
  selected: Set<string>
  allSelected: boolean
  onToggleAll: () => void
  onToggle: (path: string) => void
}): React.JSX.Element {
  if (files.length === 0) return <div className="git-file-empty">No Git changes</div>
  return (
    <div className="git-file-list">
      <label className="git-file-row git-file-row-all">
        <input type="checkbox" checked={allSelected} onChange={onToggleAll} />
        <span>选择全部文件</span>
        <b>{files.length}</b>
      </label>
      {files.map((file) => (
        <label key={`${file.path}-${file.indexStatus}-${file.worktreeStatus}`} className="git-file-row">
          <input type="checkbox" checked={selected.has(file.path)} onChange={() => onToggle(file.path)} />
          <span className="git-file-path" title={file.path}>{file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}</span>
          <span className="git-file-state">{statusLabel(file)}</span>
        </label>
      ))}
    </div>
  )
}

function GitCommitActions({
  gitBusy,
  selectedCount,
  filesLength,
  onStage,
  onStageAll,
  onUnstage
}: {
  gitBusy: boolean
  selectedCount: number
  filesLength: number
  onStage: () => void
  onStageAll: () => void
  onUnstage: () => void
}): React.JSX.Element {
  return <div className="git-commit-actions">
    <button className="btn btn-ghost btn-sm" disabled={gitBusy || selectedCount === 0} onClick={onStage}>Stage selected</button>
    <button className="btn btn-ghost btn-sm" disabled={gitBusy || filesLength === 0} onClick={onStageAll}>Stage all</button>
    <button className="btn btn-ghost btn-sm" disabled={gitBusy || selectedCount === 0} onClick={onUnstage}>Unstage selected</button>
  </div>
}

function GitCommitForm({
  message,
  canCommit,
  onMessageChange,
  onCommit
}: {
  message: string
  canCommit: boolean
  onMessageChange: (message: string) => void
  onCommit: () => void
}): React.JSX.Element {
  return <div className="git-commit-form">
    <textarea className="git-commit-input" rows={3} aria-label="Commit message" value={message} placeholder="Commit message · ⌘/Ctrl Enter" onChange={(event) => onMessageChange(event.target.value)} onKeyDown={(event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && canCommit) { event.preventDefault(); onCommit() }
    }} />
    <button className="btn btn-primary btn-sm" disabled={!canCommit} onClick={onCommit}>Commit</button>
  </div>
}

function commitAllowed(message: string, staged: number | undefined, busy: boolean, tests: ProjectTests): boolean {
  if (!message.trim() || !staged || busy || tests.loading || tests.runningHere || tests.error || gitTestEvidenceFailed(tests)) return false
  return tests.commands.length === 0 || gitTestPassed(tests)
}

function GitCommitBox(): React.JSX.Element {
  const t = useT()
  const {
    gitBusy,
    gitError,
    gitLoading,
    gitMessage,
    gitStatus
  } = useStore((s) => s.workbench)
  const refreshGitStatus = useStore((s) => s.refreshGitStatus)
  const stageGitFiles = useStore((s) => s.stageGitFiles)
  const stageAllGitFiles = useStore((s) => s.stageAllGitFiles)
  const unstageGitFiles = useStore((s) => s.unstageGitFiles)
  const commitGit = useStore((s) => s.commitGit)
  const openLatestRewindPanel = useStore((s) => s.openLatestRewindPanel)
  const tests = useProjectTests()
  const activeId = useStore(state => state.activeId)
  const meta = useStore(state => state.activeId ? state.sessions[state.activeId]?.meta : undefined)
  const preferences = useStore(state => state.settings.gitPreferences)
  const zh = useStore(state => state.settings.language === 'zh')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const draftKey = `${activeId ?? ''}:${meta?.cwd ?? ''}:${gitStatus?.branch ?? ''}`
  const message = drafts[draftKey] ?? ''
  const setMessage = (text: string): void => setDrafts(current => ({ ...current, [draftKey]: text }))
  const defaultMessage = expandGitTextTemplate(normalizeDesktopGitPreferences(preferences).commitTemplate, {
    title: meta?.title ?? '', branch: gitStatus?.branch ?? '', baseBranch: '',
    summary: (gitStatus?.files ?? []).slice(0, 20).map(file => file.path).join('\n')
  })
  useEffect(() => {
    if (!activeId || !gitStatus?.branch) return
    setDrafts(current => Object.hasOwn(current, draftKey) ? current : { ...current, [draftKey]: defaultMessage })
  }, [activeId, gitStatus?.branch, draftKey, defaultMessage])

  const files = gitStatus?.files ?? []
  const selectedPaths = useMemo(
    () => files.map((file) => file.path).filter((path) => selected.has(path)),
    [files, selected]
  )
  const allSelected = files.length > 0 && selectedPaths.length === files.length
  const canCommit = commitAllowed(message, gitStatus?.staged, gitBusy, tests)
  const pendingChanges = (gitStatus?.unstaged ?? 0) + (gitStatus?.untracked ?? 0)

  useEffect(() => {
    setSelected((current) => {
      const available = new Set(files.map((file) => file.path))
      const next = new Set([...current].filter((path) => available.has(path)))
      if (next.size === current.size) return current
      return next
    })
  }, [files])

  const togglePath = (path: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(files.map((file) => file.path)))
  }

  const selectedCount = selectedPaths.length

  return (
    <section className="git-commit-box">
      <div className="git-commit-head">
        <div>
          <div className="git-commit-title">{t('projectReviewTitle')}</div>
          <div className="git-commit-sub">
            {gitStatus?.branch || 'detached'} · {gitStatus?.staged ?? 0} staged · {gitStatus?.unstaged ?? 0} unstaged · {gitStatus?.untracked ?? 0} untracked
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" disabled={gitLoading || gitBusy} onClick={() => void refreshGitStatus()}>
          {gitLoading ? 'Loading' : 'Refresh Git'}
        </button>
      </div>

      {gitError && <div className="notice notice-error git-commit-notice">{gitError}</div>}
      {gitMessage && <div className="notice notice-info git-commit-notice">{gitMessage}</div>}

      <GitTestReview tests={tests} pendingChanges={pendingChanges} openLatestRewindPanel={openLatestRewindPanel} t={t} />

      <GitFileSelection files={files} selected={selected} allSelected={allSelected} onToggleAll={toggleAll} onToggle={togglePath} />
      <GitCommitActions gitBusy={gitBusy} selectedCount={selectedCount} filesLength={files.length}
        onStage={() => void stageGitFiles(selectedPaths)} onStageAll={() => void stageAllGitFiles()} onUnstage={() => void unstageGitFiles(selectedPaths)} />
      {Boolean(defaultMessage) && <button className="btn btn-ghost btn-sm" disabled={gitBusy || Boolean(message.trim())} onClick={() => setMessage(defaultMessage)}>{zh ? '填入提交模板' : 'Fill commit template'}</button>}
      <GitCommitForm message={message} canCommit={canCommit} onMessageChange={setMessage} onCommit={() => {
        void commitGit(message).then((result) => { if (result?.ok) { setMessage(''); tests.invalidate() } })
      }} />
    </section>
  )
}

function HunkHeader({
  file,
  hunk,
  hunkKey
}: {
  file: WorkspaceDiffFile
  hunk: WorkspaceDiffHunk
  hunkKey: string
}): React.JSX.Element {
  const hunkBusyKey = useStore((s) => s.workbench.hunkBusyKey)
  const applyWorkspaceHunk = useStore((s) => s.applyWorkspaceHunk)
  const discardWorkspaceHunk = useStore((s) => s.discardWorkspaceHunk)
  const filePath = file.newPath || file.oldPath
  const busy = hunkBusyKey === hunkKey
  const canOperate = Boolean(hunk.patch) && !file.binary && !busy

  return (
    <div className="workspace-diff-hunk-head">
      <span>{hunk.header}</span>
      {hunk.patch && !file.binary && (
        <span className="workspace-diff-hunk-actions">
          <button
            className="btn btn-ghost btn-xs"
            disabled={!canOperate}
            title="Stage this hunk"
            onClick={() => void applyWorkspaceHunk(filePath, hunk.patch ?? '', hunkKey)}
          >
            {busy ? '...' : '✓'}
          </button>
          <button
            className="btn btn-ghost btn-xs"
            disabled={!canOperate}
            title="Discard this hunk"
            onClick={() => {
              if (!window.confirm(`丢弃 ${filePath} 的这个 hunk?`)) return
              void discardWorkspaceHunk(filePath, hunk.patch ?? '', hunkKey)
            }}
          >
            ×
          </button>
        </span>
      )}
    </div>
  )
}

function FileDiff({ file }: { file: WorkspaceDiffFile }): React.JSX.Element {
  return (
    <article className="workspace-diff-file">
      <header className="workspace-diff-file-head">
        <span className={`workspace-diff-status workspace-diff-status-${file.status}`}>
          {file.status}
        </span>
        <span className="workspace-diff-path">{fileLabel(file)}</span>
      </header>
      {file.binary ? (
        <div className="workspace-diff-empty">Binary file changed</div>
      ) : file.hunks.length === 0 ? (
        <div className="workspace-diff-empty">No textual hunks</div>
      ) : (
        file.hunks.map((hunk, idx) => {
          const hunkKey = `${fileLabel(file)}-${idx}-${hunk.header}`
          return (
          <div key={hunkKey} className="workspace-diff-hunk">
            <HunkHeader file={file} hunk={hunk} hunkKey={hunkKey} />
            {hunk.lines.map((line, lineIdx) => (
              <Line key={lineIdx} line={line} />
            ))}
          </div>
          )
        })
      )}
    </article>
  )
}

export default function DiffPanel(): React.JSX.Element {
  const t = useT()
  const activeId = useStore((s) => s.activeId)
  const { diff, diffError, diffLoading, diffMessage } = useStore((s) => s.workbench)
  const refresh = useStore((s) => s.refreshDiffPanel)
  const refreshGitStatus = useStore((s) => s.refreshGitStatus)
  const close = useStore((s) => s.closeDiffPanel)

  useEffect(() => {
    if (activeId) void Promise.all([refresh(), refreshGitStatus()])
  }, [activeId, refresh, refreshGitStatus])

  const files = diff?.files ?? []

  return (
    <div className="workspace-diff">
      <header className="workspace-diff-top">
        <div>
          <div className="workspace-diff-title">{t('workspaceDiff')}</div>
          <div className="workspace-diff-sub">
            {diff?.cwd ?? ''}
            {diff?.truncated ? ` · ${t('diffTruncated')}` : ''}
          </div>
        </div>
        <div className="workspace-diff-actions">
          <button className="btn btn-ghost btn-sm" disabled={diffLoading} onClick={() => void Promise.all([refresh(), refreshGitStatus()])}>
            {diffLoading ? t('loadingDiff') : t('refresh')}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={close}>
            {t('close')}
          </button>
        </div>
      </header>

      <GitCommitBox />

      {diffError && <div className="notice notice-error workspace-diff-notice">{diffError}</div>}
      {diffMessage && <div className="notice notice-info workspace-diff-notice">{diffMessage}</div>}
      {diffLoading && !diff && <div className="workspace-diff-empty">{t('loadingDiff')}</div>}
      {!diffLoading && diff && diff.ok && files.length === 0 && (
        <div className="workspace-diff-empty">{t('noWorkspaceChanges')}</div>
      )}
      {files.length > 0 && (
        <div className="workspace-diff-scroll">
          {files.map((file) => (
            <FileDiff key={`${file.oldPath}->${file.newPath}`} file={file} />
          ))}
        </div>
      )}
    </div>
  )
}
