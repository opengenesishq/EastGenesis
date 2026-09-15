import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { CommandTermination, SandboxMode } from '../../shared/types'
import { resolveWritableProjectPath } from '../utils/safe-project-path'
import { buildMinimalSubprocessEnv } from '../security/subprocess-environment'

export interface LocalCommandOptions {
  command: string
  cwd: string
  mode: SandboxMode
  timeoutMs: number
  maxBufferBytes: number
  chinaMirrorEnabled?: boolean
  npmRegistry?: string
  pipIndexUrl?: string
  signal?: AbortSignal
}

export interface LocalCommandResult {
  ok: boolean
  output: string
  exitCode: number
  commandTermination?: CommandTermination
  modeUsed: SandboxMode
  sandboxed: boolean
  fallbackReason?: string
}

export interface LocalCommandExecutionResult extends LocalCommandResult {
  commandTermination: CommandTermination
}

export interface LocalFileWriteOptions {
  cwd: string
  targetPath: string
  content: string
  mode: SandboxMode
  timeoutMs: number
  chinaMirrorEnabled?: boolean
  npmRegistry?: string
  pipIndexUrl?: string
  signal?: AbortSignal
  expectedFile?: LocalFileWritePrecondition
  beforeGuardedCommit?: () => Promise<void> | void
  /** Synchronous authority check immediately before each filesystem mutation. */
  assertWriteAuthorized?: () => void
  beforeGuardedPathVerificationRead?: (
    phase: 'precondition' | 'postcondition',
    targetPath: string
  ) => Promise<void> | void
}

export type LocalFileWritePrecondition =
  | {
      state?: 'file'
      identity: { device: string; inode: string }
      sha256: string
      bytes: number
    }
  | {
      state: 'absent'
      rootPath: string
      rootIdentity: { device: string; inode: string }
    }

interface GuardedParentPath {
  rootPath: string
  rootIdentity: { device: string; inode: string }
  parentPath: string
  parentIdentity: { device: string; inode: string }
  targetPath: string
}

interface ExecFileResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
  commandTermination: CommandTermination
  errorMessage?: string
}

export async function runLocalCommand(options: LocalCommandOptions): Promise<LocalCommandExecutionResult> {
  if (options.mode === 'disabled') return localExecutionDisabledResult()
  if (options.signal?.aborted) return abortedResult(options.mode)
  const command = options.command.trim()
  if (!command) {
    return {
      ok: false,
      output: '命令不能为空',
      exitCode: 1,
      commandTermination: 'not_started',
      modeUsed: options.mode,
      sandboxed: false
    }
  }

  return runHostCommand({ ...options, command })
}

export async function writeTextFileLocally(options: LocalFileWriteOptions): Promise<LocalCommandResult> {
  if (options.mode === 'disabled') return localExecutionDisabledResult()
  if (options.signal?.aborted) return abortedResult(options.mode)
  const safePath = await resolveWritableProjectPath(options.cwd, options.targetPath).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error)
  }))
  if ('error' in safePath) {
    return {
      ok: false,
      output: `target path escapes workspace:${options.targetPath}; ${safePath.error}`,
      exitCode: 1,
      modeUsed: options.mode,
      sandboxed: false
    }
  }
  const cwd = safePath.root
  const targetPath = safePath.fullPath
  const safeOptions = { ...options, cwd, targetPath }
  return writeTextFileOnHost(safeOptions, options.mode)
}

async function writeTextFileOnHost(
  options: LocalFileWriteOptions,
  modeUsed: SandboxMode
): Promise<LocalCommandResult> {
  try {
    if (options.signal?.aborted) return abortedResult(modeUsed)
    if (options.expectedFile) {
      await writeGuardedTextFileOnHost(options)
    } else {
      options.assertWriteAuthorized?.()
      await mkdir(dirname(options.targetPath), { recursive: true })
      options.assertWriteAuthorized?.()
      await writeFile(options.targetPath, options.content, { encoding: 'utf8', signal: options.signal })
    }
    return {
      ok: true,
      output: `已写入 ${relative(resolve(options.cwd), resolve(options.targetPath))}`,
      exitCode: 0,
      modeUsed,
      sandboxed: false
    }
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
      exitCode: 1,
      modeUsed,
      sandboxed: false
    }
  }
}

