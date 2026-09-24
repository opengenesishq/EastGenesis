import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const sidebar = readFileSync(resolve(root, 'src/renderer/src/components/Sidebar.tsx'), 'utf8')
const appList = readFileSync(resolve(root, 'src/renderer/src/components/AppListView.tsx'), 'utf8')
const styles = readFileSync(resolve(root, 'src/renderer/src/styles.css'), 'utf8')

const checks: Array<{ id: string; status: 'passed'; detail: string }> = []
function check(id: string, condition: boolean, detail: string): void {
  assert(condition, detail)
  checks.push({ id, status: 'passed', detail })
}

check('work-os-entry-removed', !sidebar.includes('WorkOsPrimaryNav') && !sidebar.includes('navigateWorkOs'), 'Product-level Work OS navigation is removed from the sidebar')
check('assistant-surface', appList.includes('data-product-surface="conversation"') && appList.includes('data-simple-workspace'), 'The app mounts a single assistant conversation surface')
check('no-work-os-markup', !appList.includes('WORK_OS_NAVIGATION_EVENT') && !styles.includes('.work-os-primary-nav'), 'Removed Work OS markup has no active renderer or stylesheet entry')

const report = {
  schemaVersion: 1,
  contract: '0913 Work OS primary navigation',
  status: 'passed',
  checks,
  summary: `${checks.length}/${checks.length} checks passed`,
  limitations: ['static renderer contract only', 'does not prove packaged click timing', 'Runs and Review currently share the existing result projection'],
  generatedAt: new Date().toISOString()
}
const output = resolve(root, 'test-results/work-os-navigation/latest.json')
mkdirSync(resolve(output, '..'), { recursive: true })
writeFileSync(output, `${JSON.stringify({ ...report, reportPath: output }, null, 2)}\n`)
console.log(JSON.stringify({ ...report, reportPath: output }, null, 2))
