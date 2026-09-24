import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import * as https from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Module } from 'node:module'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'caogen-remote-host-tls-'))
let server, checks = 0, requests = 0
const pass = name => { checks++; console.log(`PASS ${name}`) }
try {
  writeFileSync(join(root, 'openssl.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n')
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', join(root, 'openssl.cnf'), '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem')], { stdio: 'ignore' })
  const certificate = readFileSync(join(root, 'cert.pem'))
  server = createServer({ cert: certificate, key: readFileSync(join(root, 'key.pem')) }, (request, response) => {
    requests++
    if (request.url === '/redirect') { response.writeHead(302, { location: 'https://never-contact.invalid/' }); response.end(); return }
    if (request.url === '/pending') return
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `https://localhost:${server.address().port}`
  // The fixture supplies its own temporary CA and resolves only to its loopback listener.
  // Neither a custom CA nor a hostname override is exposed by the production transport.
  globalThis.__remoteTlsFixture = { trusted: true, request(url, options, callback) {
    return https.request(url, { ...options, ...(this.trusted ? { ca: certificate } : {}), lookup: (_name, opts, done) => opts?.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4) }, callback)
  } }
  const built = await build({ stdin: { contents: `export * from './src/main/remote-hosts/transport';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'temporary-ca', setup(b) { b.onResolve({ filter: /^node:https$/ }, () => ({ path: 'https', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const request = (...args) => globalThis.__remoteTlsFixture.request(...args)', loader: 'js' })) } }] })
  const filename = resolve('scripts/.remote-host-tls-fixture.cjs'), mod = new Module(filename)
  mod.filename = filename; mod.paths = Module._nodeModulePaths(dirname(filename)); mod._compile(built.outputFiles[0].text, filename)
  const transport = mod.exports.remoteHostHttpsTransport
  globalThis.__remoteTlsFixture.trusted = false
  await assert.rejects(transport.inspect(origin), /证书/)
  assert.equal(requests, 0)
  globalThis.__remoteTlsFixture.trusted = true
  const identity = await transport.inspect(origin)
  assert.match(identity.spkiFingerprint, /^sha256:[a-f0-9]{64}$/)
  assert.equal((await transport.request(identity, 'GET', '/ok', 'a'.repeat(32))).body.ok, true)
  pass('a trusted matching TLS certificate is required before sending the control credential')
  const before = requests
  await assert.rejects(transport.request({ ...identity, spkiFingerprint: `sha256:${'0'.repeat(64)}` }, 'POST', '/must-not-arrive', 'a'.repeat(32), { secret: 'fixture' }), /指纹/)
  await assert.rejects(transport.inspect(origin.replace('localhost', 'different.invalid')), /证书/)
  assert.equal(requests, before)
  pass('changed SPKI and mismatched hostname fail before the server receives a request')
  await assert.rejects(transport.request(identity, 'GET', '/redirect'), /重定向/)
  assert.equal(requests, before + 1)
  pass('redirect responses stop at the paired origin')
  const pending = transport.request(identity, 'GET', '/pending')
  await new Promise(resolve => setTimeout(resolve, 30))
  transport.dispose()
  await assert.rejects(pending)
  pass('service disposal cancels an in-flight TLS request')
  console.log(`remote-hosts-tls-required: ${checks}/${checks}; self-owned loopback TLS server and temporary CA only; no external network or user certificates`)
} finally {
  server?.closeAllConnections()
  if (server) await new Promise(resolve => server.close(resolve))
  delete globalThis.__remoteTlsFixture
  rmSync(root, { recursive: true, force: true })
}
