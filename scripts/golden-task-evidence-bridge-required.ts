import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

type Check = { id: string; status: 'passed' | 'failed'; detail: string }
const checks: Check[] = []
const check = (id: string, ok: boolean, detail: string): void => checks.push({ id, status: ok ? 'passed' : 'failed', detail })

async function main(): Promise<void> {
  const root = resolve(process.cwd())
  const component = await readFile(resolve(root, 'src/renderer/src/components/studio/GoldenTasksPanel.tsx'), 'utf8')
  const styles = await readFile(resolve(root, 'src/renderer/src/components/studio/golden-tasks-panel.css'), 'utf8')

  check('bridge-visible', component.includes('data-golden-task-operational-status="blocked"') && component.includes('主持人证据桥接'), 'UI must expose a visible blocked operator bridge')
  check('report-command', component.includes("runnerCommand('report')") && component.includes('golden-tasks:session -- report --out'), 'UI must provide the canonical operational report command')
  check('session-status-command', component.includes("runnerCommand('status', selectedSession.sessionId)") && component.includes('data-golden-task-action="copy-status"'), 'UI must generate a status command for a concrete session')
  check('cancelled-command-suppressed', component.includes('selectedSessionId && session.status === \'in_progress\''), 'cancelled sessions must not receive status or finish commands')
  check('finish-command-template', component.includes('function finishCommand') && component.includes('finishCommand(selectedSession.sessionId)') && component.includes('--evidence-kinds'), 'UI must expose a finish template without inventing evidence values')
  check('redacted-state-export', component.includes("kind: 'caogen.golden-task-local-session-state'") && component.includes("syntheticEvidenceAllowed: false") && component.includes('downloadSessionState'), 'export must be lifecycle-only and explicitly prohibit synthetic evidence')
  check('clipboard-fallback', component.includes('navigator.clipboard') && component.includes("document.execCommand('copy')"), 'command copy must work with a clipboard fallback')
  check('operator-actions', ['export-state', 'copy-report', 'copy-status', 'copy-finish'].every((marker) => component.includes(`data-golden-task-action="${marker}"`)), 'bridge must expose export/report/status/finish actions')
  check('blocked-styling', styles.includes('.golden-task-operator-bridge') && styles.includes('.golden-task-blocked-badge'), 'blocked bridge must have a stable visual treatment')

  const failed = checks.filter((entry) => entry.status === 'failed')
  const report = {
    schemaVersion: 1,
    contract: 'Golden Task renderer to evidence capture bridge',
    status: failed.length ? 'failed' : 'passed',
    summary: `${checks.length - failed.length}/${checks.length}`,
    checks,
    coverage: {
      verified: ['blocked operator bridge', 'report/status/finish command generation', 'redacted lifecycle export', 'clipboard fallback'],
      explicitlyNotVerified: ['real human evidence', 'CLI process invocation from renderer', 'Provider calls']
    },
    generatedAt: new Date().toISOString()
  }
  const output = resolve(root, 'test-results/golden-task-evidence-bridge/latest.json')
  await mkdir(resolve(output, '..'), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (failed.length) throw new Error(failed.map((entry) => `${entry.id}: ${entry.detail}`).join('\n'))
  console.log(`golden task evidence bridge: PASS (${report.summary})`)
  console.log(`report: ${output}`)
}

void main()
