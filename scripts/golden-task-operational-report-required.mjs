#!/usr/bin/env node

/** Contract test for the host-facing Golden Task status/export report.
 * The fixture is temporary and is removed at the end; no synthetic evidence
 * is accepted by the report, and no evidence payload/summary is exported.
 */

import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runner = path.join(repoRoot, 'scripts', 'golden-task-session-runner.mjs')
const sourceManifest = path.join(repoRoot, 'GOLDEN-USER-TASKS', 'manifest.json')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'caogen-golden-operational-report-'))
const before = path.join(tempRoot, 'before.txt')
const firstUseful = path.join(tempRoot, 'first-useful.txt')
const notes = path.join(tempRoot, 'notes.txt')
const after = path.join(tempRoot, 'after.txt')
const exportPath = path.join(tempRoot, 'operational-report.json')
const checks = []

try {
  writeFileSync(path.join(tempRoot, 'manifest.json'), readFileSync(sourceManifest))
  writeFileSync(before, 'redacted input boundary')
  writeFileSync(firstUseful, 'redacted first useful observation')
  writeFileSync(notes, 'redacted host observation')
  writeFileSync(after, 'redacted after-task outcome')

  const empty = run(['report', '--out', exportPath])
  const emptyReport = JSON.parse(empty.stdout)
  check('empty report is blocked and lists all five tasks', emptyReport.status === 'blocked' && emptyReport.tasks?.length === 5 && emptyReport.tasks.every((task) => task.status === 'blocked'))
  check('report export is durable and contains no summaries', existsSync(exportPath) && !JSON.stringify(emptyReport).includes('beforeSummary') && !JSON.stringify(emptyReport).includes('firstUsefulSummary'))
  const refusedMissingOutPath = run(['report', '--out'], false)
  check('report rejects a missing export path', refusedMissingOutPath.status !== 0)

  const started = run(['start', '--task', 'golden-code-change', '--participant', 'redacted-report-check', '--consent', 'true', '--version', 'report-check', '--before-summary-file', before])
  const sessionId = JSON.parse(started.stdout).sessionId
  const pendingReport = JSON.parse(run(['report']).stdout)
  check('report exposes pending session state only', pendingReport.sessions?.inProgress?.length === 1 && pendingReport.sessions.inProgress[0].sessionId === sessionId && !JSON.stringify(pendingReport).includes('input boundary'))

  mkdirSync(path.join(tempRoot, 'evidence'), { recursive: true })
  const syntheticPath = path.join(tempRoot, 'evidence', 'synthetic.json')
  writeFileSync(syntheticPath, JSON.stringify({ kind: 'caogen.golden-user-task-evidence', taskId: 'golden-code-change', participantId: 'redacted-synthetic', consent: true, synthetic: true, evidenceOrigin: 'human-test' }))
  const refusedSynthetic = run(['report'], false)
  check('report fails closed on synthetic evidence', refusedSynthetic.status !== 0)
  rmSync(syntheticPath, { force: true })

  run(['mark-first-useful', '--session', sessionId, '--first-useful-summary-file', firstUseful])
  run(['finish', '--session', sessionId, '--completed', 'true', '--evidence-kinds', 'plan,diff,test,review', '--context-copy-count', '0', '--evidence-complete', 'true', '--recovery-attempted', 'false', '--notes-file', notes, '--after-summary-file', after])
  const completedReport = JSON.parse(run(['report']).stdout)
  const completedTask = completedReport.tasks.find((task) => task.id === 'golden-code-change')
  check('report includes finished human evidence without raw payloads', completedTask?.evidenceCount === 1 && completedTask.participantCount === 1 && completedTask.status === 'blocked' && completedReport.sessions?.evidence?.[0]?.synthetic === undefined && !JSON.stringify(completedReport).includes('after-task outcome'))

  const report = { schemaVersion: 1, kind: 'caogen.golden-task-operational-report-contract', status: checks.every((item) => item.status === 'passed') ? 'passed' : 'failed', checks }
  const reportRoot = path.join(repoRoot, 'test-results', 'golden-task-operational-report')
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

function check(name, passed) {
  checks.push({ name, status: passed ? 'passed' : 'failed' })
}
