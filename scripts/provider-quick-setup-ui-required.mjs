import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const root = process.cwd()
const require = createRequire(path.join(root, 'package.json'))
const temp = mkdtempSync(path.join(tmpdir(), 'caogen-provider-simple-ui-'))
const reportPath = path.join(root, 'test-results/provider-simple-ui/latest.json')
const report = { status: 'failed', generatedAt: new Date().toISOString(), providerCalls: false,
  evidence: 'Electron React component harness with controlled store; controlled model discovery and save; no Provider or real running task', checks: [] }
try {
  mkdirSync(path.dirname(reportPath), { recursive: true })
  await build({ entryPoints: [path.join(root, 'scripts/provider-quick-setup-ui-entry.tsx')], outfile: path.join(temp, 'harness.js'),
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.woff': 'file', '.woff2': 'file', '.svg': 'file', '.png': 'file', '.glb': 'file' } })
  writeFileSync(path.join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="harness.css"><style>body{overflow:auto}#root{height:auto;max-width:780px;margin:30px auto}</style><div id="root"></div><script src="harness.js"></script>')
  const runner = path.join(temp, 'runner.cjs')
  writeFileSync(runner, `const { app, BrowserWindow, session } = require('electron')
const { writeFileSync } = require('node:fs')
const path = require('node:path')
app.setPath('userData', path.join(__dirname, 'user-data'))
app.commandLine.appendSwitch('disable-gpu')
const timeout = setTimeout(() => app.exit(1), 25000)
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, cb) => cb({ cancel: true }))
  const win = new BrowserWindow({ show: false, width: 980, height: 900, webPreferences: { contextIsolation: true, sandbox: true } })
  await win.loadFile(path.join(__dirname, 'index.html'))
  const checks = await win.webContents.executeJavaScript('window.runQuickSetupChecks()')
  writeFileSync(path.join(__dirname, 'checks.json'), JSON.stringify(checks))
  for (const stage of ['catalog', 'key-only']) {
    await win.webContents.executeJavaScript('window.showQuickSetup(' + JSON.stringify(stage) + ')');
    await new Promise(resolve => setTimeout(resolve, 80));
    writeFileSync(path.join('/Users/apple/Desktop/CaoGen/CaoGen-source/test-results/provider-simple-ui', stage + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  clearTimeout(timeout); app.exit(0)
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1) })`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  execFileSync(require('electron'), [runner], { cwd: root, env, encoding: 'utf8', timeout: 35000, stdio: ['ignore', 'pipe', 'pipe'] })
  report.checks = JSON.parse(readFileSync(path.join(temp, 'checks.json'), 'utf8'))
  if (report.checks.length !== 8) throw new Error('incomplete checks')
  report.status = 'passed'
} catch (error) {
  report.error = String(error.stderr?.toString() || error.message || error)
  console.error(report.error); process.exitCode = 1
} finally {
  mkdirSync(path.dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  rmSync(temp, { recursive: true, force: true })
}
console.log(`Provider simple setup: ${report.status} (${report.checks.length}/8). ${reportPath}`)
