import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const inbox = readFileSync(resolve(root, 'src/renderer/src/components/studio/WorkInbox.tsx'), 'utf8')
const navigation = readFileSync(resolve(root, 'src/renderer/src/components/studio/projectWorkspaceNavigation.ts'), 'utf8')
const workspace = readFileSync(resolve(root, 'src/renderer/src/components/studio/ProjectWorkspaceStudio.tsx'), 'utf8')
const delivery = readFileSync(resolve(root, 'src/renderer/src/components/studio/ProjectDeliveryWorkbench.tsx'), 'utf8')
const runDetail = readFileSync(resolve(root, 'src/renderer/src/components/studio/RunDetailPanel.tsx'), 'utf8')

const checks: Array<{ id: string; status: 'passed'; detail: string }> = []
function check(id: string, condition: boolean, detail: string): void {
  assert(condition, detail)
  checks.push({ id, status: 'passed', detail })
}

check('delivery-focus-is-canonical', navigation.includes("'delivery'") && inbox.includes("requestProjectWorkspaceNavigation(project.id, 'delivery', workItemId)"), 'Delivery handoff uses the existing project navigation event and canonical WorkItem identity')
check('ready-lane-entry-visible', inbox.includes("item.lane === 'ready_for_delivery'") && inbox.includes('data-inbox-action="open-delivery"'), 'Only ready-for-delivery Inbox rows expose the delivery entry')
check('project-availability-fail-closed', inbox.includes('disabled={!item.projectAvailable}') && inbox.includes("candidate.status === 'active'"), 'Unavailable or inactive projects cannot be opened from the delivery entry')
check('delivery-section-auto-opens', workspace.includes("initialOpen={requestedFocus === 'delivery'}") && workspace.includes('open={mounted}'), 'Delivery navigation expands the existing progressive Delivery section')
check('delivery-uses-existing-workbench', workspace.includes('<ProjectDeliveryWorkbench') && workspace.includes('requestedWorkItemId={requestedWorkItemId}'), 'Entry lands on the existing ProjectDeliveryWorkbench')
check('acceptance-target-is-canonical', delivery.includes("data-delivery-work-item-id={acceptance.workItemId ?? ''}") && delivery.includes('getProjectDeliveryWorkbench(projectId)'), 'Acceptance focus is resolved from canonical project delivery data')
check('stale-target-does-not-synthesize', delivery.includes('if (!requestedWorkItemId || !projection) return'), 'Missing delivery target leaves the view unchanged instead of fabricating a record')
check('ambiguous-target-does-not-focus', delivery.includes('targets.length !== 1'), 'Duplicate Acceptance target identities do not receive a guessed focus')
check('run-detail-entry-visible', runDetail.includes('onOpenDelivery') && runDetail.includes('data-run-open-delivery'), 'Run detail exposes an explicit Delivery/Acceptance entry')
check('run-detail-identity-required', runDetail.includes('detail.run.projectId && detail.run.workItemId'), 'Run detail delivery navigation requires canonical project and WorkItem identity')
check('no-provider-from-entry', !/window\.agentDesk\.(sendMessage|run|execute|fetchProvider)/u.test(`${inbox}${runDetail}${delivery}`), 'Delivery/Acceptance navigation performs no Provider call')

const report = {
  schemaVersion: 1,
  contract: '0913 Work Inbox and Run detail Delivery/Acceptance entry',
  status: 'passed',
  checks,
  summary: `${checks.length}/${checks.length} checks passed`,
  coverage: {
    verified: ['ready-for-delivery lane entry', 'active project fail-closed guard', 'progressive Delivery section handoff', 'canonical acceptance target focus', 'Run detail handoff', 'Provider boundary'],
    explicitlyNotVerified: ['manual Electron click path', 'real Provider call', 'human timed golden task', 'signed release package']
  },
  generatedAt: new Date().toISOString()
}
const output = resolve(root, 'test-results/delivery-acceptance-inbox-entry/latest.json')
mkdirSync(resolve(output, '..'), { recursive: true })
writeFileSync(output, `${JSON.stringify({ ...report, reportPath: output }, null, 2)}\n`)
console.log(JSON.stringify({ ...report, reportPath: output }, null, 2))
