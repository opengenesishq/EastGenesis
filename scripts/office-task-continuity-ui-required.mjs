#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-office-continuity-'))
const reportPath = path.join(repoRoot, 'test-results/office-task-continuity-ui/latest.json')
const report = { kind: 'caogen.office-task-continuity-ui', status: 'failed', checks: [], providerCalls: false,
  evidenceStrength: 'electron-react-component-harness',
  limitations: ['Actual OfficeCommandInput and shared draft hook with controlled store/IPC; no full ChatView, WebGL, Provider or human acceptance evidence.'] }
try {
  await build({ entryPoints: [path.join(repoRoot, 'scripts/office-task-continuity-ui-entry.tsx')],
    outfile: path.join(tempRoot, 'harness.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' } })
  writeFileSync(path.join(tempRoot, 'harness.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="harness.js"></script>')
  writeFileSync(path.join(tempRoot, 'main.cjs'), `
const { app, BrowserWindow, session } = require('electron')
const { writeFileSync } = require('node:fs')
app.setPath('userData', ${JSON.stringify(path.join(tempRoot, 'user-data'))})
app.commandLine.appendSwitch('disable-gpu')
const timeout = setTimeout(() => { console.error('Office continuity harness timed out'); app.exit(1) }, 25000)
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  await win.loadFile(${JSON.stringify(path.join(tempRoot, 'harness.html'))})
  const checks = await win.webContents.executeJavaScript('window.runOfficeTaskContinuityHarness()')
  writeFileSync(${JSON.stringify(path.join(tempRoot, 'checks.json'))}, JSON.stringify({ checks, electron: process.versions.electron }))
  clearTimeout(timeout); app.exit(0)
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1) })
`)
  const env = { ...process.env, ELECTRON_IS_DEV: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  execFileSync(require('electron'), [path.join(tempRoot, 'main.cjs')], { cwd: repoRoot, env, encoding: 'utf8', timeout: 35000, stdio: ['ignore', 'pipe', 'pipe'] })
  const result = JSON.parse(readFileSync(path.join(tempRoot, 'checks.json'), 'utf8'))
  assert.equal(result.checks.length, 5)
  assert(result.checks.every(check => check.status === 'passed'))
  Object.assign(report, result, { status: 'passed' })
} catch (error) {
  report.error = String(error?.stderr?.toString?.() || error?.message || error)
  console.error(report.error)
  process.exitCode = 1
} finally {
  mkdirSync(path.dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2)}\n`)
  rmSync(tempRoot, { recursive: true, force: true })
}
console.log(`Office task continuity: ${report.status} (${report.checks.length}/5)\nreport: ${reportPath}`)
