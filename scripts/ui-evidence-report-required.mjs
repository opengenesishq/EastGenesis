#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(process.cwd())
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-ui-evidence-report-'))
const outputPath = path.join(repoRoot, 'test-results', 'ui-evidence-report', 'latest.json')
const report = {
  schemaVersion: 1,
  kind: 'caogen.ui-evidence-report-regression',
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  status: 'failed',
  providerCalls: false,
  humanEvidence: false,
  evidenceStrength: 'node-wrapper-failure-regression',
  limitations: ['Uses a deterministic child process stub; does not launch Electron or prove product UI behavior'],
  checks: []
}
const writeReport = () => {
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
}

const wrappers = [
  ['run-detail-delivery-recovery-electron-required.mjs', 'v2-014-run-detail-delivery-recovery'],
  ['plan-confirmation-ui-required.mjs', 'plan-confirmation-ui'],
  ['mission-compile-ui-required.mjs', 'mission-compile-ui']
]
const scenarios = [
  ['child-failed-without-report', /ENOENT/u],
  ['child-failed-with-passed-report', /nested Electron click gate passed/u],
  ['missing-report', /ENOENT/u],
  ['invalid-report', /JSON/u],
  ['stale-run-id', /belongs to this invocation/u],
  ['stale-timestamps', /timestamps belong to this invocation/u],
  ['wrong-fixture', /requested canonical fixture/u],
  ['missing-clicks', /click/u],
  ['failed-report-with-zero-exit', /nested Electron click gate passed/u],
  ['provider-enabled', /Provider calls remain disabled/u],
  ['human-evidence', /human evidence remains absent/u],
  ['passed', null]
]

