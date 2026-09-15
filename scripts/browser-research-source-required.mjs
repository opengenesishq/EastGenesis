import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const repo = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'caogen-browser-research-'))
const data = join(root, 'user-data')
try {
  mkdirSync(data)
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir')
  const bundle = join(root, 'browser-source.cjs')
  buildSync({ entryPoints: [resolve('scripts/browser-research-source-required.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external' })
  const runner = join(root, 'runner.cjs')
  writeFileSync(runner, `const { app } = require('electron');
app.setPath('userData', process.argv[3]);
app.whenReady().then(async () => { await require(process.argv[2]).run('read', process.argv[3]); app.exit(0) }).catch(error => { console.error(error.stack || error); app.exit(1) });\n`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const code = await new Promise((resolveRun, reject) => {
    const child = spawn(require('electron'), [runner, bundle, data], { cwd: repo, env, stdio: 'inherit' })
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Browser source fixture timed out')) }, 60000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', status => { clearTimeout(timeout); resolveRun(status ?? 1) })
  })
  process.exitCode = Number(code)
} finally { rmSync(root, { recursive: true, force: true }) }
