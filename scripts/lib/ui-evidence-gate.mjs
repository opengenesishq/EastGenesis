import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Keep each derived gate bound to the child it actually ran, including failures. */
export function runUiEvidenceGate({ kind, directory, fixture, reportFixture, label, validate, limitations }) {
  const repoRoot = path.resolve(process.cwd())
  const startedAt = new Date().toISOString()
  const runId = `${startedAt.replace(/[:.]/gu, '-')}-${randomUUID()}`
  const expectedNestedRunId = randomUUID()
  const reportPath = path.join(repoRoot, 'test-results', directory, 'latest.json')
  const nestedReportPath = path.join(path.dirname(reportPath), `nested-${expectedNestedRunId}.json`)
  const checks = []
  const report = {
    schemaVersion: 1,
    kind,
    runId,
    startedAt,
    finishedAt: null,
    status: 'failed',
    fixture: reportFixture,
    providerCalls: false,
    humanEvidence: false,
    checks,
    nestedReport: path.relative(repoRoot, nestedReportPath),
    expectedNestedRunId,
    nestedRunId: null,
    limitations,
    error: 'nested Electron gate has not completed'
  }
  const writeReport = () => {
    mkdirSync(path.dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  const check = (name, ok, detail = '') => {
    checks.push({ name, status: ok ? 'passed' : 'failed', detail })
    if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ''}`)
  }

  // Replace any previous pass before starting the child, so an interrupted
  // wrapper cannot leave yesterday's success as its latest evidence.
  writeReport()
  try {
    const nested = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'packaged-ui-click-required.mjs'),
      '--source', '--fixture', fixture
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CAOGEN_UI_CLICK_RUN_ID: expectedNestedRunId,
        CAOGEN_UI_CLICK_REPORT_PATH: nestedReportPath
      },
      stdio: 'inherit'
    })
    report.nestedExitCode = nested.status
    report.nestedSignal = nested.signal
    if (nested.error) throw nested.error
    const nestedReport = JSON.parse(readFileSync(nestedReportPath, 'utf8'))
    report.nestedRunId = typeof nestedReport.runId === 'string' ? nestedReport.runId : null
    check('nested report belongs to this invocation', nestedReport.runId === expectedNestedRunId)
    check('nested report is an Electron click report', nestedReport.kind === 'caogen.packaged-ui-click-report')
    const nestedStartedAt = Date.parse(nestedReport.startedAt)
    const nestedFinishedAt = Date.parse(nestedReport.finishedAt)
    check('nested report timestamps belong to this invocation',
      Number.isFinite(nestedStartedAt) && Number.isFinite(nestedFinishedAt)
      && nestedStartedAt >= Date.parse(startedAt)
      && nestedFinishedAt >= nestedStartedAt && nestedFinishedAt <= Date.now())
    check('nested Electron click gate passed', nested.status === 0 && nestedReport.status === 'passed')
    check('requested canonical fixture was seeded', nestedReport.fixture === reportFixture)
    check('built source renderer click evidence was observed', nestedReport.evidenceStrength === 'built-source-renderer-click-observed')
    check('Provider calls remain disabled', nestedReport.providerCalls === false)
    check('human evidence remains absent', nestedReport.humanEvidence === false)
    validate(nestedReport, check, report)
    report.evidenceStrength = nestedReport.evidenceStrength
    report.status = 'passed'
    delete report.error
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    checks.push({ name: 'gate execution', status: 'failed', detail: report.error })
    console.error(`${label} failed: ${report.error}`)
    process.exitCode = 1
  } finally {
    report.finishedAt = new Date().toISOString()
    writeReport()
  }
  console.log(`${label}: ${report.status} (${checks.filter((item) => item.status === 'passed').length}/${checks.length})`)
  console.log(`report: ${reportPath}`)
  return report
}
