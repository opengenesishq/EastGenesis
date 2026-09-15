import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const nav = readFileSync(resolve(root, 'src/renderer/src/components/WorkOsPrimaryNav.tsx'), 'utf8')
const sidebar = readFileSync(resolve(root, 'src/renderer/src/components/Sidebar.tsx'), 'utf8')
const appList = readFileSync(resolve(root, 'src/renderer/src/components/AppListView.tsx'), 'utf8')
const studio = readFileSync(resolve(root, 'src/renderer/src/components/studio/StudioView.tsx'), 'utf8')
const contract = readFileSync(resolve(root, 'src/renderer/src/components/work-os-navigation.ts'), 'utf8')
const styles = readFileSync(resolve(root, 'src/renderer/src/styles.css'), 'utf8')

const checks: Array<{ id: string; status: 'passed'; detail: string }> = []
function check(id: string, condition: boolean, detail: string): void {
  assert(condition, detail)
  checks.push({ id, status: 'passed', detail })
}

check('six-target-contract', /'inbox'.*'projects'.*'runs'.*'review'.*'library'.*'settings'/us.test(nav), 'Work OS nav exposes all six 0913 targets')
check('bilingual-labels', nav.includes("inbox: { zh: '工作收件箱', en: 'Work Inbox' }") && nav.includes("settings: { zh: '设置', en: 'Settings' }"), 'Work OS targets have Chinese and English labels')
check('accessible-nav', nav.includes('aria-label={zh ? \'工作系统导航\' : \'Work OS navigation\'}') && nav.includes('aria-current'), 'Navigation exposes an accessible landmark and current page')
check('sidebar-mounted', sidebar.includes('<WorkOsPrimaryNav') && sidebar.includes('navigateWorkOs'), 'Sidebar mounts the product-level navigation')
check('settings-boundary', sidebar.includes("if (target === 'settings')") && sidebar.includes('setShowSettings(true)'), 'Settings remains an explicit settings surface')
check('surface-routing', appList.includes('WORK_OS_NAVIGATION_EVENT') && appList.includes("target === 'runs' || target === 'review'"), 'Runs and Review route to the existing result surface')
check('lazy-studio-routing', studio.includes('takeStudioSectionNavigation') && studio.includes('STUDIO_SECTION_NAVIGATION_EVENT'), 'Lazy Studio mount consumes queued section navigation')
check('collapsed-sidebar', styles.includes('.sidebar-collapsed .work-os-primary-nav'), 'Collapsed sidebar hides the Work OS navigation')

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

