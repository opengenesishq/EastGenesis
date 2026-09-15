import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const inbox = readFileSync(resolve(root, 'src/renderer/src/components/studio/WorkInbox.tsx'), 'utf8')
const workbench = readFileSync(resolve(root, 'src/renderer/src/components/experience/TaskPlanWorkbench.tsx'), 'utf8')
const checks: Array<{ id: string; status: 'passed'; detail: string }> = []
function check(id: string, condition: boolean, detail: string): void {
  assert(condition, detail)
  checks.push({ id, status: 'passed', detail })
}
check('canonical-session-navigation', inbox.includes('requestTaskPlanNavigation') && inbox.includes('selectSession(run.sessionId)'), 'Inbox navigation uses canonical Run session identity')
check('plan-entry-visible', inbox.includes('localized(\'打开计划\', \'Open plan\')'), 'Inbox exposes an Open plan action')
check('existing-plan-workbench', workbench.includes('approveTaskPlan') && workbench.includes('revokeTaskPlanApproval') && workbench.includes('dispatchApprovedTaskPlan'), 'Open plan lands on the existing approval workbench')
check('approval-is-explicit', workbench.includes('onApproveAndExecute') && workbench.includes('canApprove'), 'Plan approval and execution remain explicit')
check('no-provider-from-inbox', !/window\.agentDesk\.(sendMessage|run|execute|fetchProvider)/u.test(inbox), 'Inbox plan navigation does not call a Provider')
const report = { schemaVersion: 1, contract: '0913 Work Inbox to plan confirmation entry', status: 'passed', checks, summary: `${checks.length}/${checks.length} checks passed`, limitations: ['static renderer contract only', 'does not prove Electron click path', 'does not approve or execute a plan'], generatedAt: new Date().toISOString() }
const output = resolve(root, 'test-results/task-plan-inbox-entry/latest.json')
mkdirSync(resolve(output, '..'), { recursive: true })
writeFileSync(output, `${JSON.stringify({ ...report, reportPath: output }, null, 2)}\n`)
console.log(JSON.stringify({ ...report, reportPath: output }, null, 2))
