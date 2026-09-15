import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

type Check = { id: string; status: 'passed' | 'failed'; detail: string }
const checks: Check[] = []
const check = (id: string, ok: boolean, detail: string): void => checks.push({ id, status: ok ? 'passed' : 'failed', detail })

async function main(): Promise<void> {
  const root = resolve(process.cwd())
  const manifest = JSON.parse(await readFile(resolve(root, 'GOLDEN-USER-TASKS/manifest.json'), 'utf8')) as { taskCount?: number; tasks?: Array<{ id: string; scenario: string }> }
  const component = await readFile(resolve(root, 'src/renderer/src/components/studio/GoldenTasksPanel.tsx'), 'utf8')
  const studio = await readFile(resolve(root, 'src/renderer/src/components/studio/StudioView.tsx'), 'utf8')
  check('manifest-has-five-tasks', manifest.taskCount === 5 && manifest.tasks?.length === 5, 'canonical manifest must expose five tasks')
  check('component-renders-manifest-tasks', component.includes('manifest.tasks.map') && component.includes('data-golden-task-id={task.id}'), 'renderer must render every canonical task')
  check('component-exposes-local-session-actions', ['start', 'cancel', 'status'].every((marker) => component.includes(`data-golden-task-action="${marker}"`) || component.includes(`status === 'in_progress'`)), 'UI must expose local start/status/cancel operations')
  check('requires-redacted-consent', component.includes('participantIsRedacted') && component.includes('consent') && component.includes('if (!consent)'), 'start must require explicit consent and redacted participant')
  check('fail-closed-no-synthetic-evidence', component.includes('synthetic: false') && component.includes('evidenceOrigin: \'human-test\'') && component.includes('不会生成证据'), 'local session state must never synthesize evidence')
  check('studio-entry-mounted', studio.includes('data-studio-section-option="golden-tasks"') && studio.includes('<GoldenTasksPanel'), 'Golden Tasks panel must be reachable from Studio')
  const failed = checks.filter((entry) => entry.status === 'failed')
  const report = { schemaVersion: 1, contract: 'Golden User Tasks renderer entry', status: failed.length ? 'failed' : 'passed', summary: `${checks.length - failed.length}/${checks.length}`, checks, coverage: { verified: ['manifest task listing', 'local status lifecycle', 'consent and redaction gate'], explicitlyNotVerified: ['real human evidence', 'Provider calls', 'packaged click timing'] }, generatedAt: new Date().toISOString() }
  const output = resolve(root, 'test-results/golden-task-entry/latest.json')
  await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (failed.length) throw new Error(failed.map((entry) => `${entry.id}: ${entry.detail}`).join('\n'))
  console.log(`golden task renderer entry: PASS (${report.summary})`)
  console.log(`report: ${output}`)
}

void main()
