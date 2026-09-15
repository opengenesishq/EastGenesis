#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.cwd())
const store = readFileSync(path.join(root, 'src/renderer/src/store.ts'), 'utf8')
const inbox = readFileSync(path.join(root, 'src/renderer/src/components/studio/WorkInbox.tsx'), 'utf8')
const checks = []
const check = (name, ok) => {
  checks.push({ name, status: ok ? 'passed' : 'failed' })
  if (!ok) throw new Error(name)
}
const report = {
  schemaVersion: 1, kind: 'caogen.recovery-error-propagation-report', status: 'failed',
  checks, providerCalls: false, humanEvidence: false,
  limitations: ['static source regression; production Electron recovery and navigation remain a separate fixture gate']
}
const output = path.join(root, 'test-results/recovery-error-propagation/latest.json')
const writeReport = () => {
  mkdirSync(path.dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
}
writeReport()
try {
  check('recovery catch preserves error state', store.includes('taskSnapshotsError: message'))
  check('recovery catch propagates command failure', /throw err instanceof Error \? err : new Error\(message\)/.test(store))
  check('Work Inbox recovers without activation before refreshing canonical state', /await recoverTaskSnapshot\(snapshotId, \{ activate: false \}\)\s*\n\s*await refresh\(\)/.test(inbox))
  check('Work Inbox does not fabricate recovery completion', !inbox.includes('data-run-recovery-result="completed"'))
  check('recovery activation defaults on and guards navigation and BrowserView changes',
    store.includes('const activate = options?.activate !== false') &&
    store.includes('if (activate && previousId && previousId !== meta.id) closeNativeBrowserView(previousId)') &&
    /\.\.\.\(activate \? \{\s*activeId: meta\.id,\s*showNewSession: false,\s*newSessionProjectId: null,\s*\.\.\.sessionProjectionPatch\(s\.studioSessionNavigationNonce, meta\)/.test(store))
  report.status = 'passed'
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
  console.error(report.error)
} finally {
  writeReport()
}
console.log(`recovery error propagation: ${report.status} (${checks.filter((item) => item.status === 'passed').length}/${checks.length})`)
console.log(`report: ${output}`)
