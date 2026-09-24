#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const repoRoot = process.cwd()
const require = createRequire(path.join(repoRoot, 'package.json'))
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-session-routing-ui-'))
const outputPath = path.join(repoRoot, 'test-results', 'session-routing-control-ui', 'latest.json')
const report = { schemaVersion: 1, kind: 'caogen.session-routing-control-ui-report', runId: randomUUID(),
  startedAt: new Date().toISOString(), status: 'failed', checks: [], providerCalls: false, humanEvidence: false,
  evidenceStrength: 'electron-react-component-harness',
  limitations: ['Actual SessionModelPicker and routing fields with fixture store/IPC; does not prove main-process routing, Provider requests or human acceptance.'] }
const writeReport = () => { mkdirSync(path.dirname(outputPath), { recursive: true }); writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`) }
writeReport()
try {
  await build({ entryPoints: [path.join(repoRoot, 'scripts', 'session-routing-control-ui-entry.tsx')],
    outfile: path.join(tempRoot, 'harness.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"' } })
  const htmlPath = path.join(tempRoot, 'harness.html')
  const checksPath = path.join(tempRoot, `checks-${report.runId}.json`)
  writeFileSync(htmlPath, '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="harness.js"></script>')
  const env = { ...process.env, ELECTRON_IS_DEV: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  execFileSync(require('electron'), [path.join(repoRoot, 'scripts', 'session-routing-control-ui-electron.cjs'), htmlPath, checksPath],
    { cwd: repoRoot, env, encoding: 'utf8', timeout: 35_000, stdio: ['ignore', 'pipe', 'pipe'] })
  const result = JSON.parse(readFileSync(checksPath, 'utf8'))
  assert.equal(result.checks.length, 9)
  assert(result.checks.every(check => check.status === 'passed'))
  report.checks = result.checks
  report.electron = result.electron
  report.status = 'passed'
} catch (error) {
  report.error = String(error?.stderr?.toString?.() || error?.message || error)
  report.checks.push({ id: 'component-harness-execution', status: 'failed', detail: report.error })
  console.error(report.error)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  writeReport()
  rmSync(tempRoot, { recursive: true, force: true })
}
console.log(`Session routing UI: ${report.status} (${report.checks.filter(check => check.status === 'passed').length}/${report.checks.length})`)
console.log(`report: ${outputPath}`)
