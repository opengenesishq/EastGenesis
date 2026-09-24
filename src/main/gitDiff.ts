import { execFileSyncInExecutionEnvironment as execFileSync } from './wsl/process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { inspectSingleFilePatch } from './git/git-patch-inspection'
import { isolatedLocalGitEnv, withSafeLocalGitConfig } from './git/safe-git'
import type {
  WorkspaceHunkResult,
  WorkspaceDiff,
  WorkspaceDiffFile,
  WorkspaceDiffHunk,
  WorkspaceDiffLine
} from '../shared/types'

const MAX_DIFF_CHARS = 1_000_000
const MAX_EXEC_BUFFER = MAX_DIFF_CHARS * 20
const MAX_UNTRACKED_FILE_BYTES = 250_000

type ParsedWorkspaceDiffFile = WorkspaceDiffFile & { patchHeader: string[] }
type ParsedWorkspaceDiffHunk = WorkspaceDiffHunk & { patchLines: string[] }

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function applyHunk(
  cwd: string,
  filePath: string,
  hunkPatch: string,
  options: { reverse?: boolean } = {}
): WorkspaceHunkResult {
  if (typeof hunkPatch !== 'string' || hunkPatch.trim().length === 0) {
    return { ok: false, error: 'hunk patch 不能为空' }
  }
  if (hunkPatch.length > MAX_DIFF_CHARS) return { ok: false, error: 'hunk patch 过大' }

  const patch = hunkPatch.endsWith('\n') ? hunkPatch : `${hunkPatch}\n`
  const pathCheck = inspectSingleFilePatch(cwd, filePath, patch)
  if (!pathCheck.ok) return pathCheck
  const args = options.reverse ? ['apply', '-R', '--whitespace=nowarn'] : ['apply', '--cached', '--whitespace=nowarn']
  try {
    execFileSync('git', withSafeLocalGitConfig(['-C', cwd, ...args]), {
      input: patch,
      encoding: 'utf8',
      env: isolatedLocalGitEnv(process.env),
      timeout: 30_000,
      maxBuffer: MAX_EXEC_BUFFER,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export function getWorkspaceDiff(cwd: string): WorkspaceDiff {
  let output: Buffer
  let repoRoot: string
  try {
    repoRoot = execFileSync('git', withSafeLocalGitConfig(['-C', cwd, 'rev-parse', '--show-toplevel']), {
      encoding: 'utf8',
      env: isolatedLocalGitEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    output = execFileSync(
      'git',
      withSafeLocalGitConfig(['-C', cwd, 'diff', '--no-ext-diff', '--no-textconv', '--binary', '--', '.']),
      {
        encoding: 'buffer',
        env: isolatedLocalGitEnv(process.env),
        maxBuffer: MAX_EXEC_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
  } catch (error) {
    return {
      ok: false,
      cwd,
      files: [],
      rawBytes: 0,
      error: errorMessage(error)
    }
  }

  const rawBytes = output.length
  const text = output.toString('utf8')
  const truncated = text.length > MAX_DIFF_CHARS
  const parseText = truncated ? text.slice(0, MAX_DIFF_CHARS) : text
  const untracked = truncated ? { files: [], rawBytes: 0 } : getUntrackedFilesDiff(cwd, repoRoot)

  return {
    ok: true,
    cwd,
    files: [...parseUnifiedDiff(parseText), ...untracked.files],
    rawBytes: rawBytes + untracked.rawBytes,
    ...(truncated ? { truncated: true } : {})
  }
}

function getUntrackedFilesDiff(cwd: string, repoRoot: string): { files: WorkspaceDiffFile[]; rawBytes: number } {
  let output: Buffer
  try {
    output = execFileSync(
      'git',
      withSafeLocalGitConfig(['-C', cwd, 'ls-files', '--others', '--exclude-standard', '-z', '--full-name', '--', '.']),
      {
        encoding: 'buffer',
        env: isolatedLocalGitEnv(process.env),
        maxBuffer: MAX_EXEC_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
  } catch {
    return { files: [], rawBytes: 0 }
  }

  const paths = output.toString('utf8').split('\0').filter(Boolean)
  let rawBytes = 0
  const files: WorkspaceDiffFile[] = []
  for (const relPath of paths) {
    const fullPath = path.join(repoRoot, relPath)
    let buffer: Buffer
    try {
      buffer = readFileSync(fullPath)
    } catch {
      continue
    }
    rawBytes += buffer.length
    files.push(untrackedFileDiff(relPath, buffer))
  }

  return { files, rawBytes }
}

function parseUnifiedDiff(text: string): WorkspaceDiffFile[] {
  const files: ParsedWorkspaceDiffFile[] = []
  let currentFile: ParsedWorkspaceDiffFile | null = null
  let currentHunk: ParsedWorkspaceDiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  const finalizeHunk = (): void => {
    if (!currentFile || !currentHunk) return
    currentHunk.patch = `${currentFile.patchHeader.join('\n')}\n${currentHunk.patchLines.join('\n')}\n`
  }

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finalizeHunk()
      currentFile = createFileFromHeader(line)
      files.push(currentFile)
      currentHunk = null
      oldLine = 0
      newLine = 0
      continue
    }

    if (!currentFile) continue

    if (line.startsWith('new file mode ')) {
      currentFile.patchHeader.push(line)
      currentFile.status = 'added'
      continue
    }

    if (line.startsWith('deleted file mode ')) {
      currentFile.patchHeader.push(line)
      currentFile.status = 'deleted'
      continue
    }

    if (line.startsWith('rename from ')) {
      currentFile.patchHeader.push(line)
      currentFile.status = 'renamed'
      currentFile.oldPath = unquoteGitPath(line.slice('rename from '.length))
      continue
    }

    if (line.startsWith('rename to ')) {
      currentFile.patchHeader.push(line)
      currentFile.status = 'renamed'
      currentFile.newPath = unquoteGitPath(line.slice('rename to '.length))
      continue
    }

    if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
      currentFile.status = 'binary'
      currentFile.binary = true
      currentHunk = null
      continue
    }

    if (line === 'GIT binary patch') {
      currentFile.status = 'binary'
      currentFile.binary = true
      currentHunk = null
      continue
    }

    if (line.startsWith('--- ')) {
      currentFile.patchHeader.push(line)
      currentFile.oldPath = parseFilePathLine(line.slice(4))
      continue
    }

    if (line.startsWith('+++ ')) {
      currentFile.patchHeader.push(line)
      currentFile.newPath = parseFilePathLine(line.slice(4))
      continue
    }

    const hunkMatch = line.match(HUNK_RE)
    if (hunkMatch) {
      finalizeHunk()
      const hunk: ParsedWorkspaceDiffHunk = {
        header: line,
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        patchLines: [line],
        lines: []
      }
      currentFile.hunks.push(hunk)
      currentHunk = hunk
      oldLine = hunk.oldStart
      newLine = hunk.newStart
      continue
    }

    if (!currentHunk) continue
    if (line === '') continue

    currentHunk.patchLines.push(line)

    if (line.startsWith('\\ ')) continue

    if (line.startsWith(' ')) {
      currentHunk.lines.push({
        type: 'context',
        text: displayDiffLine(line),
        oldLine,
        newLine
      })
      oldLine += 1
      newLine += 1
      continue
    }

    if (line.startsWith('+')) {
      currentHunk.lines.push({
        type: 'add',
        text: displayDiffLine(line),
        newLine
      })
      newLine += 1
      continue
    }

    if (line.startsWith('-')) {
      currentHunk.lines.push({
        type: 'delete',
        text: displayDiffLine(line),
        oldLine
      })
      oldLine += 1
    }
  }

  finalizeHunk()

  return files.map(({ patchHeader, ...file }) => ({
    ...file,
    hunks: file.hunks.map((hunk) => {
      const { patchLines, ...cleanHunk } = hunk as ParsedWorkspaceDiffHunk
      return cleanHunk
    })
  }))
}

function untrackedFileDiff(relPath: string, buffer: Buffer): WorkspaceDiffFile {
  const text = buffer.toString('utf8')
  if (
    buffer.includes(0) ||
    buffer.length > MAX_UNTRACKED_FILE_BYTES ||
    !Buffer.from(text, 'utf8').equals(buffer)
  ) {
    return { oldPath: relPath, newPath: relPath, status: 'binary', hunks: [], binary: true }
  }
  if (buffer.length === 0) return { oldPath: relPath, newPath: relPath, status: 'added', hunks: [] }
  const hasFinalNewline = text.endsWith('\n')
  const lines = text.split('\n')
  if (hasFinalNewline) lines.pop()
  const header = `@@ -0,0 +1,${lines.length} @@`
  const patchHeader = [
    `diff --git a/${relPath} b/${relPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relPath}`
  ]
  const patchLines = [header, ...lines.map((line) => `+${line}`)]
  if (!hasFinalNewline) patchLines.push('\\ No newline at end of file')
  return {
    oldPath: relPath,
    newPath: relPath,
    status: 'added',
    hunks: [{
      header,
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      patch: `${patchHeader.join('\n')}\n${patchLines.join('\n')}\n`,
      lines: lines.map<WorkspaceDiffLine>((line, index) => ({
        type: 'add',
        text: line.endsWith('\r') ? line.slice(0, -1) : line,
        newLine: index + 1
      }))
    }]
  }
}

function displayDiffLine(line: string): string {
  const text = line.slice(1)
  return text.endsWith('\r') ? text.slice(0, -1) : text
}

function createFileFromHeader(line: string): ParsedWorkspaceDiffFile {
  const paths = parseDiffGitPaths(line)
  return {
    oldPath: paths.oldPath,
    newPath: paths.newPath,
    status: 'modified',
    patchHeader: [line],
    hunks: []
  }
}

function parseDiffGitPaths(line: string): { oldPath: string; newPath: string } {
  const body = line.slice('diff --git '.length)
  const splitAt = body.lastIndexOf(' b/')
  if (splitAt === -1) {
    return { oldPath: '', newPath: '' }
  }

  const oldPath = stripPathPrefix(body.slice(0, splitAt), 'a/')
  const newPath = stripPathPrefix(body.slice(splitAt + 1), 'b/')
  return { oldPath, newPath }
}

function parseFilePathLine(path: string): string {
  const clean = unquoteGitPath(path.split('\t')[0])
  if (clean === '/dev/null') return clean
  if (clean.startsWith('a/') || clean.startsWith('b/')) return clean.slice(2)
  return clean
}

function stripPathPrefix(path: string, prefix: 'a/' | 'b/'): string {
  const clean = unquoteGitPath(path)
  return clean.startsWith(prefix) ? clean.slice(prefix.length) : clean
}

function unquoteGitPath(path: string): string {
  const trimmed = path.trim()
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) {
    return trimmed
  }

  try {
    return JSON.parse(trimmed) as string
  } catch {
    return trimmed.slice(1, -1)
  }
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const maybeError = error as {
      message?: unknown
      stderr?: unknown
      code?: unknown
    }
    const stderr =
      Buffer.isBuffer(maybeError.stderr) || typeof maybeError.stderr === 'string'
        ? String(maybeError.stderr).trim()
        : ''
    if (stderr) return stderr
    if (typeof maybeError.message === 'string' && maybeError.message.trim()) {
      return maybeError.message
    }
    if (maybeError.code !== undefined) return String(maybeError.code)
  }
  return String(error)
}
