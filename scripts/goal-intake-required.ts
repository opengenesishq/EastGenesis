import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const inbox = readFileSync(resolve(root, 'src/renderer/src/components/studio/WorkInbox.tsx'), 'utf8')
const studio = readFileSync(resolve(root, 'src/renderer/src/components/studio/ProjectWorkspaceStudio.tsx'), 'utf8')
const forms = readFileSync(resolve(root, 'src/renderer/src/components/studio/ProjectWorkspaceStudioForms.tsx'), 'utf8')
const model = readFileSync(resolve(root, 'src/renderer/src/components/studio/projectWorkspaceStudioModel.ts'), 'utf8')
const navigation = readFileSync(resolve(root, 'src/renderer/src/components/studio/projectWorkspaceNavigation.ts'), 'utf8')

const starter = readFileSync(resolve(root, 'src/renderer/src/components/studio/GoalTaskStarter.tsx'), 'utf8')

const checks: { id: string; status: 'passed' | 'failed'; detail?: string }[] = []
function check(id: string, predicate: boolean, detail: string): void {
  checks.push(predicate ? { id, status: 'passed' } : { id, status: 'failed', detail })
}

check('shared-natural-language-starter', inbox.includes('<GoalTaskStarter') && studio.includes('<GoalTaskStarter') && starter.includes('data-goal-task-objective'), 'home and project workspace must use the same natural language starter')
check('optional-project-context', inbox.includes('data-goal-task-project') && inbox.includes('intakeProject?.id'), 'standalone input must not require creating a project')
check('optional-template', starter.includes('<details') && starter.includes('data-goal-task-options'), 'planning templates must be optional advanced settings')
check('durable-draft', starter.includes('readComposerDraft') && starter.includes('writeComposerDraft'), 'goal input must survive view unmounts')
check('work-inbox-create-goal-action', inbox.includes('data-work-inbox-action="create-goal"') && inbox.includes("requestProjectWorkspaceNavigation(project.id, 'goal')"), 'Work Inbox must expose a create-goal action that routes to a project')
check('empty-project-fallback', inbox.includes('openNewProjectWorkspace()'), 'the create-goal action must open project creation when no active project exists')
check('goal-navigation-focus', navigation.includes("| 'goal'") && studio.includes("requestedFocus === 'goal'") && studio.includes("setForm('goal')") && studio.includes("if (requestedFocus === 'goal') return"), 'goal navigation must open and retain the existing GoalCreateForm while the project loads')
for (const field of ['objective', 'constraints', 'acceptance', 'deliverables']) {
  check(`goal-field-${field}`, forms.includes(`data-goal-field="${field}"`) || model.includes(`${field}: string`), `GoalCreateForm must expose ${field}`)
}
check('deliverables-preserved', model.includes('交付物：') && model.includes('splitLines(draft.deliverables)'), 'deliverables must be preserved in the canonical Goal contract')
check('existing-create-action', studio.includes('<GoalCreateForm') && studio.includes('onSubmit={actions.createGoal}'), 'the route must use the existing GoalCreateForm creation action')

const failed = checks.filter((item) => item.status === 'failed')
const report = {
  schemaVersion: 1,
  contract: '2026-09-15 natural language intake and legacy advanced form',
  status: failed.length ? 'failed' : 'passed',
  checks,
  summary: `${checks.length - failed.length}/${checks.length} checks passed`,
  coverage: {
    verified: ['Work Inbox create-goal routing', 'empty-project fallback', 'Goal/constraint/acceptance/deliverables fields', 'existing GoalCreateForm action wiring'],
    explicitlyNotVerified: ['manual Electron click path', 'Provider calls', 'execution or approval']
  },
  generatedAt: new Date().toISOString()
}
const output = resolve(root, 'test-results/goal-intake/latest.json')
mkdirSync(resolve(output, '..'), { recursive: true })
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ ...report, reportPath: output }, null, 2))
if (failed.length) process.exitCode = 1
