import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { execFile, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { SshHost, SshHostInput, SshKeyPreview, SshTerminalState } from '../../shared/ssh-types'
import { TerminalManager } from '../terminal'
import { desktopWindowRole } from '../desktop-window-registry'
import { assertTrustedWorkflowLedgerSender } from '../ipc/workflow-ledger-handlers'
import { buildMinimalSubprocessEnv } from '../security/subprocess-environment'
import { temporaryTaskRuntime } from '../app-runtime-paths'
import { normalizeSshHost, parseSshHostKeys, sshArguments, sshKnownHosts } from './host-policy'

const manager = new TerminalManager()
const terminals = new Map<string, SshTerminalState & { ownerId: number; revision: number }>()
const previews = new Map<string, SshKeyPreview & { ownerId: number }>()
const owners = new Map<number, { sender: WebContents; generation: number; keyFiles: Set<string>; scans: Set<ChildProcess>; busy: boolean }>()
const root = (): string => join(app.getPath('userData'), 'ssh-hosts')
const supported = (): boolean => !temporaryTaskRuntime && ['darwin', 'linux'].includes(process.platform) && existsSync('/usr/bin/ssh') && existsSync('/usr/bin/ssh-keyscan')
function assertSupported(): void { if (!supported()) throw new Error('SSH 终端需要普通工作空间和系统 OpenSSH（当前支持 macOS/Linux）。') }
function readHosts(): SshHost[] {
  const file = join(root(), 'hosts.json')
  if (!existsSync(file)) return []
  const raw = JSON.parse(readFileSync(file, 'utf8')) as SshHost[]
  if (!Array.isArray(raw) || raw.length > 100) throw new Error('SSH 主机配置损坏。')
  return raw.map(host => {
    if (!/^[a-z0-9-]{36}$/.test(host.id) || !Number.isSafeInteger(host.revision)) throw new Error('SSH 主机记录无效。')
    const input = normalizeSshHost(host)
    const keys = host.trustedKeys?.length ? parseSshHostKeys(sshKnownHosts(input, host.trustedKeys)) : []
    return { ...input, id: host.id, revision: host.revision, trustedKeys: keys, trustedAt: host.trustedAt }
  })
}
function persist(hosts: SshHost[]): void {
  mkdirSync(root(), { recursive: true, mode: 0o700 })
  const pending = join(root(), `hosts-${randomUUID()}.tmp`)
  writeFileSync(pending, JSON.stringify(hosts, null, 2), { mode: 0o600 })
  renameSync(pending, join(root(), 'hosts.json'))
}
function getHost(id: string, revision?: number): SshHost {
  const host = readHosts().find(item => item.id === id)
  if (!host || (revision !== undefined && host.revision !== revision)) throw new Error('主机配置已变化或已删除，请刷新后重试。')
  return host
}
/** Main-process only: a tunnel may use exactly an already-reviewed host revision. */
export function getTrustedSshHostForTunnel(id: string, revision: number): SshHost {
  assertSupported()
  const host = getHost(id, revision)
  if (!host.trustedKeys.length) throw new Error('请先在 SSH 设置核对并信任主机公钥。')
  if (host.identityFile && (!existsSync(host.identityFile) || !statSync(host.identityFile).isFile())) throw new Error('SSH 私钥路径已失效，请在 SSH 设置重新选择。')
  return host
}
function stopHost(id: string): void {
  for (const state of terminals.values()) if (state.hostId === id && !state.terminal.exit) manager.close(state.terminal.id)
  for (const [token, preview] of previews) if (preview.hostId === id) previews.delete(token)
}
function owner(event: IpcMainInvokeEvent): { state: NonNullable<ReturnType<typeof owners.get>>; generation: number; active: () => boolean } {
  assertTrustedWorkflowLedgerSender(event)
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || desktopWindowRole(win) !== 'main') throw new Error('请在主工作台管理 SSH。')
  assertSupported()
  const sender = event.sender
  let state = owners.get(sender.id)
  if (!state) {
    state = { sender, generation: 0, keyFiles: new Set(), scans: new Set(), busy: false }
    owners.set(sender.id, state)
    const dispose = (): void => {
      const current = owners.get(sender.id)
      if (!current) return
      current.generation++
      current.keyFiles.clear()
      for (const scan of current.scans) scan.kill()
      current.scans.clear()
      for (const [token, preview] of previews) if (preview.ownerId === sender.id) previews.delete(token)
      for (const [id, terminal] of terminals) if (terminal.ownerId === sender.id) { manager.close(id); terminals.delete(id) }
    }
    sender.once('destroyed', () => { dispose(); owners.delete(sender.id) })
    sender.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) dispose() })
  }
  const generation = state.generation
  return { state, generation, active: () => !sender.isDestroyed() && owners.get(sender.id)?.generation === generation }
}
function bound(event: IpcMainInvokeEvent, id: string, mutate = false): SshTerminalState & { ownerId: number; revision: number } {
  owner(event)
  const state = terminals.get(id)
  if (!state || state.ownerId !== event.sender.id) throw new Error('SSH 终端不属于此窗口。')
  if (mutate) {
    getHost(state.hostId, state.revision)
    if (state.terminal.exit) throw new Error('SSH 连接已经断开。')
  }
  return state
}
function view(state: SshTerminalState): SshTerminalState {
  return { terminal: { ...state.terminal }, hostId: state.hostId, hostLabel: state.hostLabel, buffer: state.buffer }
}
export function registerSshIpc(): void {
  manager.subscribe(event => {
    if (event.kind === 'started') return
    const state = event.id ? terminals.get(event.id) : undefined
    if (!state) return
    if (event.kind === 'output') state.buffer = (state.buffer + event.data).slice(-1024 * 1024)
    if (event.kind === 'exit') state.terminal = { ...state.terminal, exit: event.exit }
    if (event.kind === 'error') state.buffer = (state.buffer + `\r\n${event.message}\r\n`).slice(-1024 * 1024)
    const sender = owners.get(state.ownerId)?.sender
    if (sender && !sender.isDestroyed()) sender.send('ssh:event', event)
  })
  app.once('before-quit', () => { manager.disposeAll(); for (const state of owners.values()) for (const scan of state.scans) scan.kill() })
  ipcMain.handle('ssh:hosts', event => {
    assertTrustedWorkflowLedgerSender(event)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || desktopWindowRole(win) !== 'main') throw new Error('请在主工作台管理 SSH。')
    return { supported: supported(), hosts: supported() ? readHosts() : [], reason: supported() ? undefined : '需要普通工作空间及系统 OpenSSH；当前支持 macOS/Linux。' }
  })
  ipcMain.handle('ssh:pick-identity', async event => {
    const { state, active } = owner(event)
    const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, { title: '选择 SSH 私钥（仅保存路径）', properties: ['openFile', 'showHiddenFiles'] })
    if (!active() || picked.canceled || !picked.filePaths[0]) return undefined
    const path = realpathSync(picked.filePaths[0])
    if (!statSync(path).isFile()) throw new Error('请选择私钥文件。')
    state.keyFiles.add(path)
    return path
  })
  ipcMain.handle('ssh:save', (event, raw: SshHostInput, id?: string, revision?: number) => {
    const { state } = owner(event)
    const hosts = readHosts()
    const previous = id ? getHost(id, revision) : undefined
    if (id && revision === undefined) throw new Error('缺少主机配置版本。')
    if (!id && hosts.length >= 100) throw new Error('最多保存 100 台 SSH 主机。')
    const input = normalizeSshHost(raw)
    if (input.identityFile && input.identityFile !== previous?.identityFile && !state.keyFiles.has(input.identityFile)) throw new Error('请通过选择文件指定 SSH 私钥。')
    const identityChanged = input.hostname !== previous?.hostname || input.port !== previous?.port
    const host: SshHost = { ...input, id: previous?.id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, trustedKeys: identityChanged ? [] : previous?.trustedKeys ?? [], trustedAt: identityChanged ? undefined : previous?.trustedAt }
    persist([...hosts.filter(item => item.id !== host.id), host])
    stopHost(host.id)
    return host
  })
  ipcMain.handle('ssh:delete', (event, id: string, revision: number) => {
    owner(event); getHost(id, revision)
    persist(readHosts().filter(host => host.id !== id)); stopHost(id)
    try { unlinkSync(join(root(), `${id}.known_hosts`)) } catch { /* no stored key file yet */ }
  })
  ipcMain.handle('ssh:scan', async (event, id: string, revision: number): Promise<SshKeyPreview> => {
    const { state, active } = owner(event)
    const host = getHost(id, revision)
    if (state.scans.size) throw new Error('正在读取主机公钥，请等待。')
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile('/usr/bin/ssh-keyscan', ['-T', '8', '-p', String(host.port), '-t', 'ed25519,ecdsa,rsa', host.hostname], { timeout: 12000, maxBuffer: 128 * 1024, env: buildMinimalSubprocessEnv() }, (error, stdout) => {
        state.scans.delete(child)
        if (error && !stdout.trim()) reject(new Error('未能取得主机公钥，请核对地址、端口及网络。'))
        else resolve(stdout)
      })
      state.scans.add(child)
    })
    if (!active()) throw new Error('窗口已变化，公钥预览已失效。')
    getHost(id, revision)
    for (const [token, preview] of previews) if (preview.expiresAt < Date.now() || preview.ownerId === event.sender.id) previews.delete(token)
    const preview: SshKeyPreview = { token: randomUUID(), hostId: id, revision, keys: parseSshHostKeys(output), expiresAt: Date.now() + 5 * 60_000 }
    previews.set(preview.token, { ...preview, ownerId: event.sender.id })
    return preview
  })
  ipcMain.handle('ssh:trust', (event, token: string) => {
    owner(event)
    const preview = previews.get(token)
    if (!preview || preview.ownerId !== event.sender.id || preview.expiresAt < Date.now()) throw new Error('公钥预览已失效，请重新读取。')
    const host = getHost(preview.hostId, preview.revision)
    const trusted = { ...host, revision: host.revision + 1, trustedKeys: preview.keys, trustedAt: Date.now() }
    persist(readHosts().map(item => item.id === host.id ? trusted : item)); stopHost(host.id)
    return trusted
  })
  ipcMain.handle('ssh:connect', async (event, id: string, revision: number) => {
    const { state, active } = owner(event)
    if (state.busy) throw new Error('正在建立 SSH 终端。')
    if ([...terminals.values()].filter(item => !item.terminal.exit).length >= 8) throw new Error('最多同时打开 8 个 SSH 终端。')
    const host = getHost(id, revision)
    if (!host.trustedKeys.length) throw new Error('先核对并信任该主机的公钥。')
    if (host.identityFile && (!existsSync(host.identityFile) || !statSync(host.identityFile).isFile())) throw new Error('私钥文件已移动或不存在，请重新选择。')
    const known = join(root(), `${host.id}.known_hosts`)
    writeFileSync(known, sshKnownHosts(host, host.trustedKeys), { mode: 0o600 })
    state.busy = true
    try {
      const terminal = await manager.start({ cwd: root(), sessionId: `ssh:${randomUUID()}`, ownerWebContentsId: event.sender.id, shell: '/usr/bin/ssh', args: sshArguments(host, known), requirePty: true, reuse: false, cols: 100, rows: 24 })
      try { if (!active()) throw new Error('窗口已变化。'); getHost(id, revision) } catch (error) { manager.close(terminal.id); throw error }
      for (const [oldId, old] of terminals) if (old.terminal.exit) terminals.delete(oldId)
      const result = { terminal, hostId: host.id, hostLabel: `${host.username}@${host.hostname}:${host.port} · ${host.remoteDirectory}`, buffer: '', ownerId: event.sender.id, revision }
      terminals.set(terminal.id, result)
      return view(result)
    } finally { state.busy = false }
  })
  ipcMain.handle('ssh:read', (event, id: string) => view(bound(event, id)))
  ipcMain.handle('ssh:write', (event, id: string, data: string) => {
    bound(event, id, true)
    if (typeof data !== 'string' || data.length > 65536) throw new Error('终端输入过大。')
    manager.write(id, data)
  })
  ipcMain.handle('ssh:resize', (event, id: string, cols: number, rows: number) => { bound(event, id, true); manager.resize(id, cols, rows) })
  ipcMain.handle('ssh:close', (event, id: string) => { bound(event, id); manager.close(id) })
}
