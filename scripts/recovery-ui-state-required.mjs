#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const repoRoot = path.resolve(process.cwd())
const require = createRequire(path.join(repoRoot, 'package.json'))
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-recovery-ui-state-'))
const outputPath = path.join(repoRoot, 'test-results', 'recovery-ui-state', 'latest.json')
const report = {
  schemaVersion: 1, kind: 'caogen.recovery-ui-state-report', runId: randomUUID(),
  startedAt: new Date().toISOString(), status: 'failed', checks: [],
  providerCalls: false, humanEvidence: false,
  evidenceStrength: 'electron-react-component-harness',
  limitations: ['Actual RunDetailPanel and WorkInbox components with fixture store/IPC; does not prove production main-process recovery or a real Provider call']
}
const writeReport = () => {
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
}
writeReport()
try {
  const bundlePath = path.join(tempRoot, 'harness.js')
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, 'scripts', 'recovery-ui-state-entry.tsx')],
    outfile: bundlePath, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{
      name: 'recovery-fixture-store',
      setup(builder) {
        builder.onResolve({ filter: /(?:^|\/)store$/ }, () => ({ path: 'store', namespace: 'recovery-fixture' }))
        builder.onResolve({ filter: /TaskPlanWorkbench$/ }, () => ({ path: 'plan', namespace: 'recovery-fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'recovery-fixture' }, ({ path: fixture }) => ({
          contents: fixture === 'store'
            ? 'export const useStore = (select) => select(window.recoveryUiStore); useStore.getState = () => window.recoveryUiStore;'
            : 'export default function TaskPlanWorkbench() { return null }',
          loader: 'js'
        }))
      }
    }]
  })
  const htmlPath = path.join(tempRoot, 'harness.html')
  const checksPath = path.join(tempRoot, 'checks.json')
  writeFileSync(htmlPath, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="harness.css"><div id="root"></div><script src="harness.js"></script>')
  const env = { ...process.env, ELECTRON_IS_DEV: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  execFileSync(require('electron'), [path.join(repoRoot, 'scripts', 'recovery-ui-state-electron.cjs'), htmlPath, checksPath], {
    cwd: repoRoot, env, encoding: 'utf8', timeout: 35_000, stdio: ['ignore', 'pipe', 'pipe']
  })
  report.checks = JSON.parse(readFileSync(checksPath, 'utf8'))
  if (report.checks.length !== 9 || report.checks.some((check) => check.status !== 'passed')) throw new Error('Recovery component harness did not complete all checks')
  report.status = 'passed'
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  report.checks.push({ name: 'component harness execution', status: 'failed', detail: report.error })
  console.error(report.error)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  writeReport()
  rmSync(tempRoot, { recursive: true, force: true })
}
console.log(`Recovery component UI state: ${report.status} (${report.checks.filter((check) => check.status === 'passed').length}/${report.checks.length})`)
console.log(`report: ${outputPath}`)
