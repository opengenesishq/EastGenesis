#!/usr/bin/env node

import { mkdtempSync, readFileSync, readdirSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const harness = path.join(repoRoot, 'scripts', 'golden-task-evidence-capture.mjs')
const sourceManifest = path.join(repoRoot, 'GOLDEN-USER-TASKS', 'manifest.json')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'caogen-golden-evidence-harness-'))
const evidenceRoot = path.join(tempRoot, 'evidence')
const before = path.join(tempRoot, 'before.txt')
const firstUseful = path.join(tempRoot, 'first-useful.txt')
const notes = path.join(tempRoot, 'notes.txt')
const after = path.join(tempRoot, 'after.txt')
const checks = []

try {
  writeFileSync(path.join(tempRoot, 'manifest.json'), readFileSync(sourceManifest))
  writeFileSync(before, 'redacted input boundary and build version')
  writeFileSync(firstUseful, 'redacted first useful result observation')
  writeFileSync(notes, 'redacted observation summary')
  writeFileSync(after, 'redacted after-task outcome and blocker summary')

  const started = run(['start', '--root', tempRoot, '--task', 'golden-code-change', '--participant', 'redacted-harness-check', '--consent', 'true', '--version', 'harness-check', '--before-summary-file', before])
  const startPayload = JSON.parse(started.stdout)
  const sessionId = startPayload.sessionId
  check('start creates a golden session id', /^golden-[0-9a-f-]+$/.test(sessionId))
  const pendingPath = path.join(evidenceRoot, 'in-progress', `${sessionId}.json`)
  check('start writes only in-progress state', existsSync(pendingPath) && listJson(evidenceRoot).length === 0)

  run(['mark-first-useful', '--root', tempRoot, '--session', sessionId, '--first-useful-summary-file', firstUseful])
  const pending = JSON.parse(readFileSync(pendingPath, 'utf8'))
  check('first useful mark stores monotonic timestamp', /^\d+$/.test(pending.capture?.monotonic?.firstUsefulNs ?? ''))

  const rejectedFinish = run(['finish', '--root', tempRoot, '--session', sessionId, '--completed', 'true', '--evidence-kinds', 'plan,diff,test,review', '--context-copy-count', '0', '--evidence-complete', 'true', '--recovery-attempted', 'false', '--after-summary-file', after], false)
  check('finish refuses missing notes instead of inventing evidence', rejectedFinish.status !== 0 && listJson(evidenceRoot).length === 0)

  run(['cancel', '--root', tempRoot, '--session', sessionId])
  check('cancel removes the pending session', !existsSync(pendingPath) && listJson(evidenceRoot).length === 0)
  const report = { schemaVersion: 1, kind: 'caogen.golden-task-evidence-harness-report', status: checks.every((item) => item.status === 'passed') ? 'passed' : 'failed', checks }
  const reportRoot = path.join(repoRoot, 'test-results', 'golden-task-evidence-harness')
  const reportPath = path.join(reportRoot, 'latest.json')
  mkdirSync(reportRoot, { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  if (report.status !== 'passed') process.exitCode = 1
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function run(args, mustPass = true) {
  const result = spawnSync(process.execPath, [harness, ...args], { encoding: 'utf8' })
  if (mustPass && result.status !== 0) throw new Error(`harness command failed: ${args.join(' ')}\n${result.stderr}`)
  return result
}

function listJson(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
}

function check(name, passed) {
  checks.push({ name, status: passed ? 'passed' : 'failed' })
}
