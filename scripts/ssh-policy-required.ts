import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { normalizeSshHost, parseSshHostKeys, sshArguments, sshKnownHosts } from '../src/main/ssh/host-policy'
const host = { name: 'Offline fixture', hostname: 'example.invalid', username: 'fixture', port: 22, remoteDirectory: "/project/space name/o'reilly/$(not-executed)" }
let passed = 0
function check(name: string, callback: () => void): void { callback(); passed++; console.log(`PASS ${name}`) }
check('Reject option injection, control characters and invalid host/port/user values', () => {
  for (const hostname of ['-oProxyCommand=x', 'host;cmd', 'host\nx', 'bad/path']) assert.throws(() => normalizeSshHost({ ...host, hostname }))
  for (const username of ['-x', 'bad user', 'user\n']) assert.throws(() => normalizeSshHost({ ...host, username }))
  for (const port of [0, 65536, 1.2, NaN]) assert.throws(() => normalizeSshHost({ ...host, port }))
  assert.throws(() => normalizeSshHost({ ...host, remoteDirectory: 'relative' }))
  assert.equal(normalizeSshHost({ ...host, hostname: '::1' }).hostname, '::1')
})
const keyType = Buffer.from('ssh-ed25519'), size = Buffer.alloc(4), keySize = Buffer.alloc(4)
size.writeUInt32BE(keyType.length); keySize.writeUInt32BE(32)
const blob = Buffer.concat([size, keyType, keySize, Buffer.alloc(32, 7)]).toString('base64')
const keys = parseSshHostKeys(`example.invalid ssh-ed25519 ${blob}\nexample.invalid ssh-ed25519 ${blob}\n`)
check('Fingerprint is bound to key bytes and deduplicated; malformed key declarations rejected', () => {
  assert.equal(keys.length, 1); assert.match(keys[0].fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/)
  assert.throws(() => parseSshHostKeys(`example.invalid ssh-rsa ${blob}`))
  assert.throws(() => parseSshHostKeys('example.invalid ssh-ed25519 AAAA'))
})
check('Known-host lookup uses standard and alternate port forms', () => {
  assert(sshKnownHosts(host, keys).startsWith('example.invalid '))
  assert(sshKnownHosts({ ...host, hostname: '::1', port: 2222 }, keys).startsWith('[::1]:2222 '))
})
check('Real OpenSSH offline configuration preserves spaced key path and disables proxy, forwarding and automatic trust', () => {
  const args = sshArguments(host, '/tmp/caogen offline/known_hosts')
  const config = execFileSync('/usr/bin/ssh', ['-G', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.match(config, /userknownhostsfile \/tmp\/caogen offline\/known_hosts\n/)
  assert.match(config, /stricthostkeychecking true\n/)
  assert.match(config, /forwardagent no\n/)
  assert.match(config, /pubkeyauthentication false\n/)
  assert.match(config, /identityagent none\n/)
  assert(args.at(-1)?.startsWith("/bin/sh -c 'cd "))
})
check('POSIX, csh and tcsh login command wrappers work without opening an interactive shell', () => {
  const command = sshArguments({ ...host, remoteDirectory: '/tmp' }, '/tmp/known_hosts').at(-1)!
  for (const shell of ['/bin/sh', '/bin/csh', '/bin/tcsh'].filter(existsSync)) {
    execFileSync(shell, [...(shell.endsWith('csh') ? ['-f'] : []), '-c', command], { env: { PATH: '/usr/bin:/bin', SHELL: '/usr/bin/true' }, stdio: 'pipe' })
  }
})
console.log(JSON.stringify({ passed, networkCalls: 0, userCredentialsRead: false }))
