import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionMeta } from '../src/shared/types'
import { devServerOperationId, LocalDevServerService } from '../src/main/sites/local-dev-server-service'
import type { LocalDevServerRun } from '../src/shared/local-dev-server-types'
import { normalizeDevServerConfig, probeDevServer, validateDevServerUrl } from '../src/main/sites/local-dev-server-validation'

const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 6500
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)) }
  throw new Error(`Timed out: ${label}`)
}
async function unusedPort(): Promise<number> {
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const address = socket.address(); assert(address && typeof address !== 'string')
  const port = address.port; await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve())); return port
}
async function main(): Promise<void> {
  if (process.platform === 'win32') { console.log('SKIP: managed process groups are explicitly unavailable on Windows'); return }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'caogen-dev-server-check-'))), cwd = join(root, 'project')
  await mkdir(cwd)
  const meta = { id: 'fixture-dev-task', createdAt: 100, cwd, title: 'Fixture', status: 'idle', taskStrategy: 'execute', permissionMode: 'bypassPermissions' } as SessionMeta
  let current: SessionMeta | undefined = meta, authorized = true, paused: Promise<void> | undefined, releases = (): void => undefined
  const actions: string[] = []
  const host = { root: () => root, session: () => current,
    authorize: async (_meta: SessionMeta, _config: unknown, assertOwner: () => void): Promise<() => Promise<void>> => {
      if (paused) await paused
      const guard = async (): Promise<void> => { assertOwner(); if (!authorized) throw new Error('fixture authorization revoked') }
      await guard(); return guard
    }, perform: async (action: 'start' | 'stop', _meta: SessionMeta, run: LocalDevServerRun, execute: () => Promise<void>): Promise<string> => { actions.push(action); await execute(); return devServerOperationId(meta.id, run.id, action) } }
  const service = new LocalDevServerService(host), fixture = join(cwd, 'server.cjs')
  await writeFile(fixture, `
const http = require('node:http')
const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'})
require('node:fs').writeFileSync('descendant.pid', String(child.pid))
console.log('child:' + child.pid)
console.log('env:' + String(process.env.CAOGEN_FIXTURE_SECRET))
http.createServer((q,s)=>s.end('fixture')).listen(Number(process.argv[2]), '127.0.0.1', () => {
  console.log('ready')
  process.stdout.write('token=split-')
  setTimeout(() => { console.log('fixture-sensitive-value'); console.log('x'.repeat(20000)); console.log('logs-complete') }, 20)
})
`)
  const request = async (): Promise<{ sessionId: string; requestId: string; command: string; cwd: string; url: string }> => {
    const port = await unusedPort()
    return { sessionId: meta.id, requestId: randomUUID(), command: `${quote(process.execPath)} ${quote(fixture)} ${port}`, cwd, url: `http://127.0.0.1:${port}/` }
  }
  let groups = 0
  process.env.CAOGEN_FIXTURE_SECRET = 'fixture-private-environment-value'
  const priorUserData = process.env.CAOGEN_USER_DATA_DIR
  process.env.CAOGEN_USER_DATA_DIR = root
  try {
    for (const url of ['http://example.test/', 'http://127.1/', 'http://2130706433/', 'http://127.0.0.1.evil.test/', 'http://localhost/?token=value', 'file:///tmp/']) assert.throws(() => validateDevServerUrl(url))
    assert.equal(validateDevServerUrl('http://localhost:5173/'), 'http://localhost:5173/')
    assert.throws(() => normalizeDevServerConfig({ command: 'TOKEN=secret npm run dev', cwd, url: 'http://localhost:1/' }, cwd))
    assert.equal(normalizeDevServerConfig({ command: `${quote(process.execPath)} ${quote(fixture)} 12345`, cwd, url: 'http://localhost:12345/' }, cwd).cwd, cwd)
    groups++

    const first = await request(), started = await service.start(9, first, () => undefined)
    assert.equal(started.current?.status, 'running'); assert(started.current.pid); assert.equal(started.current.operationId, devServerOperationId(meta.id, first.requestId, 'start'))
    await until(async () => { await service.refresh(); return service.get(meta.id).current?.reachable === true }, 'server reachable')
    await until(() => Boolean(service.get(meta.id).current?.logs.some(line => line.includes('logs-complete'))), 'logs captured')
    const logs = service.get(meta.id).current!.logs.join('\n')
    assert(logs.includes('env:undefined')); assert(!logs.includes('fixture-private-environment-value')); assert(!logs.includes('split-fixture-sensitive-value'))
    assert(logs.includes('[redacted]')); assert(logs.includes('超长日志行已省略'))
    await assert.rejects(service.start(9, await request(), () => undefined), /已有服务/)
    const recovered = new LocalDevServerService(host), restoredWhileRunning = recovered.get(meta.id)
    assert.equal(restoredWhileRunning.current?.status, 'interrupted'); assert.equal(restoredWhileRunning.current?.pid, undefined)
    assert.equal(restoredWhileRunning.current?.operationId, started.current.operationId)
    await assert.rejects(recovered.start(9, first, () => undefined), /已有持久记录/)
    const descendant = Number(await readFile(join(cwd, 'descendant.pid'), 'utf8'))
    await service.stop(meta.id, first.requestId)
    await until(() => service.get(meta.id).current?.status === 'stopped', 'stop process')
    await until(async () => !await probeDevServer(first.url), 'listener closed')
    await until(() => { try { process.kill(descendant, 0); return false } catch { return true } }, 'descendant exited')
    assert(actions.includes('start') && actions.includes('stop')); groups++
    assert.equal(new LocalDevServerService(host).get(meta.id).current?.status, 'stopped')
    assert.equal(new LocalDevServerService(host).get(meta.id).current?.stopOperationId, devServerOperationId(meta.id, first.requestId, 'stop'))
    groups++

    paused = new Promise(resolve => { releases = resolve })
    const pendingInput = await request(), pending = service.start(9, pendingInput, () => undefined)
    const rejected = assert.rejects(pending, /取消/)
    await service.stop(meta.id, pendingInput.requestId); releases(); await rejected
    paused = undefined
    assert.equal(service.get(meta.id).current?.pid, undefined); groups++

    const revoked = await request(); await service.start(9, revoked, () => undefined)
    authorized = false; await service.refresh()
    await until(() => service.get(meta.id).current?.status === 'stopped', 'revoked service stopped')
    authorized = true; groups++

    paused = new Promise(resolve => { releases = resolve })
    const staleInput = await request(), stale = service.start(9, staleInput, () => undefined)
    const staleRejected = assert.rejects(stale, /身份已变化/)
    current = { ...meta, workItemId: 'changed' }; releases(); await staleRejected
    current = meta; paused = undefined; assert.equal(service.get(meta.id).current?.pid, undefined); groups++

    const closed = await request(); await service.start(9, closed, () => undefined)
    current = { ...meta, status: 'closed' }; await service.refresh()
    await until(() => service.get(meta.id).current?.status === 'stopped', 'task close stops service')
    current = meta; groups++

    const windowClosed = await request(); await service.start(9, windowClosed, () => undefined)
    service.stopOwner(8); assert.equal(service.get(meta.id).current?.status, 'running')
    service.stopOwner(9); await until(() => service.get(meta.id).current?.status === 'stopped', 'owner close stops service'); groups++

    const exitInput = await request(); exitInput.command = `${quote(process.execPath)} -e 'process.exit(7)'`
    await service.start(9, exitInput, () => undefined)
    await until(() => service.get(meta.id).current?.status === 'failed', 'natural exit observed')
    assert.equal(service.get(meta.id).current?.exitCode, 7); groups++
    console.log(`PASS ${groups} local development server fixture groups; no external service or provider calls`)
  } finally { delete process.env.CAOGEN_FIXTURE_SECRET; if (priorUserData === undefined) delete process.env.CAOGEN_USER_DATA_DIR; else process.env.CAOGEN_USER_DATA_DIR = priorUserData; service.dispose(); await new Promise(resolve => setTimeout(resolve, 100)); await rm(root, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
