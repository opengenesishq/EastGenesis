import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const root = process.cwd()
const files = {
  panel: join(root, 'src/renderer/src/components/studio/WorkOsRunReviewPanel.tsx'),
  studio: join(root, 'src/renderer/src/components/studio/StudioView.tsx'),
  navigation: join(root, 'src/renderer/src/components/work-os-navigation.ts'),
  app: join(root, 'src/renderer/src/components/AppListView.tsx')
}
const read = (path: string): string => readFileSync(path, 'utf8')
const checks: Array<[string, boolean]> = [
  ['panel exists', read(files.panel).includes('data-work-os-run-review')],
  ['runs use canonical supervisor rows', read(files.panel).includes('listSupervisorRuns()') && read(files.panel).includes("run.origin === 'task_run'" )],
  ['review uses canonical acceptance', read(files.panel).includes('listProjectWorkItems') && read(files.panel).includes("item.acceptance?.status === 'failed'" )],
  ['run opens canonical work item', read(files.panel).includes("requestProjectWorkspaceNavigation(projectId, 'work-item', workItemId)" )],
  ['review opens delivery acceptance', read(files.panel).includes("requestProjectWorkspaceNavigation(projectId, 'delivery', workItemId)" )],
  ['studio accepts runs/review sections', read(files.navigation).includes("'runs' | 'review'") && read(files.studio).includes("target === 'runs' || target === 'review'" )],
  ['global navigation mounts the single conversation workspace',
    read(files.app).includes('data-product-surface="conversation"') &&
    read(files.app).includes('data-experience-mode="assistant"') &&
    read(files.app).includes('experienceMode="assistant"')],
  ['no provider calls', !/provider|fetch\s*\(/iu.test(read(files.panel))]
]
let passed = 0
for (const [label, ok] of checks) { if (ok) { passed++; console.log(`PASS ${label}`) } else console.error(`FAIL ${label}`) }
console.log(`work-os-runs-review: ${passed}/${checks.length}`)
const reportDir = join(root, 'test-results', 'work-os-runs-review')
mkdirSync(reportDir, { recursive: true })
writeFileSync(join(reportDir, 'latest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), passed, total: checks.length, checks: checks.map(([label, ok]) => ({ label, ok })) }, null, 2) + '\n')
if (passed !== checks.length) process.exit(1)
