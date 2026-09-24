import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { SessionMeta } from '../../shared/types'
import type { LocalDevServerConfig, LocalDevServerRun, LocalDevServerStart, LocalDevServerView } from '../../shared/local-dev-server-types'
import { writeDurableFileSync } from '../durable-file'
import { taskExecutionAuthorityBindingDigest } from '../permission/task-execution-authority-store'
import { buildMinimalSubprocessEnv } from '../security/subprocess-environment'
import { normalizeDevServerConfig, probeDevServer, redactDevServerText } from './local-dev-server-validation'

interface Host {
  root(): string
  session(id: string): SessionMeta | undefined
  authorize(meta: SessionMeta, config: LocalDevServerConfig, assertOwner: () => void): Promise<() => Promise<void>>
  perform(action: 'start' | 'stop', meta: SessionMeta, run: LocalDevServerRun, execute: () => Promise<void>): Promise<string | undefined>
}
interface Managed {
  view: LocalDevServerRun; meta: SessionMeta; taskKey: string; owner: number; cancelled: boolean
  child?: ChildProcess; guard?: () => Promise<void>; refreshing?: boolean; killTimer?: NodeJS.Timeout
  stopPromise?: Promise<LocalDevServerView>; stopRecorded?: boolean
}
const active = (run: LocalDevServerRun): boolean => ['starting', 'running', 'stopping'].includes(run.status)
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const devServerOperationId = (sessionId: string, requestId: string, action: 'start' | 'stop'): string => `local-dev-${action}-${hash(`${sessionId}\0${requestId}`)}`