async function verifyFileWritePrecondition(
  targetPath: string,
  expected: Exclude<LocalFileWritePrecondition, { state: 'absent' }>,
  beforeRead?: () => Promise<void> | void
): Promise<void> {
  const observation = await readStablePathFile(
    targetPath,
    expected.identity,
    'before write',
    beforeRead
  )
  if (
    observation.content.byteLength !== expected.bytes ||
    createHash('sha256').update(observation.content).digest('hex') !== expected.sha256
  ) {
    throw new Error('guarded target content changed before write')
  }
}

async function verifyFileWritePostcondition(
  targetPath: string,
  expectedIdentity: { device: string; inode: string },
  content: string,
  beforeRead?: () => Promise<void> | void
): Promise<void> {
  const observation = await readStablePathFile(
    targetPath,
    expectedIdentity,
    'after write',
    beforeRead
  )
  const output = Buffer.from(content, 'utf8')
  if (observation.content.byteLength !== output.byteLength || !observation.content.equals(output)) {
    throw new Error('guarded target postcondition mismatch after local write')
  }
}

async function readStablePathFile(
  targetPath: string,
  expectedIdentity: { device: string; inode: string },
  phase: string,
  beforeRead?: () => Promise<void> | void
): Promise<{ content: Buffer }> {
  const handle = await open(targetPath, safeOpenFlags(constants.O_RDONLY))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error(`guarded target is not a regular file ${phase}`)
    if (
      before.dev.toString() !== expectedIdentity.device ||
      before.ino.toString() !== expectedIdentity.inode
    ) {
      throw new Error(`guarded target identity changed ${phase}`)
    }
    await beforeRead?.()
    const content = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    const currentPath = await lstat(targetPath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (
      !currentPath ||
      currentPath.isSymbolicLink() ||
      !currentPath.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.dev !== currentPath.dev ||
      before.ino !== currentPath.ino ||
      after.size !== currentPath.size ||
      after.mtimeNs !== currentPath.mtimeNs ||
      after.ctimeNs !== currentPath.ctimeNs ||
      BigInt(content.byteLength) !== before.size
    ) {
      throw new Error(`guarded target path or content changed ${phase}`)
    }
    return { content }
  } finally {
    await handle.close()
  }
}

async function writeGuardedTextFileOnHost(options: LocalFileWriteOptions): Promise<void> {
  const expected = options.expectedFile
  if (!expected) throw new Error('guarded file write is missing its precondition')
  if (isAbsentFilePrecondition(expected)) {
    await writeAbsentTextFileOnHost(options)
    return
  }
  const guardedParent = await captureGuardedParentPath(options.cwd, options.targetPath, undefined, options.assertWriteAuthorized)
  const handle = await open(options.targetPath, safeOpenFlags(constants.O_RDWR))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('guarded target is not a regular file')
    if (
      before.dev.toString() !== expected.identity.device ||
      before.ino.toString() !== expected.identity.inode
    ) {
      throw new Error('guarded target identity changed before write')
    }
    const current = await handle.readFile()
    if (
      current.byteLength !== expected.bytes ||
      createHash('sha256').update(current).digest('hex') !== expected.sha256
    ) {
      throw new Error('guarded target content changed before write')
    }
    if (options.signal?.aborted) throw new Error('操作已中断')
    await options.beforeGuardedCommit?.()
    await verifyGuardedParentPath(guardedParent)
    await verifyFileWritePrecondition(
      options.targetPath,
      expected,
      () => options.beforeGuardedPathVerificationRead?.('precondition', options.targetPath)
    )
    const output = Buffer.from(options.content, 'utf8')
    options.assertWriteAuthorized?.()
    await handle.truncate(0)
    let offset = 0
    while (offset < output.length) {
      options.assertWriteAuthorized?.()
      const written = await handle.write(output, offset, output.length - offset, offset)
      if (written.bytesWritten <= 0) throw new Error('guarded file write made no progress')
      offset += written.bytesWritten
    }
    options.assertWriteAuthorized?.()
    await handle.truncate(output.length)
    await handle.sync()
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error('guarded target identity changed during write')
    }
    await verifyGuardedParentPath(guardedParent)
    await verifyFileWritePostcondition(
      options.targetPath,
      fileIdentity(before),
      options.content,
      () => options.beforeGuardedPathVerificationRead?.('postcondition', options.targetPath)
    )
  } finally {
    await handle.close()
  }
}

