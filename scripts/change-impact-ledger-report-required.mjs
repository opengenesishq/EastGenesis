#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runChangeImpactLedgerGate } from './change-impact-ledger-transaction-required.mjs'

const repoRoot = process.cwd()
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'caogen-change-impact-report-'))
const reportPath = path.join(repoRoot, 'test-results', 'change-impact-ledger-report', 'latest.json')
const report = { schemaVersion: 1, kind: 'caogen.change-impact-ledger-report-integrity', status: 'failed',
  startedAt: new Date().toISOString(), providerCalls: false, humanEvidence: false, checks: [], failures: [] }
const writeReport = () => {
  mkdirSync(path.dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}
writeReport()
try {
  for (const scenario of ['setup', 'write', 'read']) {
    const target = path.join(fixtureRoot, `${scenario}.json`)
    writeFileSync(target, JSON.stringify({ status: 'passed', runId: 'historical-pass', generatedAt: '2000-01-01T00:00:00.000Z' }))
    const started = Date.now()
    const result = runChangeImpactLedgerGate({
      repoRoot: scenario === 'setup' ? path.join(fixtureRoot, 'missing-checkout') : repoRoot,
      reportPath: target, ...(scenario === 'setup' ? {} : { failureStage: scenario })
    })
    const saved = JSON.parse(readFileSync(target, 'utf8'))
    assert.equal(result.status, 'failed')
    assert.equal(saved.status, 'failed')
    assert.equal(saved.runId, result.runId)
    assert.notEqual(saved.runId, 'historical-pass')
    assert(Date.parse(saved.startedAt) >= started)
    assert(Date.parse(saved.finishedAt) >= Date.parse(saved.startedAt))
    assert(Date.parse(saved.generatedAt) >= Date.parse(saved.finishedAt))
    assert(saved.checks.some((check) => check.status === 'failed'))
    assert.equal(saved.stages.length, scenario === 'read' ? 1 : 0)
    assert.equal(saved.evidenceStrength, scenario === 'read' ? 'electron-main-process-ledger-observed' : 'not-observed')
    assert.match(saved.failure, scenario === 'setup' ? /ENOENT/ : /unsupported transaction fixture stage/)
    report.checks.push({ id: `${scenario}-failure-replaces-historical-pass`, status: 'passed' })
    report.failures.push({ scenario, runId: saved.runId, status: saved.status, evidenceStrength: saved.evidenceStrength,
      generatedAt: saved.generatedAt, completedStages: saved.stages.length })
  }
  report.status = 'passed'
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  report.checks.push({ id: 'failure-report-integrity', status: 'failed', detail: report.error })
  console.error(report.error)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  writeReport()
  rmSync(fixtureRoot, { recursive: true, force: true })
}
console.log(`Change impact failure report: ${report.status} (${report.checks.filter((check) => check.status === 'passed').length}/${report.checks.length})`)
console.log(`report: ${reportPath}`)
