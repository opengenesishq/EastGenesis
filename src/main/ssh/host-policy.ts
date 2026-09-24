import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import type { SshHostInput, SshHostKey } from '../../shared/ssh-types'

export function normalizeSshHost(raw: SshHostInput): SshHostInput {
  if (!raw || typeof raw !== 'object') throw new Error('SSH 主机配置无效。')
  const text = (value: unknown, max = 512): string => {
    if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error('SSH 配置包含无效文本。')
    return value.trim()
  }
  const name = text(raw.name, 100)
  const hostname = text(raw.hostname, 253).toLowerCase()
  const username = text(raw.username, 100)
  const remoteDirectory = text(raw.remoteDirectory, 2048) || '/'
  const identityFile = raw.identityFile ? text(raw.identityFile, 2048) : undefined
  if (!name || (!isIP(hostname) && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(hostname))) throw new Error('填写有效的主机名或 IP 地址。')
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$/.test(username)) throw new Error('SSH 用户名无效。')
  if (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) throw new Error('端口须为 1–65535。')
  if (!remoteDirectory.startsWith('/')) throw new Error('远端工作目录必须是绝对路径。')
  return { name, hostname, username, port: raw.port, remoteDirectory, identityFile }
}
export function parseSshHostKeys(output: string): SshHostKey[] {
  const found = new Map<string, SshHostKey>()
  for (const line of output.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    const parts = line.trim().split(/\s+/)
    const [type, key] = parts.slice(1)
    if (parts.length !== 3 || !['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'].includes(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(key) || key.length > 8192) continue
    const bytes = Buffer.from(key, 'base64')
    if (bytes.length < 24 || bytes.length > 8192) continue
    const nameLength = bytes.readUInt32BE(0)
    if (nameLength > 64 || bytes.subarray(4, 4 + nameLength).toString() !== type) continue
    const fingerprint = `SHA256:${createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '')}`
    found.set(fingerprint, { type, key, fingerprint })
  }
  if (!found.size) throw new Error('未取得可识别的主机公钥，请检查地址、端口及网络。')
  return [...found.values()].slice(0, 12)
}
export function sshKnownHosts(host: SshHostInput, keys: SshHostKey[]): string {
  const address = host.port === 22 ? host.hostname : `[${host.hostname}]:${host.port}`
  return keys.map(key => `${address} ${key.type} ${key.key}\n`).join('')
}
const quote = (text: string): string => `'${text.replace(/'/g, `'"'"'`)}'`
export function sshArguments(host: SshHostInput, knownHostsFile: string): string[] {
  const normalized = normalizeSshHost(host)
  const remoteScript = `cd ${quote(normalized.remoteDirectory)} && exec "\${SHELL:-/bin/sh}" -l`
  return ['-F', '/dev/null', '-tt', '-p', String(normalized.port), '-l', normalized.username,
    '-o', `UserKnownHostsFile="${knownHostsFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'VerifyHostKeyDNS=no',
    '-o', 'HostKeyAlgorithms=ssh-ed25519,ecdsa-sha2-nistp256,rsa-sha2-512,rsa-sha2-256',
    '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'IdentityAgent=none',
    '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
    ...(normalized.identityFile ? ['-i', normalized.identityFile] : ['-o', 'PubkeyAuthentication=no']),
    normalized.hostname, `/bin/sh -c ${quote(remoteScript)}`]
}
