import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LocalDevServerConfig } from '../../shared/local-dev-server-types'
import { isSensitiveSubprocessEnvironmentName } from '../security/subprocess-environment'

// Environment propagation is intentionally broader than credential detection:
// CAOGEN_USER_DATA_DIR and other application paths must not become fake secrets.
const credentialName = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SECRET|TOKEN|AUTH|AUTHORIZATION|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)/i
const secretValues = (): string[] => Object.entries(process.env).filter(([key, value]) => isSensitiveSubprocessEnvironmentName(key) && credentialName.test(key) && value && value.length >= 6).map(([, value]) => value!).sort((a, b) => b.length - a.length)
export function redactDevServerText(text: string): string {
  let result = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  for (const secret of secretValues()) result = result.split(secret).join('[redacted]')
  return result.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AIza[A-Za-z0-9_-]{20,})/g, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret|token)\s*[=:]\s*)(?:Bearer\s+)?["']?[^\s,"';]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
}
export function validateDevServerUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.length > 2048 || !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/|$)/i.test(raw)) throw new Error('服务地址必须是 localhost、127.0.0.1 或 [::1] 的 HTTP(S) 地址。')
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('服务地址不能包含凭据、查询参数或片段。')
  return url.toString()
}
export function normalizeDevServerConfig(input: LocalDevServerConfig, taskCwd: string): LocalDevServerConfig {
  if (!input || typeof input.command !== 'string' || !input.command.trim() || input.command.length > 4096 || /[\x00-\x1f\x7f]/.test(input.command)) throw new Error('请输入一行完整启动命令（最多 4096 字符）。')
  if (redactDevServerText(input.command) !== input.command) throw new Error('启动命令不能包含密钥或登录凭据；请使用项目已有的安全配置。')
  if (typeof input.cwd !== 'string' || input.cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(input.cwd)) throw new Error('工作目录无效。')
  const cwd = realpathSync(resolve(taskCwd, input.cwd || '.')), root = realpathSync(taskCwd)
  if (cwd !== root || !statSync(cwd).isDirectory()) throw new Error('本次工作目录必须是当前任务的真实根目录；子目录项目请在任务中选择该目录。')
  return { command: input.command, cwd, url: validateDevServerUrl(input.url) }
}
/** No redirects, cookies, ambient proxy or DNS resolution. Any HTTP response proves only reachability. */
export function probeDevServer(raw: string): Promise<boolean> {
  const url = new URL(validateDevServerUrl(raw))
  return new Promise(resolveProbe => {
    let done = false
    const finish = (reachable: boolean): void => { if (!done) { done = true; clearTimeout(timer); resolveProbe(reachable) } }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)({ protocol: url.protocol, hostname: url.hostname === '[::1]' ? '::1' : '127.0.0.1', port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname, method: 'HEAD', agent: false, headers: { Host: url.host } }, response => { response.destroy(); finish(true) })
    const timer = setTimeout(() => { request.destroy(); finish(false) }, 1000)
    timer.unref(); request.on('error', () => finish(false)); request.end()
  })
}
