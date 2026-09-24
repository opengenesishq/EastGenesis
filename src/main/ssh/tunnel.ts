import { createServer, connect } from 'node:net'
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RemoteSshBinding, RemoteSshTunnelView, SshHost } from '../../shared/ssh-types'
import { sshKnownHosts } from './host-policy'
import { digest } from '../project-workspace/codec'

export interface TunnelProcess { write(data: string): void; close(): void }
export interface TunnelLauncher {
  start(input: { cwd: string; args: string[]; ownerId: number; onOutput(data: string): void; onExit(message: string): void }): Promise<TunnelProcess>
}
export interface RemoteHostDialTarget { tunnelId: string; origin: string; port: number; assertCurrent(): void }
interface TunnelState extends RemoteSshTunnelView { ownerId: number; localPort: number; knownHostsFile: string; process?: TunnelProcess; createdAt: number }
export function normalizeTunnelOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.search || url.hash) throw new Error('隧道仅连接明确的 HTTPS 服务 origin。')
  return url.origin
}
export function sshTunnelArguments(host: SshHost, knownHostsFile: string, localPort: number, remotePort: number): string[] {
  for (const port of [localPort, remotePort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 隧道端口无效。')
  return ['-F', '/dev/null', '-N', '-T', '-p', String(host.port), '-l', host.username,
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    '-o', `UserKnownHostsFile="${knownHostsFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'VerifyHostKeyDNS=no',
    '-o', 'HostKeyAlgorithms=ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512,rsa-sha2-256',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'GatewayPorts=no',
    '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3', '-o', 'EscapeChar=none',
    ...(host.identityFile ? ['-i', host.identityFile] : ['-o', 'PubkeyAuthentication=no']), host.hostname]
}
async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (!port) throw new Error('无法为 SSH 隧道分配本机端口。')
  return port
}
function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    let finished = false
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (result: boolean) => { if (!finished) { finished = true; socket.destroy(); resolve(result) } }
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(300, () => finish(false))
  })
}
export class RemoteSshTunnelManager {
  private readonly tunnels = new Map<string, TunnelState>()
  private readonly timer: ReturnType<typeof setInterval>
  private disposed = false
  private pending = 0
  constructor(private readonly root: string, private readonly getHost: (id: string, revision: number) => SshHost, private readonly launcher: TunnelLauncher) {
    this.timer = setInterval(() => { for (const state of this.tunnels.values()) void this.refresh(state) }, 750); this.timer.unref()
  }
  async start(sshHostId: string, sshHostRevision: number, httpsOrigin: string, ownerId: number): Promise<RemoteSshTunnelView> {
    if (this.pending + [...this.tunnels.values()].filter(item => ['connecting', 'ready'].includes(item.state)).length >= 8) throw new Error('SSH 隧道并发连接已达上限。')
    this.pending++
    try { return await this.startUnchecked(sshHostId, sshHostRevision, httpsOrigin, ownerId) } finally { this.pending-- }
  }
  private async startUnchecked(sshHostId: string, sshHostRevision: number, httpsOrigin: string, ownerId: number): Promise<RemoteSshTunnelView> {
    if (this.disposed) throw new Error('SSH 隧道服务已停止。')
    if (!Number.isSafeInteger(ownerId) || ownerId < 0) throw new Error('SSH 隧道缺少窗口身份。')
    const origin = normalizeTunnelOrigin(httpsOrigin), host = this.getHost(sshHostId, sshHostRevision)
    const binding: RemoteSshBinding = { sshHostId, sshHostRevision, sshConfigDigest: digest(host), httpsOrigin: origin }
    const existing = [...this.tunnels.values()].find(item => item.ownerId === ownerId && digest(item.binding) === digest(binding) && ['connecting', 'ready'].includes(item.state))
    if (existing) return this.view(existing)
    if ([...this.tunnels.values()].filter(item => ['connecting', 'ready'].includes(item.state)).length >= 8) throw new Error('最多同时建立 8 个 SSH 隧道。')
    if (this.tunnels.size >= 32) for (const [id, item] of this.tunnels) if (['closed', 'failed'].includes(item.state)) this.tunnels.delete(id)
    const id = randomUUID(), localPort = await availablePort(), remotePort = Number(new URL(origin).port || 443)
    if (this.disposed) throw new Error('SSH 隧道服务已停止。')
    if (digest(this.getHost(sshHostId, sshHostRevision)) !== binding.sshConfigDigest) throw new Error('SSH 配置已变化。')
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const knownHostsFile = join(this.root, `${id}.known_hosts`)
    writeFileSync(knownHostsFile, sshKnownHosts(host, host.trustedKeys), { mode: 0o600 })
    const state: TunnelState = { id, binding, ownerId, localPort, remotePort, hostLabel: `${host.name} · ${host.username}@${host.hostname}:${host.port}`,
      state: 'connecting', output: '', knownHostsFile, createdAt: Date.now() }
    this.tunnels.set(id, state)
    try {
      state.process = await this.launcher.start({ cwd: this.root, args: sshTunnelArguments(host, knownHostsFile, localPort, remotePort), ownerId,
        onOutput: data => { state.output = (state.output + data).slice(-8192) },
        onExit: message => this.stop(state, 'failed', message) })
      if (!['connecting', 'ready'].includes(state.state) || this.disposed) { state.process.close(); throw new Error(state.error || '隧道已停止。') }
      await this.refresh(state)
    } catch (error) { this.stop(state, 'failed', error instanceof Error ? error.message : String(error)) }
    return this.view(state)
  }
  list(ownerId?: number): RemoteSshTunnelView[] {
    for (const state of this.tunnels.values()) if (state.state === 'ready' || state.state === 'connecting') this.validate(state)
    return [...this.tunnels.values()].filter(state => ownerId === undefined || state.ownerId === ownerId).map(state => this.view(state)).slice(-24)
  }
  write(id: string, value: string, ownerId: number): void {
    const state = this.owned(id, ownerId); this.validate(state)
    if (state.state !== 'connecting' || !state.process || typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error('只允许在 SSH 连接提示中输入单行认证信息。')
    const prompt = state.output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trimEnd()
    if (!/(?:password|passphrase[^\r\n]*|verification code|one.time code)[:：]\s*$/i.test(prompt)) throw new Error('请等待此 SSH 进程的密码或私钥口令提示。')
    state.output = ''
    state.process.write(`${value}\r`)
  }
  close(id: string, ownerId: number): void { this.stop(this.owned(id, ownerId), 'closed', 'SSH 隧道已断开。') }
  closeAll(message = 'SSH 隧道已停止。', ownerId?: number): void {
    for (const state of this.tunnels.values()) if (ownerId === undefined || state.ownerId === ownerId) this.stop(state, 'closed', message)
  }
  dispose(): void { this.disposed = true; clearInterval(this.timer); this.closeAll() }
  binding(id: string, ownerId: number): RemoteSshBinding { const state = this.owned(id, ownerId); this.assertReady(state); return { ...state.binding } }
  resolve(binding: RemoteSshBinding): RemoteHostDialTarget {
    const state = [...this.tunnels.values()].find(item => digest(item.binding) === digest(binding) && item.state === 'ready')
    if (!state) throw new Error('此远端连接需要原 SSH 隧道，请先重新连接；不会改用直连。')
    this.assertReady(state)
    return { tunnelId: state.id, origin: binding.httpsOrigin, port: state.localPort, assertCurrent: () => this.assertReady(state) }
  }
  private owned(id: string, ownerId: number): TunnelState {
    const state = this.tunnels.get(id)
    if (!state || state.ownerId !== ownerId) throw new Error('SSH 隧道不属于此窗口。')
    return state
  }
  private validate(state: TunnelState): void {
    if (!['connecting', 'ready'].includes(state.state)) return
    try { if (digest(this.getHost(state.binding.sshHostId, state.binding.sshHostRevision)) !== state.binding.sshConfigDigest) throw new Error('SSH 主机配置或公钥已变化。') }
    catch (error) { this.stop(state, 'failed', error instanceof Error ? error.message : String(error)) }
  }
  private assertReady(state: TunnelState): void { this.validate(state); if (this.disposed || state.state !== 'ready' || !state.process) throw new Error(state.error || 'SSH 隧道尚未连接或已经断开。') }
  private async refresh(state: TunnelState): Promise<void> {
    this.validate(state)
    if (state.state !== 'connecting') return
    if (Date.now() - state.createdAt > 180_000) { this.stop(state, 'failed', 'SSH 认证等待超时，请重新连接。'); return }
    if (state.process && await listening(state.localPort) && state.state === 'connecting') { this.validate(state); if (state.state === 'connecting') state.state = 'ready' }
  }
  private stop(state: TunnelState, phase: 'closed' | 'failed', error: string): void {
    if (!['connecting', 'ready'].includes(state.state)) return
    state.state = phase; state.error = error.slice(0, 500)
    state.process?.close()
    try { unlinkSync(state.knownHostsFile) } catch { /* Only this tunnel's public-key file is removed. */ }
  }
  private view(state: TunnelState): RemoteSshTunnelView { return { id: state.id, binding: { ...state.binding }, hostLabel: state.hostLabel, remotePort: state.remotePort, state: state.state, output: state.output, error: state.error } }
}
