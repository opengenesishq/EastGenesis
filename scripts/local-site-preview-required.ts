import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionMeta } from '../src/shared/types'
import { LocalSitePreviewService } from '../src/main/sites/local-site-preview'

let checks = 0
async function check(name: string, run: () => Promise<void>): Promise<void> { await run(); checks++; console.log(`PASS ${name}`) }
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'caogen-local-site-preview-'))
  const cwd = join(root, 'task'), data = join(root, 'data')
  await mkdir(join(cwd, 'dist'), { recursive: true }); await mkdir(data)
  await writeFile(join(cwd, 'dist', 'index.html'), '<h1>First version</h1><link rel="stylesheet" href="/style.css">')
  await writeFile(join(cwd, 'dist', 'style.css'), 'h1 { color: red; }')
  await writeFile(join(cwd, 'report.html'), '<h1>Self-contained report</h1>')
  await writeFile(join(cwd, '.env'), 'DO_NOT_COPY=true')
  await writeFile(join(root, 'outside.html'), '<p>outside</p>')
  let meta = { id: 'session-a', cwd, createdAt: 1, workspaceId: 'workspace-a', goalId: 'goal-a', workItemId: 'work-a', status: 'idle' } as SessionMeta
  let authorized = true, deniedFile = '', pauseRead: Promise<void> | undefined
  const readEntered = gate(), paths: string[] = []
  const service = new LocalSitePreviewService({ root: () => data, session: id => id === meta.id ? meta : undefined,
    authorize: async () => { if (!authorized) throw new Error('task denied') },
    assertRead: async (_id, path) => { paths.push(path); if (path.endsWith(deniedFile) && deniedFile) throw new Error('file denied'); if (pauseRead) { readEntered.resolve(); await pauseRead } }
  })
  try {
    await check('no deployment target: HTML directory serves HTML and authenticated root-relative assets', async () => {
      const preview = await service.start(1, 'session-a', 'dist')
      assert.equal(preview.kind, 'directory'); assert.equal(preview.fileCount, 2)
      assert.equal('target' in preview, false); assert.equal('executable' in preview, false)
      const page = await fetch(preview.localUrl)
      assert.equal(page.status, 200); assert.match(await page.text(), /First version/)
      const cookie = page.headers.get('set-cookie')!.split(';', 1)[0]
      const asset = new URL('/style.css', preview.localUrl)
      assert.equal((await fetch(asset)).status, 404)
      const css = await fetch(asset, { headers: { cookie } }); assert.equal(css.status, 200); assert.match(await css.text(), /color: red/)
      assert.ok(paths.some(path => path.endsWith('index.html'))); assert.ok(paths.some(path => path.endsWith('style.css')))
      assert.equal(await service.get(2, 'session-a'), null)
    })
    await check('updating preview freezes the new version, closes old server and deletes old snapshot', async () => {
      const old = (await service.get(1, 'session-a'))!
      await writeFile(join(cwd, 'dist', 'index.html'), '<h1>Second version</h1>')
      assert.match(await (await fetch(old.localUrl)).text(), /First version/)
      const next = await service.start(1, 'session-a', 'dist')
      assert.notEqual(next.manifestDigest, old.manifestDigest)
      assert.match(await (await fetch(next.localUrl)).text(), /Second version/)
      await assert.rejects(fetch(old.localUrl))
      await assert.rejects(readFile(join(data, 'local-site-previews', old.id, 'index.html')))
    })
    await check('single HTML stays within task file scope and does not copy neighboring .env', async () => {
      const preview = await service.start(1, 'session-a', 'report.html')
      assert.equal(preview.kind, 'html'); assert.equal(preview.fileCount, 1)
      assert.match(await (await fetch(preview.localUrl)).text(), /Self-contained/)
      assert.deepEqual(await readdir(join(data, 'local-site-previews', preview.id)), ['report.html'])
      await assert.rejects(service.start(1, 'session-a', '../outside.html'), /边界/)
      await symlink(join(root, 'outside.html'), join(cwd, 'linked.html'))
      await assert.rejects(service.start(1, 'session-a', 'linked.html'), /符号链接/)
    })
    await check('task authorization, file deny and missing index fail without replacing existing preview', async () => {
      const old = (await service.get(1, 'session-a'))!
      authorized = false; await assert.rejects(service.start(1, 'session-a', 'dist'), /task denied/); authorized = true
      deniedFile = 'style.css'; await assert.rejects(service.start(1, 'session-a', 'dist'), /file denied/); deniedFile = ''
      await mkdir(join(cwd, 'empty-build')); await writeFile(join(cwd, 'empty-build', 'app.js'), 'console.log(1)')
      await assert.rejects(service.start(1, 'session-a', 'empty-build'), /index.html/)
      assert.equal((await service.get(1, 'session-a'))?.id, old.id)
      assert.equal((await fetch(old.localUrl)).status, 200)
    })
    await check('stop, owner destruction, task close and task ownership change clean preview servers', async () => {
      const first = (await service.get(1, 'session-a'))!
      await service.stop(2, 'session-a'); assert.equal((await fetch(first.localUrl)).status, 200)
      await service.stop(1, 'session-a'); await assert.rejects(fetch(first.localUrl))
      const second = await service.start(1, 'session-a', 'dist'); await service.stopOwner(1); await assert.rejects(fetch(second.localUrl))
      const third = await service.start(1, 'session-a', 'dist'); meta = { ...meta, status: 'closed' }; await service.refreshSession('session-a'); await assert.rejects(fetch(third.localUrl))
      meta = { ...meta, status: 'idle' }
      const fourth = await service.start(1, 'session-a', 'dist'); meta = { ...meta, workItemId: 'other-work' }; await service.refreshSession('session-a'); await assert.rejects(fetch(fourth.localUrl))
    })
    await check('task switch while freezing invalidates late starts and removes partial snapshots', async () => {
      const barrier = gate(); pauseRead = barrier.promise
      const starting = service.start(1, 'session-a', 'dist')
      const rejected = assert.rejects(starting, /取消|变化/)
      await readEntered.promise; await service.stop(1, 'session-a'); barrier.resolve(); await rejected
      assert.equal(await service.get(1, 'session-a'), null)
      assert.deepEqual(await readdir(join(data, 'local-site-previews')), [])
    })
    console.log(`RESULT ${checks}/${checks}; local HTTP and temporary fixture files only; no deployment scripts or external providers.`)
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true }) }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
