import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer as httpsServer } from 'node:https'
import { createServer as tcpServer, connect } from 'node:net'
import { createHash } from 'node:crypto'
import { Module } from 'node:module'
import { build } from 'esbuild'

const fixtureRoot = process.env.CAOGEN_SSH_TUNNEL_FIXTURE_ROOT
if (!fixtureRoot) {
  const root = mkdtempSync(join(tmpdir(), 'caogen-ssh-tunnel-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=fixture.invalid',
      '-addext', 'subjectAltName=DNS:fixture.invalid', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem')], { stdio: 'ignore' })
    const output = execFileSync(process.execPath, [resolve('scripts/remote-ssh-tunnel-required.mjs')], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CAOGEN_SSH_TUNNEL_FIXTURE_ROOT: root, NODE_EXTRA_CA_CERTS: join(root, 'cert.pem') } })
    process.stdout.write(output)
  } finally { rmSync(root, { recursive: true, force: true }) }
} else {
  const output = await build({ stdin: { contents: `export * from './src/main/ssh/tunnel';export * from './src/main/remote-hosts/transport';export * from './src/main/remote-hosts/service';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false })
  const filename = resolve('scripts/.remote-ssh-tunnel-fixture.cjs'), module = new Module(filename)
  module.filename = filename; module.paths = Module._nodeModulePaths(dirname(filename)); module._compile(output.outputFiles[0].text, filename)
  const api = module.exports, sockets = new Set(), servers = [], requests = [], launches = []
  let manager, currentRevision = 1, checks = 0
  const pass = name => { checks++; console.log(`PASS ${name}`) }
  const server = httpsServer({ key: readFileSync(join(fixtureRoot, 'key.pem')), cert: readFileSync(join(fixtureRoot, 'cert.pem')) }, async (request, response) => {
    requests.push({ host: request.headers.host, sni: request.socket.servername, path: request.url, authorization: request.headers.authorization })
    let body = ''; for await (const chunk of request) body += chunk
    response.setHeader('content-type', 'application/json')
    if (request.method === 'HEAD') { response.end(); return }
    if (request.url === '/remote/pair/register') {
      const input = JSON.parse(body)
      response.statusCode = 201
      response.end(JSON.stringify({ protocolVersion: 1, projectId: 'p1', deviceId: 'd1', capabilities: ['view_results'], expiresAt: Date.now() + 86400000,
        fingerprint: `sha256:${createHash('sha256').update(input.publicKey).digest('hex')}`, consoleUrl: `${origin}/remote/console/${'c'.repeat(32)}` }))
      return
    }
    response.end(JSON.stringify({ ok: true }))
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const remotePort = server.address().port, origin = `https://fixture.invalid:${remotePort}`
  const host = { id: 'ssh-fixture', revision: 1, name: 'Fixture SSH', hostname: '127.0.0.1', port: 2222, username: 'fixture', remoteDirectory: '/unused',
    trustedKeys: [{ type: 'ssh-ed25519', key: Buffer.alloc(32).toString('base64'), fingerprint: 'SHA256:fixture' }] }
  const launcher = { async start(input) {
    launches.push(input)
    const forward = input.args[input.args.indexOf('-L') + 1]
    assert.match(forward, new RegExp(`^127\\.0\\.0\\.1:\\d+:127\\.0\\.0\\.1:${remotePort}$`))
    const port = Number(forward.split(':')[1])
    const local = tcpServer(socket => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket))
      const remote = connect({ host: '127.0.0.1', port: remotePort }); sockets.add(remote); remote.once('close', () => sockets.delete(remote))
      socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy()); socket.pipe(remote); remote.pipe(socket)
    })
    servers.push(local); await new Promise(resolve => local.listen(port, '127.0.0.1', resolve))
    return { write() { throw Error('fixture authenticated without input') }, close() { local.close(); for (const socket of sockets) socket.destroy() } }
  } }
  try {
    manager = new api.RemoteSshTunnelManager(join(fixtureRoot, 'tunnels'), (id, revision) => {
      if (id !== host.id || revision !== currentRevision) throw Error('host revision changed')
      return { ...host, revision: currentRevision }
    }, launcher)
    const tunnel = await manager.start(host.id, 1, origin, 1)
    assert.equal(tunnel.state, 'ready')
    const args = launches[0].args.join(' ')
    for (const expected of ['-N -T', 'StrictHostKeyChecking=yes', 'ExitOnForwardFailure=yes', 'ForwardAgent=no', 'ProxyJump=none', 'EscapeChar=none']) assert(args.includes(expected))
    assert(!args.includes('ClearAllForwardings=yes')); assert(!args.includes('/unused'))
    pass('a dedicated fake SSH process forwards only local loopback to the selected host loopback HTTPS port with strict keys')

    const dial = manager.resolve(tunnel.binding), identity = await api.remoteHostHttpsTransport.inspect(origin, dial)
    await api.remoteHostHttpsTransport.request(identity, 'GET', '/fixture', 'fixture-bearer', undefined, dial)
    assert.equal(requests.at(-1).host, `fixture.invalid:${remotePort}`); assert.equal(requests.at(-1).sni, 'fixture.invalid'); assert.equal(requests.at(-1).authorization, 'Bearer fixture-bearer')
    assert.equal(identity.origin, origin)
    const before = requests.length
    await assert.rejects(api.remoteHostHttpsTransport.request({ ...identity, spkiFingerprint: `sha256:${'0'.repeat(64)}` }, 'GET', '/must-not-send', 'secret', undefined, dial))
    assert.equal(requests.length, before)
    const wrong = await manager.start(host.id, 1, `https://wrong.invalid:${remotePort}`, 1)
    await assert.rejects(api.remoteHostHttpsTransport.inspect(wrong.binding.httpsOrigin, manager.resolve(wrong.binding)))
    assert.equal(requests.length, before)
    pass('real local TLS keeps original SNI, Host and origin; incorrect public keys and hostnames fail before credentials reach HTTP')

    const protection = { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'unavailable', encryptString() { throw Error('unused') }, decryptString() { throw Error('unused') } }
    const service = new api.RemoteHostService(join(fixtureRoot, 'client'), protection, api.remoteHostHttpsTransport, Date.now, manager)
    const preview = await service.inspectRemoteHostPairing(`${origin}/remote/pair/${'a'.repeat(32)}`, tunnel.id, 1)
    const paired = await service.pairRemoteHost({ previewId: preview.id, confirmedSpkiFingerprint: preview.identity.spkiFingerprint, label: 'Via SSH', deviceLabel: 'Fixture device', storage: 'session' })
    assert.equal(paired.status, 'paired'); assert.deepEqual(paired.ssh, tunnel.binding)
    manager.close(tunnel.id, 1)
    const count = requests.length
    await assert.rejects(service.readRemoteHostTasks(paired.id), /原 SSH 隧道/)
    await assert.rejects(api.remoteHostHttpsTransport.request(identity, 'GET', '/after-close', 'secret', undefined, dial))
    assert.equal(requests.length, count)
    pass('pairing stores the reviewed SSH association; disconnection prevents control without silently switching to a direct connection')

    const reconnect = await manager.start(host.id, 1, origin, 1)
    await api.remoteHostHttpsTransport.inspect(origin, manager.resolve(reconnect.binding))
    currentRevision = 2
    assert.throws(() => manager.resolve(reconnect.binding), /revision changed/)
    assert.equal(manager.list()[manager.list().findIndex(item => item.id === reconnect.id)].state, 'failed')
    assert.throws(() => manager.close(wrong.id, 2), /此窗口/)
    pass('reconnect reuses the exact route binding; changed host revisions and another window cannot keep or control the old tunnel')

    let authInput
    const entered = [], auth = new api.RemoteSshTunnelManager(join(fixtureRoot, 'auth-tunnels'), () => host, { async start(input) {
      authInput = input; return { write: value => entered.push(value), close() {} }
    } })
    try {
      const connecting = await auth.start(host.id, 1, origin, 1)
      assert.equal(connecting.state, 'connecting')
      assert.throws(() => auth.write(connecting.id, 'fixture-passphrase', 1), /等待/)
      authInput.onOutput('Enter passphrase for key fixture: ')
      auth.write(connecting.id, 'fixture-passphrase', 1)
      assert.deepEqual(entered, ['fixture-passphrase\r']); assert.equal(auth.list(1)[0].output, '')
      assert.throws(() => auth.write(connecting.id, 'fixture-passphrase', 1), /等待/)
      assert.throws(() => auth.write(connecting.id, 'fixture-passphrase', 2), /此窗口/)
    } finally { auth.dispose() }
    pass('manual authentication accepts one line only after this owned SSH process emits a password prompt; input is not retained in its UI output')
    console.log(`remote-ssh-tunnel-required: ${checks}/${checks}; fake SSH, temporary certificate trusted only in fixture child process, real loopback TLS; no real remote host`)
  } finally {
    manager?.dispose(); api.remoteHostHttpsTransport.dispose(); for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map(item => new Promise(resolve => item.close(() => resolve()))))
    await new Promise(resolve => server.close(() => resolve()))
  }
}