writeReport()
try {
  mkdirSync(path.join(tempRoot, 'scripts'), { recursive: true })
  writeFileSync(path.join(tempRoot, 'scripts', 'packaged-ui-click-required.mjs'), `
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const mode = process.env.CAOGEN_UI_EVIDENCE_TEST_MODE
const outputPath = process.env.CAOGEN_UI_CLICK_REPORT_PATH
const wrapper = JSON.parse(readFileSync(path.join(path.dirname(outputPath), 'latest.json'), 'utf8'))
assert.equal(wrapper.status, 'failed', 'previous pass must be replaced before child launch')
assert.equal(wrapper.finishedAt, null)
assert.equal(wrapper.expectedNestedRunId, process.env.CAOGEN_UI_CLICK_RUN_ID)
if (mode === 'child-failed-without-report') process.exit(1)
if (mode === 'missing-report') process.exit(0)
if (mode === 'invalid-report') {
  writeFileSync(outputPath, '{not JSON')
  process.exit(0)
}
const fixture = process.argv[process.argv.indexOf('--fixture') + 1]
const report = {
  schemaVersion: 1,
  kind: 'caogen.packaged-ui-click-report',
  runId: mode === 'stale-run-id' ? 'previous-nested-run' : process.env.CAOGEN_UI_CLICK_RUN_ID,
  startedAt: mode === 'stale-timestamps' ? '2000-01-01T00:00:00.000Z' : new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  status: mode === 'failed-report-with-zero-exit' ? 'failed' : 'passed',
  fixture: mode === 'wrong-fixture' ? 'other-fixture' : fixture === 'plan-confirmation' ? 'plan-confirmation-canonical-local' : 'runs-review-canonical-local',
  evidenceStrength: 'built-source-renderer-click-observed',
  providerCalls: mode === 'provider-enabled',
  humanEvidence: mode === 'human-evidence',
  clicks: mode === 'missing-clicks' ? [] : [
    { name: 'Work Inbox row opens Run detail' },
    { name: 'Run detail opens Acceptance' },
    { name: 'Run detail recovery completed' },
    { name: 'Run detail opens delivery' },
    { name: 'Runs row opens WorkItem', workItemId: 'fixture-runs-review-run-item' },
    { name: 'Review row opens delivery', workItemId: 'fixture-runs-review-review-item' },
    { name: 'Run opens pending TaskPlan' },
    { name: 'TaskPlan approve' },
    { name: 'TaskPlan revoke' },
    { name: 'Goal starter opens compiled Mission plan', sessionId: 'mission-session' },
    { name: 'Mission plan approval projects four WorkItems', sessionId: 'mission-session' }
  ],
  missionCompilation: {
    sessionId: 'mission-session', continuedSessionId: mode === 'missing-continuation' ? undefined : 'mission-session', approvalStatus: 'approved',
    versionId: 'edited-version', originalVersionId: 'original-version', editedVersionId: 'edited-version',
    projection: { steps: [{}, {}, {}, {}] }
  }
}
mkdirSync(path.dirname(outputPath), { recursive: true })
writeFileSync(outputPath, JSON.stringify(report))
process.exit(mode === 'child-failed-with-passed-report' ? 1 : 0)
`)

  for (const [script, directory] of wrappers) {
    const wrapperReportPath = path.join(tempRoot, 'test-results', directory, 'latest.json')
    const sharedReportPath = path.join(tempRoot, 'test-results', 'packaged-ui-click', 'latest.json')
    mkdirSync(path.dirname(wrapperReportPath), { recursive: true })
    mkdirSync(path.dirname(sharedReportPath), { recursive: true })
    let previousRunId = 'previous-wrapper-run'
    const wrapperScenarios = script === 'mission-compile-ui-required.mjs'
      ? [...scenarios, ['missing-continuation', /continue opens the original conversation/u]] : scenarios
    for (const [mode, expectedError] of wrapperScenarios) {
      writeFileSync(wrapperReportPath, JSON.stringify({ status: 'passed', runId: previousRunId }))
      writeFileSync(sharedReportPath, JSON.stringify({ status: 'passed', runId: 'old-shared-report' }))
      const started = Date.now()
      const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', script)], {
        cwd: tempRoot,
        env: { ...process.env, CAOGEN_UI_EVIDENCE_TEST_MODE: mode },
        encoding: 'utf8'
      })
      const actual = JSON.parse(readFileSync(wrapperReportPath, 'utf8'))
      const context = `${script}: ${mode}\n${result.stderr}`
      assert.equal(result.status, expectedError ? 1 : 0, context)
      assert.equal(actual.status, expectedError ? 'failed' : 'passed', context)
      assert.notEqual(actual.runId, previousRunId, context)
      assert.ok(Date.parse(actual.startedAt) >= started, context)
      assert.ok(Date.parse(actual.finishedAt) >= Date.parse(actual.startedAt), context)
      assert.ok(Date.parse(actual.finishedAt) <= Date.now(), context)
      assert.ok(actual.expectedNestedRunId, context)
      assert.notEqual(actual.nestedReport, 'test-results/packaged-ui-click/latest.json', context)
      assert.ok(path.resolve(tempRoot, actual.nestedReport).startsWith(`${path.dirname(wrapperReportPath)}${path.sep}`), context)
      if (expectedError) {
        assert.match(actual.error, expectedError, context)
        assert.ok(actual.checks.some((item) => item.status === 'failed'), context)
        assert.equal(actual.evidenceStrength, undefined, context)
      } else {
        assert.equal(actual.nestedRunId, actual.expectedNestedRunId, context)
        const captured = readFileSync(path.resolve(tempRoot, actual.nestedReport), 'utf8')
        writeFileSync(sharedReportPath, JSON.stringify({ status: 'failed', runId: 'later-unrelated-run' }))
        assert.equal(readFileSync(path.resolve(tempRoot, actual.nestedReport), 'utf8'), captured, context)
        // A later invocation must keep the prior immutable child artifact.
        const next = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', script)], {
          cwd: tempRoot,
          env: { ...process.env, CAOGEN_UI_EVIDENCE_TEST_MODE: 'passed' },
          encoding: 'utf8'
        })
        assert.equal(next.status, 0, next.stderr)
        const nextReport = JSON.parse(readFileSync(wrapperReportPath, 'utf8'))
        assert.notEqual(nextReport.nestedReport, actual.nestedReport, context)
        assert.equal(readFileSync(path.resolve(tempRoot, actual.nestedReport), 'utf8'), captured, context)
      }
      previousRunId = actual.runId
      report.checks.push({ name: `${script}: ${mode}`, status: 'passed' })
    }
  }
  report.status = 'passed'
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  report.checks.push({ name: 'regression execution', status: 'failed', detail: report.error })
  console.error(report.error)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  writeReport()
  rmSync(tempRoot, { recursive: true, force: true })
}
console.log(`UI evidence report regression: ${report.status} (${report.checks.filter((item) => item.status === 'passed').length}/${report.checks.length})`)
console.log(`report: ${outputPath}`)