/** Owns only children created during this app lifetime. Persisted PIDs are never adopted or killed. */
export class LocalDevServerService {
  private readonly runs = new Map<string, Managed>()
  private readonly usedIds = new Set<string>()
  private disposed = false
  constructor(private readonly host: Host) {}
  get(sessionId: string): LocalDevServerView {
    const meta = this.host.session(sessionId), row = this.runs.get(sessionId)
    let current = row?.view ?? null, warning: string | undefined
    if (!current && meta) {
      try { current = this.restore(meta) } catch { warning = '上次开发服务记录不可读；原记录未被覆盖。' }
    }
    let taskCwd = meta?.cwd ?? row?.meta.cwd ?? ''
    try { taskCwd = realpathSync(taskCwd) } catch { /* Keep the unavailable task path visible. */ }
    return { supported: process.platform !== 'win32', taskCwd, current: current ? structuredClone(current) : null, warning }
  }
  async start(owner: number, input: LocalDevServerStart, assertOwner: () => void): Promise<LocalDevServerView> {
    if (this.disposed) throw new Error('应用正在退出。')
    if (process.platform === 'win32') throw new Error('Windows 托管进程树尚未接通，请使用任务终端。')
    if (!input || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) throw new Error('启动请求身份无效。')
    if (this.usedIds.has(input.requestId)) throw new Error('该启动请求已处理，请刷新实际状态后重新操作。')
    const meta = { ...this.requireSession(input.sessionId) }, config = normalizeDevServerConfig(input, meta.cwd)
    if (this.runs.get(meta.id) && active(this.runs.get(meta.id)!.view)) throw new Error('当前任务已有服务正在启动、运行或停止。')
    if ([...this.runs.values()].filter(row => active(row.view)).length >= 8) throw new Error('最多同时托管 8 个开发服务。')
    // Read errors must not silently overwrite a prior record.
    if (this.restore(meta)?.id === input.requestId) throw new Error('该启动请求已有持久记录，不能再次执行；请先核对原运行。')
    this.usedIds.add(input.requestId)
    const row: Managed = { owner, meta, taskKey: taskExecutionAuthorityBindingDigest(meta), cancelled: false,
      view: { id: input.requestId, sessionId: meta.id, config, status: 'starting', startedAt: Date.now(), reachable: false, logs: [], operationId: devServerOperationId(meta.id, input.requestId, 'start') } }
    this.runs.set(meta.id, row)
    const assertCurrent = (): void => { assertOwner(); this.assertCurrent(row) }
    try {
      assertCurrent(); this.persist(row)
      row.guard = await this.host.authorize(meta, config, assertCurrent)
      assertCurrent()
      const operationId = await this.host.perform('start', meta, row.view, async () => {
        assertCurrent(); await row.guard!(); assertCurrent()
        if (await probeDevServer(config.url)) throw new Error('所填地址已可访问，可能属于其他进程。请先确认并停止旧服务，或为新服务选择其他端口。')
        assertCurrent(); await row.guard!(); assertCurrent()
        await this.launch(row)
      })
      row.view.operationId = operationId ?? row.view.operationId
      this.persist(row)
    } catch (error) {
      const message = redactDevServerText(error instanceof Error ? error.message : String(error))
      row.view.message = message
      if (row.child) this.requestStop(row, message)
      else { row.view.status = row.cancelled ? 'stopped' : 'failed'; row.view.endedAt = Date.now(); this.persistSafely(row) }
      throw new Error(message)
    }
    return this.get(meta.id)
  }
  async stop(sessionId: string, requestId: string): Promise<LocalDevServerView> {
    const row = this.runs.get(sessionId)
    if (!row || row.view.id !== requestId || !active(row.view)) return this.get(sessionId)
    if (row.stopPromise) return row.stopPromise
    if (row.stopRecorded) return this.get(sessionId)
    row.cancelled = true // Cancellation wins even while the start is waiting for approval or an Effect queue.
    row.view.stopOperationId = devServerOperationId(sessionId, requestId, 'stop')
    row.stopPromise = this.performStop(row)
    return row.stopPromise
  }
  private async performStop(row: Managed): Promise<LocalDevServerView> {
    try {
      this.persist(row)
      await this.host.perform('stop', row.meta, row.view, async () => { this.requestStop(row, '已请求停止开发服务。') })
      row.stopRecorded = true
    } catch (error) {
      // Cancellation remains effective if receipt persistence fails; never trap a revoked process behind approval.
      this.requestStop(row, `已请求停止；操作回执写入失败：${redactDevServerText(String(error))}`)
      row.stopRecorded = true // An unknown receipt is never replayed under a fresh operation identity.
      throw error
    }
    return this.get(row.meta.id)
  }
  async refresh(sessionId?: string): Promise<void> {
    await Promise.all([...this.runs.values()].filter(row => !sessionId || row.meta.id === sessionId).map(async row => {
      if (!active(row.view) || row.refreshing || row.cancelled) return
      row.refreshing = true
      try {
        this.assertCurrent(row); await row.guard?.(); this.assertCurrent(row)
        if (row.view.status !== 'running') return
        const reachable = await probeDevServer(row.view.config.url)
        if (row.view.status === 'running' && !row.cancelled) { row.view.reachable = reachable; row.view.checkedAt = Date.now() }
      } catch (error) { this.requestStop(row, `服务已停止执行：${redactDevServerText(String(error))}`) }
      finally { row.refreshing = false }
    }))
  }
  stopOwner(owner: number): void { for (const row of this.runs.values()) if (row.owner === owner && active(row.view)) this.requestStop(row, '原工作窗口已关闭或重新载入。') }
  dispose(): void {
    this.disposed = true
    for (const row of this.runs.values()) if (active(row.view)) { this.requestStop(row, '应用正在退出。'); this.signal(row, 'SIGKILL') }
  }
  private requireSession(id: string): SessionMeta {
    const meta = this.host.session(id)
    if (!meta || meta.status === 'closed' || meta.sideChat || meta.taskStrategy !== 'execute') throw new Error('原任务必须保持打开，并选择执行意图。')
    return meta
  }
  private assertCurrent(row: Managed): void {
    if (this.disposed || row.cancelled) throw new Error('开发服务启动已取消。')
    if (taskExecutionAuthorityBindingDigest(this.requireSession(row.meta.id)) !== row.taskKey) throw new Error('原任务或真实工作目录身份已变化。')
  }
  private launch(row: Managed): Promise<void> {
    return new Promise((resolveStart, rejectStart) => {
      const child = spawn('/bin/sh', ['-c', row.view.config.command], { cwd: row.view.config.cwd, env: buildMinimalSubprocessEnv(), detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      row.child = child
      const flushOut = this.logs(row, child.stdout!, 'stdout'), flushErr = this.logs(row, child.stderr!, 'stderr')
      child.once('spawn', () => {
        row.view.pid = child.pid
        if (row.cancelled) { this.requestStop(row, '启动已取消。'); rejectStart(new Error('开发服务启动已取消。')); return }
        row.view.status = 'running'; this.persistSafely(row); resolveStart()
      })
      child.once('error', error => { row.view.message = redactDevServerText(error.message); rejectStart(error) })
      child.once('exit', (code, signal) => {
        row.view.exitCode = code; row.view.signal = signal
        // A shell can exit while a descendant holds the pipes. End this owned process group as well.
        this.signal(row, 'SIGTERM')
        if (!row.killTimer) row.killTimer = setTimeout(() => this.signal(row, 'SIGKILL'), 1500)
        row.killTimer.unref()
      })
      child.once('close', (code, signal) => {
        // Close means the owned child's stdio also closed. Kill surviving descendants before releasing identity.
        this.signal(row, 'SIGKILL')
        clearTimeout(row.killTimer); row.killTimer = undefined
        flushOut(); flushErr(); row.child = undefined
        row.view.exitCode = code; row.view.signal = signal; row.view.reachable = false; row.view.endedAt = Date.now()
        row.view.status = row.cancelled ? 'stopped' : code === 0 ? 'exited' : 'failed'
        this.persistSafely(row)
      })
    })
  }
  private requestStop(row: Managed, message: string): void {
    row.cancelled = true; row.view.message = message; row.view.reachable = false
    if (row.child) {
      row.view.status = 'stopping'; this.signal(row, 'SIGTERM')
      if (!row.killTimer) { row.killTimer = setTimeout(() => { this.signal(row, 'SIGKILL'); row.view.message = `${message} 已发出强制结束信号，等待进程退出回执。` }, 1500); row.killTimer.unref() }
    } else { row.view.status = 'stopped'; row.view.endedAt = Date.now() }
    this.persistSafely(row)
  }
  private signal(row: Managed, signal: NodeJS.Signals): void {
    const pid = row.child?.pid
    if (!pid) return
    try { process.kill(-pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') row.view.message = `停止进程组失败：${redactDevServerText(String(error))}` }
  }
  private logs(row: Managed, stream: NodeJS.ReadableStream, label: string): () => void {
    const decoder = new StringDecoder('utf8'); let pending = '', dropping = false
    const append = (line: string): void => {
      row.view.logs.push(`[${label}] ${redactDevServerText(line)}`)
      while (row.view.logs.length > 500 || row.view.logs.reduce((sum, value) => sum + Buffer.byteLength(value), 0) > 65536) row.view.logs.shift()
    }
    const consume = (text: string): void => {
      for (const part of text.split(/(?<=\n)/)) {
        if (!dropping) pending += part
        if (pending.length > 16384) { pending = ''; dropping = true }
        if (part.endsWith('\n')) { append(dropping ? '超长日志行已省略。' : pending.trimEnd()); pending = ''; dropping = false }
      }
    }
    stream.on('data', (chunk: Buffer) => consume(decoder.write(chunk)))
    return () => { consume(decoder.end()); if (pending) append(pending); pending = '' }
  }
  private file(sessionId: string): string {
    const root = realpathSync(this.host.root()), directory = join(root, 'local-dev-servers')
    try { mkdirSync(directory, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('开发服务记录目录无效。')
    return join(directory, `${hash(sessionId)}.json`)
  }
  private persist(row: Managed): void {
    // Logs are volatile. Do not persist credentials printed by arbitrary project code.
    writeDurableFileSync(this.file(row.meta.id), JSON.stringify({ version: 1, taskKey: row.taskKey, run: { ...row.view, logs: [] } }))
  }
  private persistSafely(row: Managed): void { try { this.persist(row) } catch { row.view.message = `${row.view.message ?? ''} 服务状态无法保存到本机记录。`.trim() } }
  private restore(meta: SessionMeta): LocalDevServerRun | null {
    const file = this.file(meta.id)
    let info: ReturnType<typeof lstatSync>
    try { info = lstatSync(file) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32768) throw new Error('开发服务记录格式无效。')
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    if (stored.version !== 1 || stored.taskKey !== taskExecutionAuthorityBindingDigest(meta)) return null
    const run = stored.run as LocalDevServerRun
    if (!run || run.sessionId !== meta.id || typeof run.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(run.id) || !Number.isFinite(run.startedAt)) throw new Error('开发服务记录身份无效。')
    const config = normalizeDevServerConfig(run.config, meta.cwd)
    const terminal = ['stopped', 'exited', 'failed'].includes(run.status)
    return { id: run.id, sessionId: meta.id, config, startedAt: run.startedAt, endedAt: typeof run.endedAt === 'number' ? run.endedAt : undefined,
      status: terminal ? run.status : 'interrupted', reachable: false, logs: [],
      operationId: devServerOperationId(meta.id, run.id, 'start'), ...(run.stopOperationId ? { stopOperationId: devServerOperationId(meta.id, run.id, 'stop') } : {}),
      ...(terminal ? { exitCode: Number.isInteger(run.exitCode) ? run.exitCode : null, signal: typeof run.signal === 'string' ? run.signal.slice(0, 30) : null,
        message: '上次运行的已确认结束记录。当前没有托管该进程，日志只保留在原应用运行期间。' }
        : { message: '这是上次应用运行的记录；进程状态未知。未接管旧 PID，也未自动重启，请先确认端口实际状态。' }) }
  }
}
