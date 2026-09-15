#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

export function runChangeImpactLedgerGate({ repoRoot = process.cwd(), reportPath = path.join(repoRoot, 'test-results', 'change-impact-ledger-transaction', 'latest.json'), failureStage } = {}) {
  const report = {
    schemaVersion: 1, kind: 'caogen.change-impact-ledger-transaction-report', requirement: 'V2-011',
    runId: randomUUID(), startedAt: new Date().toISOString(), status: 'failed', checks: [], stages: [],
    evidenceStrength: 'not-observed', providerCalls: false, humanEvidence: false,
    limitations: ['isolated canonical Ledger fixture; does not prove the production UI, actual rerun execution, Provider calls or human acceptance']
  }
  const writeReport = () => {
    report.generatedAt = new Date().toISOString()
    mkdirSync(path.dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  }
  // Replace any old pass before compilation or process startup can fail.
  writeReport()
  let tempRoot
  try {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-change-impact-ledger-'))
    const userData = path.join(tempRoot, 'user-data')
    const bundle = path.join(tempRoot, 'change-impact-ledger.cjs')
    mkdirSync(userData, { recursive: true })
    mkdirSync(path.join(tempRoot, 'node_modules', 'sql.js', 'dist'), { recursive: true })
    copyFileSync(path.join(repoRoot, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'), path.join(tempRoot, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'))
    buildSync({ entryPoints: [path.join(repoRoot, 'scripts', 'change-impact-ledger-transaction-entry.ts')], outfile: bundle,
      bundle: true, platform: 'node', format: 'cjs', target: 'node22',
      external: ['electron', 'sql.js', 'tree-sitter', 'tree-sitter-typescript', 'tree-sitter-javascript', 'tree-sitter-python', 'tree-sitter-go', 'tree-sitter-rust', 'tree-sitter-java'] })
    const require = createRequire(path.join(repoRoot, 'package.json'))
    const env = { ...process.env, ELECTRON_IS_DEV: '0', NODE_PATH: path.join(repoRoot, 'node_modules') }
    delete env.ELECTRON_RUN_AS_NODE
    for (const stage of ['write', 'read']) {
      const outputPath = path.join(tempRoot, `${stage}-${report.runId}.json`)
      execFileSync(require('electron'), [path.join(repoRoot, 'scripts', 'change-impact-ledger-transaction-electron.cjs'),
        bundle, failureStage === stage ? 'forced-failure' : stage, userData, outputPath, report.runId],
      { cwd: repoRoot, env, encoding: 'utf8', timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'] })
      const result = JSON.parse(readFileSync(outputPath, 'utf8'))
      assert.equal(result.kind, 'caogen.change-impact-ledger-stage')
      assert.equal(result.runId, report.runId)
      assert.equal(result.stage, stage)
      assert.equal(result.status, 'passed')
      assert.equal(result.runtime?.processType, 'browser')
      assert.equal(typeof result.runtime?.electron, 'string')
      assert(result.runtime.electron.length > 0)
      assert.equal(result.providerCalls, false)
      assert.equal(result.humanEvidence, false)
      assert(Date.parse(result.startedAt) >= Date.parse(report.startedAt))
      assert(Date.parse(result.finishedAt) >= Date.parse(result.startedAt))
      assert(Date.parse(result.finishedAt) <= Date.now())
      assert(result.checks.length > 0 && result.checks.every((check) => check.status === 'passed'))
      report.stages.push(result)
      report.checks.push(...result.checks)
      report.evidenceStrength = 'electron-main-process-ledger-observed'
    }
    assert.notEqual(report.stages[0].runtime.pid, report.stages[1].runtime.pid)
    report.evidenceStrength = 'electron-main-process-ledger-restart-observed'
    report.status = 'passed'
  } catch (error) {
    report.failure = String(error?.stderr?.toString?.() || error?.message || error)
    report.checks.push({ id: 'transaction-gate-execution', status: 'failed', detail: report.failure })
  } finally {
    report.finishedAt = new Date().toISOString()
    writeReport()
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  }
  return { ...report, reportPath }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runChangeImpactLedgerGate()
  console.log(`change impact Electron ledger transaction: ${report.status} (${report.checks.filter((check) => check.status === 'passed').length}/${report.checks.length})`)
  console.log(`report: ${report.reportPath}`)
  if (report.status !== 'passed') { console.error(report.failure); process.exitCode = 1 }
}
