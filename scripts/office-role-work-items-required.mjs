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
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-office-role-'))
const outputPath = path.join(repoRoot, 'test-results', 'office-role-work-items', 'latest.json')
const report = { schemaVersion: 1, kind: 'caogen.office-role-work-items-report', runId: randomUUID(),
  startedAt: new Date().toISOString(), status: 'failed', checks: [], providerCalls: false, humanEvidence: false,
  evidenceStrength: 'electron-react-component-harness',
  limitations: ['Real React component and production WorkItem navigation with fixture snapshots; not full Office, WebGL, Provider or agent-discussion evidence'] }
const writeReport = () => { mkdirSync(path.dirname(outputPath), { recursive: true }); writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`) }
writeReport()
try {
  await build({ entryPoints: [path.join(repoRoot, 'scripts', 'office-role-work-items-entry.tsx')],
    outfile: path.join(tempRoot, 'harness.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' } })
  const htmlPath = path.join(tempRoot, 'harness.html')
  const checksPath = path.join(tempRoot, `checks-${report.runId}.json`)
  writeFileSync(htmlPath, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="harness.css"><div id="root"></div><script src="harness.js"></script>')
  const env = { ...process.env, ELECTRON_IS_DEV: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  execFileSync(require('electron'), [path.join(repoRoot, 'scripts', 'office-role-work-items-electron.cjs'), htmlPath, checksPath],
    { cwd: repoRoot, env, encoding: 'utf8', timeout: 35_000, stdio: ['ignore', 'pipe', 'pipe'] })
  const result = JSON.parse(readFileSync(checksPath, 'utf8'))
  assert.equal(result.checks.length, 19)
  assert(result.checks.every((check) => check.status === 'passed'))
  report.checks = result.checks
  report.electron = result.electron
  const source = readFileSync(path.join(repoRoot, 'src', 'renderer', 'src', 'components', 'office', 'OfficeView.tsx'), 'utf8')
  assert(source.includes('data-office-role-coordination') && source.includes('openOfficeWorkItem(item, useStore.getState())'))
  assert(!source.includes('已召集太子') && !source.includes('Council convened.'))
  report.checks.push({ id: 'office-wires-two-dimensional-entry-and-truthful-overview-receipt', status: 'passed', evidence: 'source-contract' })
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
console.log(`Office role WorkItems: ${report.status} (${report.checks.filter((check) => check.status === 'passed').length}/${report.checks.length})`)
console.log(`report: ${outputPath}`)
