import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

async function main(): Promise<void> {
const root = resolve(process.cwd())
const source = await readFile(resolve(root, 'src/renderer/src/components/studio/StudioView.tsx'), 'utf8')
const checks = [
  { id: 'studio-defaults-to-inbox', ok: /useState<StudioSection>\('inbox'\)/u.test(source), detail: 'Studio must open on Work Inbox' },
  { id: 'explicit-project-navigation-preserved', ok: source.includes("setSection('work')") && source.includes('takeProjectWorkspaceNavigation'), detail: 'project navigation must still target work surface' },
  { id: 'inbox-surface-mounted', ok: source.includes('<WorkInbox active={active} />'), detail: 'Work Inbox surface is not mounted' }
]
const failed = checks.filter((check) => !check.ok)
const report = {
  schemaVersion: 1,
  contract: 'V2-013 Work Inbox first surface',
  status: failed.length === 0 ? 'passed' : 'failed',
  summary: `${checks.length - failed.length}/${checks.length} checks passed`,
  checks,
  coverage: { verified: ['default Studio surface is Work Inbox', 'explicit project navigation remains available'], explicitlyNotVerified: ['human packaged click timing'] },
  generatedAt: new Date().toISOString()
}
const output = resolve(root, 'test-results/work-inbox-first-screen/latest.json')
await mkdir(resolve(output, '..'), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
if (failed.length) throw new Error(failed.map((check) => `${check.id}: ${check.detail}`).join('\n'))
console.log(`work inbox first screen: PASS (${report.summary})`)
console.log(`report: ${output}`)
}

void main()
