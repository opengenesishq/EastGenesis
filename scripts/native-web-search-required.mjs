import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url), repo = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'caogen-native-search-')), data = join(root, 'user-data')
try {
  mkdirSync(data)
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir')
  const bundle = join(root, 'native-search.cjs'), runner = join(root, 'runner.cjs')
  buildSync({ entryPoints: [resolve('scripts/native-web-search-required.ts')], outfile: bundle,
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(bundle).href) },
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external' })
  writeFileSync(runner, `const { app } = require('electron'); app.setPath('userData', process.argv[3]);
app.whenReady().then(async () => { await require(process.argv[2]).run('search', process.argv[3]); app.exit(0) }).catch(error => { console.error(error.stack || error); app.exit(1) });\n`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  process.exitCode = Number(await new Promise((resolveRun, reject) => {
    const child = spawn(require('electron'), [runner, bundle, data], { cwd: repo, env, stdio: 'inherit' })
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Native search fixture timed out')) }, 60000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', status => { clearTimeout(timer); resolveRun(status ?? 1) })
  }))
} finally { rmSync(root, { recursive: true, force: true }) }
