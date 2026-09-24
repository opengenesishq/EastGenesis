import { assertTaskExecutionEnvironment, assertWslBinding, parseWslHostPath } from './wsl/binding'
import { createWslJob, type WslJob } from './wsl/job'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn as spawnProcess } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { chmodSync, existsSync, realpathSync, statSync } from 'node:fs'
import type { IDisposable, IPty } from 'node-pty'
import { buildMinimalSubprocessEnv } from './security/subprocess-environment'

type NodePtyModule = typeof import('node-pty')

export type TerminalBackend = 'pty' | 'pipe'

export interface TerminalStartOptions {
  executionEnvironment?: import('../shared/wsl-types').ExecutionEnvironmentBinding
  cwd: string
  sessionId?: string
  ownerWebContentsId?: number
  workspaceId?: string
  projectId?: string
  shell?: string
  /** Main-process supplied executable arguments; never copied from renderer options. */
  args?: string[]
  requirePty?: boolean
  cols?: number
  rows?: number
  env?: Record<string, string | undefined>
  reuse?: boolean
}

export interface TerminalExitInfo {
  exitCode: number | null
  signal?: number | string
  reason?: string
  at: number
}

export interface TerminalInfo {
  executionEnvironment?: import('../shared/wsl-types').ExecutionEnvironmentBinding
  id: string
  sessionId?: string
  ownerWebContentsId?: number
  workspaceId?: string
  projectId?: string
  cwd: string
  shell: string
  pid?: number
  backend: TerminalBackend
  cols: number
  rows: number
  startedAt: number
  fallbackReason?: string
  exit?: TerminalExitInfo
}

export type TerminalEvent =
  | { kind: 'started'; terminal: TerminalInfo }
  | { kind: 'output'; id: string; data: string }
  | { kind: 'exit'; id: string; exit: TerminalExitInfo }
  | { kind: 'error'; id?: string; message: string; fatal: boolean }

type TerminalListener = (event: TerminalEvent) => void

type TerminalProcess =
  | { backend: 'pty'; pty: IPty; disposables: IDisposable[] }
  | { backend: 'pipe'; child: ChildProcessWithoutNullStreams }

interface TerminalRecord {
  wslJob?: WslJob
  info: TerminalInfo
  process: TerminalProcess
  closed: boolean
}

let nodePtyPromise: Promise<NodePtyModule> | undefined
const requireFromHere = createRequire(import.meta.url)

function ensureNodePtySpawnHelper(): void {
  if (process.platform === 'win32') return
  let packageRoot: string
  try {
    packageRoot = resolve(dirname(requireFromHere.resolve('node-pty')), '..')
  } catch {
    return
  }

  const candidates = [
    join(packageRoot, 'build', 'Release', 'spawn-helper'),
    join(packageRoot, 'build', 'Debug', 'spawn-helper'),
    join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  ]
  for (const helper of candidates) {
    if (!existsSync(helper)) continue
    try {
      const stat = statSync(helper)
      if ((stat.mode & 0o111) === 0) chmodSync(helper, stat.mode | 0o755)
    } catch {
      // If the package is read-only, node-pty spawn will fail and the manager
      // will fall back to a pipe-backed shell.
    }
  }
}

async function loadNodePty(): Promise<NodePtyModule> {
  ensureNodePtySpawnHelper()
  nodePtyPromise ??= import('node-pty').then((mod) => {
    const withDefault = mod as NodePtyModule & { default?: NodePtyModule }
    return typeof withDefault.spawn === 'function' ? withDefault : (withDefault.default ?? withDefault)
  })
  return nodePtyPromise
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function isBenignNodePtyDiagnostic(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    normalized.includes('attachconsole') &&
    (normalized.includes('access is denied') ||
      normalized.includes('already attached') ||
      normalized.includes('invalid handle') ||
      normalized.includes('failed'))
  )
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe'
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
}

