#!/usr/bin/env node

/** Contract test for the human-session organizer. It uses a temporary fixture
 * and cancels/cleans every session; no repository evidence is created. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runner = path.join(repoRoot, 'scripts', 'golden-task-session-runner.mjs')
const sourceManifest = path.join(repoRoot, 'GOLDEN-USER-TASKS', 'manifest.json')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'caogen-golden-session-runner-'))
const evidenceRoot = path.join(tempRoot, 'evidence')
const before = path.join(tempRoot, 'before.txt')
const firstUseful = path.join(tempRoot, 'first-useful.txt')
const notes = path.join(tempRoot, 'notes.txt')
const after = path.join(tempRoot, 'after.txt')
const credentialSummary = path.join(tempRoot, 'credential.txt')
const checks = []

try {
  writeFileSync(path.join(tempRoot, 'manifest.json'), readFileSync(sourceManifest))
  writeFileSync(before, 'redacted input boundary')
  writeFileSync(firstUseful, 'redacted first useful observation')
  writeFileSync(notes, 'redacted result observation')
  writeFileSync(after, 'redacted after-task outcome')
  writeFileSync(credentialSummary, 'redacted api_key must never be captured')

  const listed = run(['list'])
  const listPayload = JSON.parse(listed.stdout)
  check('list exposes all five manifest tasks', listPayload.status === 'ready_for_human_test' && listPayload.tasks?.length === 5)
  check('list preserves real-user and synthetic policy', listPayload.measurementPolicy?.realUsersOnly === true && listPayload.measurementPolicy?.syntheticEvidenceAllowed === false)
  check('list exposes required evidence kinds', listPayload.tasks?.every((task) => Array.isArray(task.requiredEvidenceKinds) && task.requiredEvidenceKinds.length > 0))

  const refusedConsent = run(['start', '--task', 'golden-code-change', '--participant', 'redacted-runner-no-consent', '--consent', 'false', '--version', 'runner-check', '--before-summary-file', before], false)
  check('start rejects absent explicit consent', refusedConsent.status !== 0 && listJson(evidenceRoot).length === 0)
  const refusedCredential = run(['start', '--task', 'golden-code-change', '--participant', 'redacted-runner-secret', '--consent', 'true', '--version', 'runner-check', '--before-summary-file', credentialSummary], false)
  check('start rejects credential-shaped summaries', refusedCredential.status !== 0 && listJson(evidenceRoot).length === 0)

  const started = run(['start', '--task', 'golden-code-change', '--participant', 'redacted-runner-check', '--consent', 'true', '--version', 'runner-check', '--before-summary-file', before])
  const startPayload = JSON.parse(started.stdout)
  const sessionId = startPayload.sessionId
  check('start returns a generated session id', /^golden-[0-9a-f-]+$/.test(sessionId))
  const pendingPath = path.join(evidenceRoot, 'in-progress', `${sessionId}.json`)
  check('start creates only in-progress state', existsSync(pendingPath) && listJson(evidenceRoot).length === 0)

  const status = JSON.parse(run(['status', '--session', sessionId]).stdout)
  check('status is redacted and marks session in progress', status.status === 'in_progress' && status.synthetic === false && status.consent === true && status.firstUsefulMarked === false && !('beforeSummary' in status))

  run(['mark-first-useful', '--session', sessionId, '--first-useful-summary-file', firstUseful])
  const markedStatus = JSON.parse(run(['status', '--session', sessionId]).stdout)
  check('mark-first-useful updates status without exposing summaries', markedStatus.firstUsefulMarked === true && typeof markedStatus.firstUsefulAt === 'string' && !('firstUsefulSummary' in markedStatus))

  const missingEvidenceKind = run(['finish', '--session', sessionId, '--completed', 'true', '--evidence-kinds', 'plan,diff,test', '--context-copy-count', '0', '--evidence-complete', 'true', '--recovery-attempted', 'false', '--notes-file', notes, '--after-summary-file', after], false)
  check('finish rejects missing required evidenceKinds', missingEvidenceKind.status !== 0 && listJson(evidenceRoot).length === 0 && existsSync(pendingPath))

  run(['finish', '--session', sessionId, '--completed', 'true', '--evidence-kinds', 'plan,diff,test,review', '--context-copy-count', '0', '--evidence-complete', 'true', '--recovery-attempted', 'false', '--notes-file', notes, '--after-summary-file', after])
  const finalFiles = listJson(evidenceRoot)
  check('finish promotes exactly one human evidence record', finalFiles.length === 1 && finalFiles[0].name.startsWith('golden-code-change-redacted-runner-check-'))
  const record = JSON.parse(readFileSync(path.join(evidenceRoot, finalFiles[0].name), 'utf8'))
  check('finished record preserves consent, redaction and monotonic timing', record.consent === true && record.synthetic === false && record.evidenceOrigin === 'human-test' && record.timing?.clock === 'monotonic' && record.capture?.monotonic?.startedNs)
  check('finished record preserves required evidence kinds', ['plan', 'diff', 'test', 'review'].every((kind) => record.evidenceKinds.includes(kind)))

  const second = run(['start', '--task', 'golden-research-report', '--participant', 'redacted-runner-cancel', '--consent', 'true', '--version', 'runner-check', '--before-summary-file', before])
  const secondId = JSON.parse(second.stdout).sessionId
  run(['cancel', '--session', secondId])
  check('cancel removes pending state and leaves no synthetic record', !existsSync(path.join(evidenceRoot, 'in-progress', `${secondId}.json`)) && listJson(evidenceRoot).length === 1)

  const report = { schemaVersion: 1, kind: 'caogen.golden-task-session-runner-report', status: checks.every((item) => item.status === 'passed') ? 'passed' : 'failed', checks }
  const reportRoot = path.join(repoRoot, 'test-results', 'golden-task-session-runner')
  const reportPath = path.join(reportRoot, 'latest.json')
  mkdirSync(reportRoot, { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  if (report.status !== 'passed') process.exitCode = 1
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function run(args, mustPass = true) {
  const result = spawnSync(process.execPath, [runner, ...args, '--root', tempRoot], { cwd: repoRoot, encoding: 'utf8' })
  if (mustPass && result.status !== 0) throw new Error(`runner command failed: ${args.join(' ')}\n${result.stderr}`)
  return result
}

function listJson(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
}

function check(name, passed) {
  checks.push({ name, status: passed ? 'passed' : 'failed' })
}