async function writeAbsentTextFileOnHost(options: LocalFileWriteOptions): Promise<void> {
  const expected = options.expectedFile
  if (!expected || !isAbsentFilePrecondition(expected)) {
    throw new Error('guarded absent write is missing its approved root identity')
  }
  const guardedParent = await captureGuardedParentPath(options.cwd, options.targetPath, {
    rootPath: expected.rootPath,
    rootIdentity: expected.rootIdentity
  }, options.assertWriteAuthorized)
  await verifyAbsentFilePrecondition(options.targetPath)
  const tempPath = join(dirname(options.targetPath), `.${randomUUID()}.caogen-write.tmp`)
  const noFollow = process.platform !== 'win32' && typeof constants.O_NOFOLLOW === 'number'
    ? constants.O_NOFOLLOW
    : 0
  options.assertWriteAuthorized?.()
  const handle = await open(
    tempPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o666
  )
  try {
    const output = Buffer.from(options.content, 'utf8')
    let offset = 0
    while (offset < output.length) {
      if (options.signal?.aborted) throw new Error('操作已中断')
      options.assertWriteAuthorized?.()
      const written = await handle.write(output, offset, output.length - offset, offset)
      if (written.bytesWritten <= 0) throw new Error('guarded file write made no progress')
      offset += written.bytesWritten
    }
    await handle.sync()
    const info = await handle.stat({ bigint: true })
    if (!info.isFile()) throw new Error('guarded temporary target is not a regular file')
    if (options.signal?.aborted) throw new Error('操作已中断')
    await options.beforeGuardedCommit?.()
    await verifyGuardedParentPath(guardedParent)
    await verifyAbsentFilePrecondition(options.targetPath)
    try {
      options.assertWriteAuthorized?.()
      await link(tempPath, options.targetPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('guarded target appeared before write')
      }
      throw error
    }
    await verifyGuardedParentPath(guardedParent)
    await verifyFileWritePostcondition(
      options.targetPath,
      fileIdentity(info),
      options.content,
      () => options.beforeGuardedPathVerificationRead?.('postcondition', options.targetPath)
    )
  } finally {
    await handle.close().catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
}

async function verifyAbsentFilePrecondition(targetPath: string): Promise<void> {
  const existing = await lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) throw new Error('guarded target appeared before write')
}

async function captureGuardedParentPath(
  cwd: string,
  targetPath: string,
  approvedRoot?: { rootPath: string; rootIdentity: { device: string; inode: string } },
  assertWriteAuthorized?: () => void
): Promise<GuardedParentPath> {
  const initial = await resolveWritableProjectPath(cwd, targetPath)
  if (approvedRoot) await verifyApprovedRoot(initial.root, approvedRoot)
  assertWriteAuthorized?.()
  await mkdir(dirname(targetPath), { recursive: true })
  const resolved = await resolveWritableProjectPath(cwd, targetPath)
  if (approvedRoot) await verifyApprovedRoot(resolved.root, approvedRoot)
  const parentPath = dirname(resolved.fullPath)
  const [rootInfo, parentInfo] = await Promise.all([
    lstat(resolved.root, { bigint: true }),
    lstat(parentPath, { bigint: true })
  ])
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('guarded project root is not a stable directory')
  }
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error('guarded target parent is not a stable directory')
  }
  return {
    rootPath: resolved.root,
    rootIdentity: fileIdentity(rootInfo),
    parentPath,
    parentIdentity: fileIdentity(parentInfo),
    targetPath: resolved.fullPath
  }
}