function fallbackShellArgs(shell: string): string[] {
  if (process.platform === 'win32') return []
  const name = basename(shell)
  if (name === 'csh' || name === 'tcsh') return ['-i']
  return ['-i']
}

function normalizeCwd(cwd: string): string {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    throw new Error('必须指定终端工作目录')
  }
  const resolved = resolve(cwd)
  let stat
  try {
    stat = statSync(resolved)
  } catch {
    throw new Error(`终端工作目录不存在: ${resolved}`)
  }
  if (!stat.isDirectory()) throw new Error(`终端工作目录不是目录: ${resolved}`)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function clampDimension(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(2, Math.floor(value)))
}

function terminalEnv(cwd: string, extra: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const env = buildMinimalSubprocessEnv({
    ...extra,
    TERM: extra?.TERM ?? process.env.TERM ?? 'xterm-256color',
    COLORTERM: extra?.COLORTERM ?? process.env.COLORTERM ?? 'truecolor',
    TERM_PROGRAM: 'EastGenesis'
  })
  if (process.platform !== 'win32') env.PWD = cwd
  return env
}

function cwdKey(cwd: string, owner?: number): string { return `${owner ?? 'shared'}\0${cwd}` }

function snapshot(info: TerminalInfo): TerminalInfo {
  return {
    ...info,
    exit: info.exit ? { ...info.exit } : undefined
  }
}

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>()
  private readonly bySession = new Map<string, string>()
  private readonly byCwd = new Map<string, string>()
  private readonly listeners = new Set<TerminalListener>()

  subscribe(listener: TerminalListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map((record) => snapshot(record.info))
  }

  get(id: string): TerminalInfo | undefined {
    const record = this.terminals.get(id)
    return record ? snapshot(record.info) : undefined
  }

  getBySession(sessionId: string): TerminalInfo | undefined {
    const id = this.bySession.get(sessionId)
    return id ? this.get(id) : undefined
  }

  async start(opts: TerminalStartOptions): Promise<TerminalInfo> {
    const cwd = normalizeCwd(opts.cwd)
    if (opts.executionEnvironment?.kind === 'wsl') assertWslBinding(opts.executionEnvironment, cwd)
    else if (parseWslHostPath(cwd)) throw new Error('WSL 终端必须绑定已核对的发行版与目录。')
    const existingId = opts.sessionId ? this.bySession.get(opts.sessionId) : this.byCwd.get(cwdKey(cwd, opts.ownerWebContentsId))
    const existing = existingId ? this.terminals.get(existingId) : undefined
    if (opts.reuse !== false && existing && !existing.closed && existing.info.sessionId === opts.sessionId && existing.info.ownerWebContentsId === opts.ownerWebContentsId) {
      if (JSON.stringify(existing.info.executionEnvironment) !== JSON.stringify(opts.executionEnvironment)) throw new Error('现有终端的执行环境不同，请关闭后重新打开。')
      return snapshot(existing.info)
    }
    const wslJob = opts.executionEnvironment?.kind === 'wsl' ? createWslJob(opts.executionEnvironment, { interactive: true }) : undefined
    if (wslJob && (opts.shell || opts.args || opts.env)) throw new Error('WSL 终端的 Shell 与环境由已绑定的执行器管理。')
    const launchCwd = wslJob?.cwd ?? cwd
    const launchArgs = wslJob?.args ?? opts.args

    const shell = wslJob?.file ?? (opts.shell?.trim() || defaultShell())
    const cols = clampDimension(opts.cols, 80, 1000)
    const rows = clampDimension(opts.rows, 24, 1000)
    const env = terminalEnv(cwd, opts.env)
    const id = randomUUID()

    let record: TerminalRecord
    let ptyError: string | undefined
    let notifyPtyError = false
    try {
      record = await this.startPty({ id, sessionId: opts.sessionId, cwd: launchCwd, shell, args: launchArgs, cols, rows, env })
    } catch (err) {
      if (opts.requirePty || wslJob) throw new Error(`交互终端不可用：${errText(err)}`)
      const rawPtyError = errText(err)
      if (!isBenignNodePtyDiagnostic(rawPtyError)) {
        ptyError = rawPtyError
        notifyPtyError = true
      }
      record = this.startPipe({ id, sessionId: opts.sessionId, cwd, shell, args: opts.args, cols, rows, env, ptyError })
    }

    record.wslJob = wslJob
    record.info.cwd = cwd
    record.info.executionEnvironment = opts.executionEnvironment
    record.info.ownerWebContentsId = opts.ownerWebContentsId
    record.info.workspaceId = opts.workspaceId
    record.info.projectId = opts.projectId
    this.remember(record)
    this.emit({ kind: 'started', terminal: snapshot(record.info) })
    if (notifyPtyError && ptyError) {
      queueMicrotask(() =>
        this.emit({
          kind: 'error',
          id,
          message: `node-pty 不可用,已降级为 pipe shell: ${ptyError}`,
          fatal: false
        })
      )
    }
    return snapshot(record.info)
  }

  write(id: string, data: string): void {
    const record = this.requireTerminal(id)
    if (record.info.executionEnvironment?.kind === 'wsl') assertTaskExecutionEnvironment(record.info)
    if (record.process.backend === 'pty') {
      record.process.pty.write(data)
      return
    }
    if (!record.process.child.stdin.destroyed) record.process.child.stdin.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const record = this.requireTerminal(id)
    const nextCols = clampDimension(cols, record.info.cols, 1000)
    const nextRows = clampDimension(rows, record.info.rows, 1000)
    record.info.cols = nextCols
    record.info.rows = nextRows
    if (record.process.backend === 'pty') record.process.pty.resize(nextCols, nextRows)
  }

  close(
    id: string,
    signal: NodeJS.Signals = process.platform === 'win32' ? 'SIGTERM' : 'SIGHUP'
  ): void {
    const record = this.terminals.get(id)
    if (!record || record.closed) return
    this.kill(record, signal)
    const timer = setTimeout(() => {
      const current = this.terminals.get(id)
      if (!current || current.closed) return
      if (current.process.backend === 'pipe' && !current.process.child.killed) {
        current.process.child.kill('SIGKILL')
      }
      this.finish(id, { exitCode: null, signal, reason: 'closed', at: Date.now() })
    }, 1500)
    timer.unref?.()
  }

  disposeAll(): void {
    for (const id of [...this.terminals.keys()]) {
      const record = this.terminals.get(id)
      if (!record || record.closed) continue
      this.kill(record, process.platform === 'win32' ? 'SIGTERM' : 'SIGHUP')
      this.finish(id, {
        exitCode: null,
        signal: process.platform === 'win32' ? 'SIGTERM' : 'SIGHUP',
        reason: 'disposed',
        at: Date.now()
      })
    }
  }

  private async startPty(args: {
    id: string
    sessionId?: string
    cwd: string
    shell: string
    args?: string[]
    cols: number
    rows: number
    env: NodeJS.ProcessEnv
  }): Promise<TerminalRecord> {
    const nodePty = await loadNodePty()
    const pty = nodePty.spawn(args.shell, args.args ?? [], {
      name: 'xterm-256color',
      cwd: args.cwd,
      cols: args.cols,
      rows: args.rows,
      env: args.env,
      encoding: 'utf8'
    })
    const disposables = [
      pty.onData((data) => this.emitOutput(args.id, data)),
      pty.onExit(({ exitCode, signal }) => {
        this.finish(args.id, { exitCode, signal, at: Date.now() })
      })
    ]
    return {
      closed: false,
      process: { backend: 'pty', pty, disposables },
      info: {
        id: args.id,
        sessionId: args.sessionId,
        cwd: args.cwd,
        shell: args.shell,
        pid: pty.pid,
        backend: 'pty',
        cols: args.cols,
        rows: args.rows,
        startedAt: Date.now()
      }
    }
  }

  private startPipe(args: {
    id: string
    sessionId?: string
    cwd: string
    shell: string
    args?: string[]
    cols: number
    rows: number
    env: NodeJS.ProcessEnv
    ptyError?: string
  }): TerminalRecord {
    const child = spawnProcess(args.shell, args.args ?? fallbackShellArgs(args.shell), {
      cwd: args.cwd,
      env: args.env,
      stdio: 'pipe'
    })
    child.stdout.on('data', (data: Buffer | string) => this.emitOutput(args.id, data))
    child.stderr.on('data', (data: Buffer | string) => this.emitOutput(args.id, data))
    child.on('error', (err) => {
      this.emit({ kind: 'error', id: args.id, message: errText(err), fatal: true })
      this.finish(args.id, { exitCode: null, reason: 'error', at: Date.now() })
    })
    child.on('exit', (exitCode, signal) => {
      this.finish(args.id, { exitCode, signal: signal ?? undefined, at: Date.now() })
    })

    return {
      closed: false,
      process: { backend: 'pipe', child },
      info: {
        id: args.id,
        sessionId: args.sessionId,
        cwd: args.cwd,
        shell: args.shell,
        pid: child.pid,
        backend: 'pipe',
        cols: args.cols,
        rows: args.rows,
        startedAt: Date.now(),
        fallbackReason: args.ptyError
      }
    }
  }

  private remember(record: TerminalRecord): void {
    this.terminals.set(record.info.id, record)
    if (record.info.sessionId) this.bySession.set(record.info.sessionId, record.info.id)
    this.byCwd.set(cwdKey(record.info.cwd, record.info.ownerWebContentsId), record.info.id)
  }

  private forget(record: TerminalRecord): void {
    this.terminals.delete(record.info.id)
    if (record.info.sessionId && this.bySession.get(record.info.sessionId) === record.info.id) {
      this.bySession.delete(record.info.sessionId)
    }
    if (this.byCwd.get(cwdKey(record.info.cwd, record.info.ownerWebContentsId)) === record.info.id) this.byCwd.delete(cwdKey(record.info.cwd, record.info.ownerWebContentsId))
  }

  private requireTerminal(id: string): TerminalRecord {
    const record = this.terminals.get(id)
    if (!record || record.closed) throw new Error(`终端不存在或已关闭: ${id}`)
    return record
  }

  private emitOutput(id: string, raw: Buffer | string): void {
    if (!this.terminals.has(id)) return
    const data = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw
    if (data.length > 0) this.emit({ kind: 'output', id, data })
  }

  private finish(id: string, exit: TerminalExitInfo): void {
    const record = this.terminals.get(id)
    if (!record || record.closed) return
    record.closed = true
    record.info.exit = exit
    if (record.process.backend === 'pty') {
      for (const disposable of record.process.disposables) disposable.dispose()
    } else {
      record.process.child.stdout.removeAllListeners()
      record.process.child.stderr.removeAllListeners()
      record.process.child.removeAllListeners()
    }
    this.emit({ kind: 'exit', id, exit: { ...exit } })
    this.forget(record)
  }

  private kill(record: TerminalRecord, signal: NodeJS.Signals): void {
    try { record.wslJob?.stop() } catch (error) { this.emit({ kind: 'error', id: record.info.id, message: `WSL 进程停止结果未确认：${errText(error)}`, fatal: false }) }
    try {
      if (record.process.backend === 'pty') {
        try {
          record.process.pty.kill(signal)
        } catch {
          record.process.pty.kill()
        }
      } else if (!record.process.child.killed) {
        record.process.child.kill(signal)
      }
    } catch (err) {
      this.emit({ kind: 'error', id: record.info.id, message: errText(err), fatal: false })
    }
  }

  private emit(event: TerminalEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

export const terminalManager = new TerminalManager()
