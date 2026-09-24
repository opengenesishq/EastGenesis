import type { TerminalEvent, TerminalInfo } from './terminal-operation-types'

export interface SshHostInput {
  name: string
  hostname: string
  username: string
  port: number
  identityFile?: string
  remoteDirectory: string
}
export interface SshHostKey { type: string; key: string; fingerprint: string }
export interface SshHost extends SshHostInput {
  id: string
  revision: number
  trustedKeys: SshHostKey[]
  trustedAt?: number
}
export interface SshKeyPreview {
  token: string
  hostId: string
  revision: number
  keys: SshHostKey[]
  expiresAt: number
}
export interface SshTerminalState {
  terminal: TerminalInfo
  hostId: string
  hostLabel: string
  buffer: string
}
export interface RemoteSshBinding {
  sshHostId: string
  sshHostRevision: number
  sshConfigDigest: string
  httpsOrigin: string
}
export interface RemoteSshTunnelView {
  id: string
  binding: RemoteSshBinding
  hostLabel: string
  remotePort: number
  state: 'connecting' | 'ready' | 'closed' | 'failed'
  output: string
  error?: string
}
export interface SshApi {
  listSshHosts(): Promise<{ supported: boolean; hosts: SshHost[]; reason?: string }>
  saveSshHost(input: SshHostInput, id?: string, revision?: number): Promise<SshHost>
  deleteSshHost(id: string, revision: number): Promise<void>
  pickSshIdentity(): Promise<string | undefined>
  scanSshHostKey(id: string, revision: number): Promise<SshKeyPreview>
  trustSshHostKey(token: string): Promise<SshHost>
  connectSshHost(id: string, revision: number): Promise<SshTerminalState>
  readSshTerminal(id: string): Promise<SshTerminalState>
  writeSshTerminal(id: string, data: string): Promise<void>
  resizeSshTerminal(id: string, cols: number, rows: number): Promise<void>
  closeSshTerminal(id: string): Promise<void>
  onSshTerminalEvent(callback: (event: TerminalEvent) => void): () => void
}