async function verifyApprovedRoot(
  observedRootPath: string,
  expected: { rootPath: string; rootIdentity: { device: string; inode: string } }
): Promise<void> {
  if (observedRootPath !== expected.rootPath) {
    throw new Error('guarded project root path differs from the approved Effect')
  }
  const info = await lstat(observedRootPath, { bigint: true })
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    !sameFileIdentity(fileIdentity(info), expected.rootIdentity)
  ) {
    throw new Error('guarded project root identity differs from the approved Effect')
  }
}

async function verifyGuardedParentPath(expected: GuardedParentPath): Promise<void> {
  const resolved = await resolveWritableProjectPath(expected.rootPath, expected.targetPath)
  if (
    resolved.root !== expected.rootPath ||
    resolved.fullPath !== expected.targetPath ||
    dirname(resolved.fullPath) !== expected.parentPath
  ) {
    throw new Error('guarded target parent path changed before commit')
  }
  const [rootInfo, parentInfo] = await Promise.all([
    lstat(resolved.root, { bigint: true }),
    lstat(expected.parentPath, { bigint: true })
  ])
  if (
    rootInfo.isSymbolicLink() ||
    !rootInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    !parentInfo.isDirectory() ||
    !sameFileIdentity(fileIdentity(rootInfo), expected.rootIdentity) ||
    !sameFileIdentity(fileIdentity(parentInfo), expected.parentIdentity)
  ) {
    throw new Error('guarded target parent identity changed before commit')
  }
}

function fileIdentity(info: { dev: number | bigint; ino: number | bigint }): { device: string; inode: string } {
  return { device: String(info.dev), inode: String(info.ino) }
}

function sameFileIdentity(
  left: { device: string; inode: string },
  right: { device: string; inode: string }
): boolean {
  return left.device === right.device && left.inode === right.inode
}

function safeOpenFlags(baseFlags: number): number {
  let flags = baseFlags
  if (process.platform !== 'win32' && typeof constants.O_NOFOLLOW === 'number') flags |= constants.O_NOFOLLOW
  if (process.platform !== 'win32' && typeof constants.O_NONBLOCK === 'number') flags |= constants.O_NONBLOCK
  return flags
}

function isAbsentFilePrecondition(
  expected: LocalFileWritePrecondition
): expected is Extract<LocalFileWritePrecondition, { state: 'absent' }> {
  return expected.state === 'absent'
}

async function runHostCommand(
  options: LocalCommandOptions & { command: string }
): Promise<LocalCommandExecutionResult> {
  const isWindows = process.platform === 'win32'
  const shell = isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
  const args = isWindows ? ['/d', '/s', '/c', `"${options.command}"`] : ['-c', options.command]
  const result = await execFilePromise(shell, args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    maxBufferBytes: options.maxBufferBytes,
    env: mergeProcessEnv(buildChinaMirrorEnv(options)),
    signal: options.signal,
    windowsVerbatimArguments: isWindows
  })
  return formatResult(result, options.mode, false)
}

function formatResult(
  result: ExecFileResult,
  modeUsed: SandboxMode,
  sandboxed: boolean
): LocalCommandExecutionResult {
  const output = [
    result.stdout,
    result.stderr ? `[stderr]\n${result.stderr}` : '',
    result.errorMessage && result.exitCode !== 0 ? `[exit ${result.exitCode}] ${result.errorMessage}` : ''
  ]
    .filter(Boolean)
    .join('\n')
    .trim()
  return {
    ok: result.ok,
    output: output || '(无输出)',
    exitCode: result.exitCode,
    commandTermination: result.commandTermination,
    modeUsed,
    sandboxed
  }
}

export function buildChinaMirrorEnv(options: {
  chinaMirrorEnabled?: boolean
  npmRegistry?: string
  pipIndexUrl?: string
}): Record<string, string> {
  if (options.chinaMirrorEnabled !== true) return {}
  const env: Record<string, string> = {}
  const npmRegistry = options.npmRegistry?.trim()
  const pipIndexUrl = options.pipIndexUrl?.trim()
  if (npmRegistry) env.NPM_CONFIG_REGISTRY = npmRegistry
  if (pipIndexUrl) env.PIP_INDEX_URL = pipIndexUrl
  return env
}

function mergeProcessEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  return buildMinimalSubprocessEnv(env)
}

