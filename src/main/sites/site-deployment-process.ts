import { spawn, type ChildProcess } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { lstat, realpath, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { buildAuthorizedSubprocessEnv } from '../security/subprocess-environment'
import { containsSensitiveText, redactSensitiveText } from '../security/secret-redaction'
import type { SiteDeploymentTarget } from '../../shared/site-deployment-types'

const OUTPUT_LIMIT = 256 * 1024
export interface SiteProcessResult { started: boolean; exitCode: number | null; signal: string | null; stdout: string; stderr: string; outputTruncated: boolean; error?: string }
export interface SiteProcessHandle { cancel(): void; done: Promise<SiteProcessResult> }
export function validateSiteTarget(input: SiteDeploymentTarget): SiteDeploymentTarget {
  const text = (value: unknown, label: string, max = 1024): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${label} 无效`)
    return value.trim()
  }
  const args = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value) || value.length > 100 || value.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0') || containsSensitiveText(arg))) throw new Error(`${label} 无效；请用 CLI 登录状态或环境变量提供凭据，不要写入参数`)
    return value.slice()
  }
  const executable = text(input.executable, '可执行文件')
  if (!isAbsolute(executable)) throw new Error('部署程序必须使用绝对路径')
  const outputDirectory = text(input.outputDirectory, '发布目录')
  if (isAbsolute(outputDirectory) || outputDirectory.split(/[\\/]/).some(part => part === '..')) throw new Error('发布目录必须位于当前任务目录内')
  const environmentKeys = args(input.environmentKeys, '环境变量名')
  if (environmentKeys.some(key => !/^[A-Z][A-Z0-9_]{0,100}$/.test(key) || /^(?:CAOGEN_|NODE_|DYLD_|LD_|PYTHON|BASH_ENV$|ENV$|ZDOTDIR$)/.test(key))) throw new Error('环境变量名不允许注入运行时配置')
  const timeoutSeconds = Number(input.timeoutSeconds)
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 1800) throw new Error('超时必须为 5 到 1800 秒')
  if (input.estimatedCostUsd !== undefined && (!Number.isFinite(input.estimatedCostUsd) || input.estimatedCostUsd < 0)) throw new Error('费用估算无效')
  const management = input.management
  if (management && (management.protocol !== 'caogen-site-management/1' || !management.siteId || containsSensitiveText(management.siteId))) throw new Error('托管管理配置无效；请填写稳定站点 ID。')
  return { id: typeof input.id === 'string' ? input.id : '', revision: Number.isSafeInteger(input.revision) ? input.revision : 0,
    name: text(input.name, '目标名称', 120), outputDirectory, executable,
    deployArgs: args(input.deployArgs, '发布参数'), rollbackArgs: args(input.rollbackArgs, '回滚参数'), inspectArgs: args(input.inspectArgs, '核对参数'),
    environmentKeys: [...new Set(environmentKeys)], estimatedCostUsd: input.estimatedCostUsd, timeoutSeconds,
    ...(management ? { management: { protocol: 'caogen-site-management/1' as const, args: args(management.args, '管理适配器参数'), siteId: text(management.siteId, '站点 ID', 512) } } : {}) }
}
export async function siteExecutableDigest(path: string): Promise<string> {
  const actual = await realpath(path)
  const info = await lstat(actual)
  if (!info.isFile() || info.size > 256 * 1024 * 1024 || (process.platform !== 'win32' && !(info.mode & 0o111))) throw new Error('部署程序不可执行或过大')
  return createHash('sha256').update(actual).update('\0').update(await readFile(actual)).digest('hex')
}
export function siteCommandArgs(args: string[], values: { directory: string; deploymentId?: string; url?: string; operationId: string }): string[] {
  return args.map(arg => arg.replace(/\{\{(directory|deploymentId|url|operationId)\}\}/g, (_, name: keyof typeof values) => {
    const value = values[name]
    if (!value) throw new Error(`部署参数缺少 ${name}；请先核对原部署回执`)
    return value
  }))
}
export function runSiteProcess(executable: string, args: string[], cwd: string, target: SiteDeploymentTarget, stdin?: string): SiteProcessHandle {
  if (stdin !== undefined && Buffer.byteLength(stdin) > 65536) throw new Error('适配器请求超过 64 KiB。')
  const overrides: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1' }
  const secrets: string[] = []
  for (const key of target.environmentKeys) {
    const value = process.env[key]
    if (value === undefined) throw new Error(`环境变量 ${key} 不在应用进程中；请先配置后重试`)
    overrides[key] = value; if (value.length) secrets.push(value)
  }
  const safe = (text: string): string => redactSensitiveText(secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), text))
  let child: ChildProcess | undefined
  let stopped = false
  let settled = false
  let reason: string | undefined
  const terminate = (): void => {
    if (!child?.pid || settled) return
    try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM') } catch { /* already exited */ }
    const timer = setTimeout(() => {
      if (settled || !child?.pid) return
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { /* already exited */ }
    }, 1500); timer.unref()
  }
  const done = new Promise<SiteProcessResult>(resolve => {
    let stdout = '', stderr = '', total = 0, truncated = false, started = false
    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return
      settled = true; clearTimeout(timeout)
      resolve({ started, exitCode, signal, stdout: safe(stdout), stderr: safe(stderr), outputTruncated: truncated, error: reason && safe(reason) })
    }
    const capture = (chunk: Buffer, channel: 'stdout' | 'stderr'): void => {
      const remaining = Math.max(0, OUTPUT_LIMIT - total)
      const value = chunk.subarray(0, remaining).toString('utf8'); total += chunk.length
      if (channel === 'stdout') stdout += value; else stderr += value
      if (total > OUTPUT_LIMIT) { truncated = true; reason = '部署程序输出超出限制；实际服务状态需要核对'; terminate() }
    }
    const timeout = setTimeout(() => { reason = '部署程序超时；实际服务状态需要核对'; stopped = true; terminate() }, target.timeoutSeconds * 1000)
    try {
      child = spawn(executable, args, { cwd, shell: false, detached: process.platform !== 'win32', windowsHide: true,
        env: buildAuthorizedSubprocessEnv(overrides), stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
      if (stdin !== undefined) { child.stdin?.on('error', () => { /* process result reports early exit */ }); child.stdin?.end(stdin) }
      child.once('spawn', () => { started = true; if (stopped) terminate() })
      child.stdout?.on('data', chunk => capture(chunk, 'stdout')); child.stderr?.on('data', chunk => capture(chunk, 'stderr'))
      child.once('error', error => { reason = error.message; finish(null, null) })
      child.once('close', (code, signal) => finish(code, signal))
    } catch (error) { reason = error instanceof Error ? error.message : String(error); finish(null, null) }
  })
  return { done, cancel: () => { stopped = true; reason = '已请求停止部署程序；实际服务状态需要核对'; terminate() } }
}
export function parseSiteAdapterReceipt(stdout: string): { deploymentId: string; url: string; operationId?: string } | undefined {
  const rows = stdout.split(/\r?\n/).filter(line => line.startsWith('CAOGEN_SITE_RECEIPT '))
  if (rows.length !== 1) return undefined
  try {
    const value = JSON.parse(rows[0].slice('CAOGEN_SITE_RECEIPT '.length))
    if (typeof value.deploymentId !== 'string' || !value.deploymentId.trim() || value.deploymentId.length > 512 || /[\x00-\x1f]/.test(value.deploymentId)) return undefined
    const url = new URL(value.url)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || containsSensitiveText(url.href)) return undefined
    return { deploymentId: value.deploymentId, url: url.href, operationId: typeof value.operationId === 'string' ? value.operationId : undefined }
  } catch { return undefined }
}