function execFilePromise(
  file: string,
  args: string[],
  options: {
    cwd: string
    timeoutMs: number
    maxBufferBytes: number
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
    windowsVerbatimArguments?: boolean
  }
): Promise<ExecFileResult> {
  return new Promise((resolvePromise) => {
    if (options.signal?.aborted) {
      resolvePromise({
        ok: false,
        stdout: '',
        stderr: '',
        exitCode: 1,
        commandTermination: 'aborted',
        errorMessage: '操作已中断'
      })
      return
    }
    let forcedTermination: 'timed_out' | 'aborted' | 'output_limit' | undefined
    let settled = false
    let outputBytes = 0
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let child: ChildProcess | undefined
    let forceKillTimer: NodeJS.Timeout | undefined
    let timeout: NodeJS.Timeout | undefined
    let terminationRequested = false
    const finish = (result: ExecFileResult): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      options.signal?.removeEventListener('abort', abort)
      resolvePromise(result)
    }
    const terminate = (): void => {
      if (!child || terminationRequested) return
      terminationRequested = true
      forceKillTimer = terminateProcessTree(child)
    }
    const requestTermination = (reason: NonNullable<typeof forcedTermination>): void => {
      if (forcedTermination) return
      forcedTermination = reason
      terminate()
    }
    const abort = (): void => {
      requestTermination('aborted')
    }
    const collect = (chunks: Buffer[], value: Buffer | string): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      const remaining = Math.max(0, options.maxBufferBytes - outputBytes)
      if (remaining > 0) {
        const kept = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining)
        chunks.push(kept)
        outputBytes += kept.byteLength
      }
      if (chunk.byteLength > remaining) requestTermination('output_limit')
    }
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: options.windowsVerbatimArguments
      })
    } catch (error) {
      finish({
        ok: false,
        stdout: '',
        stderr: '',
        exitCode: 1,
        commandTermination: 'spawn_error',
        errorMessage: error instanceof Error ? error.message : String(error)
      })
      return
    }
    child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.once('error', (error) => {
      finish({
        ok: false,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        exitCode: 1,
        commandTermination: 'spawn_error',
        errorMessage: error.message
      })
    })
    child.once('close', (code) => {
      const errorMessage = forcedTermination === 'aborted'
        ? '操作已中断'
        : forcedTermination === 'timed_out'
          ? `操作超时(${options.timeoutMs}ms)`
          : forcedTermination === 'output_limit'
            ? `输出超过限制(${options.maxBufferBytes} bytes)`
            : code === 0
              ? undefined
              : `进程退出码 ${code ?? 1}`
      finish({
        ok: code === 0 && forcedTermination === undefined,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        exitCode: typeof code === 'number' ? code : 1,
        commandTermination: forcedTermination ?? 'exited',
        errorMessage
      })
    })
    timeout = setTimeout(() => {
      requestTermination('timed_out')
    }, options.timeoutMs)
    timeout.unref()
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
  })
}

function abortedResult(modeUsed: SandboxMode): LocalCommandExecutionResult {
  return {
    ok: false,
    output: '操作已中断',
    exitCode: 1,
    commandTermination: 'aborted',
    modeUsed,
    sandboxed: false
  }
}

function localExecutionDisabledResult(): LocalCommandExecutionResult {
  const message =
    '本地执行已禁用:旧严格 Docker 设置已下线,且不会自动降级为宿主机执行。请在设置 > 权限中确认启用宿主机本地执行。'
  return {
    ok: false,
    output: message,
    exitCode: 1,
    commandTermination: 'not_started',
    modeUsed: 'disabled',
    sandboxed: false,
    fallbackReason: message
  }
}

function terminateProcessTree(child: ChildProcess): NodeJS.Timeout | undefined {
  const pid = child.pid
  if (!pid) return undefined
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/t', '/f'], {
      env: buildMinimalSubprocessEnv()
    }, () => undefined)
    return undefined
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  const forceKill = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }, 500)
  forceKill.unref()
  return forceKill
}

function exitCodeFromError(err: Error | null): number {
  if (!err) return 0
  const withCode = err as NodeJS.ErrnoException & { code?: unknown }
  return typeof withCode.code === 'number' ? withCode.code : 1
}
