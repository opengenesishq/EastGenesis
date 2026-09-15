#!/usr/bin/env node

/**
 * Real-user Golden Task session organizer.
 *
 * This command is intentionally a thin, fail-closed front door over the
 * evidence capture helper. It never invents a participant, consent, timing,
 * result, or evidence. `start` only creates an in-progress session after an
 * operator supplies an explicitly redacted participant and before-task
 * summary; only `finish` can promote that session to evidence.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultFixtureRoot = path.join(repoRoot, 'GOLDEN-USER-TASKS')
const capturePath = path.join(repoRoot, 'scripts', 'golden-task-evidence-capture.mjs')
const { command, args } = parseArgs(process.argv.slice(2))
const fixtureRoot = path.resolve(args.root ?? defaultFixtureRoot)
const manifestPath = path.join(fixtureRoot, 'manifest.json')

if (!existsSync(manifestPath)) fail(`找不到 fixture manifest：${fixtureRoot}`)

if (command === undefined || command === 'help') {
  printUsage()
  process.exit(0)
}

if (command === 'list') {
  const manifest = readJson(manifestPath)
  console.log(JSON.stringify({
    status: 'ready_for_human_test',
    fixture: manifest.id,
    sourcePlan: manifest.sourcePlan,
    measurementPolicy: manifest.measurementPolicy,
    thresholds: manifest.thresholds,
    tasks: (manifest.tasks ?? []).map((task) => ({
      id: task.id,
      scenario: task.scenario,
      userInstruction: task.userInstruction,
      userProfile: task.userProfile,
      inputContract: task.inputContract,
      requiredDeliverables: task.requiredDeliverables,
      requiredEvidenceKinds: task.acceptance?.requiredEvidenceKinds ?? []
    }))
  }, null, 2))
  process.exit(0)
}

if (command === 'status') {
  const sessionId = required(args, 'session')
  const pendingPath = pendingPathFor(sessionId)
  if (!existsSync(pendingPath)) fail(`找不到进行中的 session：${sessionId}`)
  const pending = readJson(pendingPath)
  if (pending.sessionId !== sessionId || pending.status !== 'in_progress' || pending.synthetic !== false || pending.consent !== true || pending.evidenceOrigin !== 'human-test') {
    fail('session 元数据不符合真实用户和脱敏证据策略')
  }
  console.log(JSON.stringify({
    status: pending.status,
    sessionId: pending.sessionId,
    taskId: pending.taskId,
    participantId: pending.participantId,
    consent: pending.consent,
    synthetic: pending.synthetic,
    evidenceOrigin: pending.evidenceOrigin,
    startedAt: pending.startedAt,
    firstUsefulAt: pending.firstUsefulAt ?? null,
    version: pending.capture?.version ?? null,
    firstUsefulMarked: Boolean(pending.capture?.monotonic?.firstUsefulNs)
  }, null, 2))
  process.exit(0)
}

if (command === 'report') {
  const report = buildOperationalReport(fixtureRoot)
  if (args.out === 'true') fail('--out 必须提供报告文件路径')
  const outputPath = typeof args.out === 'string' ? path.resolve(args.out) : null
  if (outputPath) writeDurableJson(outputPath, report)
  console.log(JSON.stringify(outputPath ? { ...report, reportPath: outputPath } : report, null, 2))
  process.exit(0)
}

const supportedCaptureCommands = new Set(['start', 'mark-first-useful', 'finish', 'cancel'])
if (!supportedCaptureCommands.has(command)) fail(`未知命令：${command}`)

// The wrapper forwards only explicit flags. The capture helper remains the
// source of truth for consent, summary redaction, monotonic ordering and
// required evidenceKinds validation.
const forwarded = []
for (const [key, value] of Object.entries(args)) {
  if (key === 'root') continue
  forwarded.push(`--${key}`)
  if (value !== 'true') forwarded.push(value)
}
forwarded.push('--root', fixtureRoot)
const child = spawnSync(process.execPath, [capturePath, command, ...forwarded], {
  cwd: repoRoot,
  encoding: 'utf8',
  stdio: ['inherit', 'pipe', 'pipe']
})
if (child.stdout) process.stdout.write(child.stdout)
if (child.stderr) process.stderr.write(child.stderr)
if (child.error) fail(`无法运行 evidence capture：${child.error.message}`)
process.exitCode = child.status ?? 1

function parseArgs(argv) {
  const [first, ...rest] = argv
  const values = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) fail(`参数必须使用 --name：${token}`)
    const key = token.slice(2)
    const next = rest[index + 1]
    if (next && !next.startsWith('--')) {
      values[key] = next
      index += 1
    } else {
      values[key] = 'true'
    }
  }
  return { command: first, args: values }
}

function required(values, key) {
  const value = values[key]
  if (typeof value !== 'string' || value.trim() === '') fail(`缺少 --${key}`)
  return value.trim()
}

function pendingPathFor(sessionId) {
  if (!/^golden-[0-9a-f-]+$/.test(sessionId)) fail('session 必须是 harness 生成的 golden-* 标识')
  return path.join(fixtureRoot, 'evidence', 'in-progress', `${sessionId}.json`)
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    fail(`无法读取 JSON：${filePath} (${error instanceof Error ? error.message : String(error)})`)
  }
}

function printUsage() {
  console.log(`真实用户 Golden Task session runner\n\n` +
    `先查看任务：\n  npm run golden-tasks:session -- list\n\n` +
    `主持人查看当前 session 和证据汇总（只输出脱敏状态）：\n  npm run golden-tasks:session -- report [--out <report.json>]\n\n` +
    `开始一位真实参与者的 session（必须显式同意，摘要必须脱敏）：\n  npm run golden-tasks:session -- start --task <taskId> --participant redacted-... --consent true --version <build> --before-summary-file <file>\n\n` +
    `测试过程中：\n  npm run golden-tasks:session -- status --session <sessionId>\n  npm run golden-tasks:session -- mark-first-useful --session <sessionId> --first-useful-summary-file <file>\n\n` +
    `结束或取消：\n  npm run golden-tasks:session -- finish --session <sessionId> --completed true|false --evidence-kinds <comma-separated> --context-copy-count <n> --evidence-complete true|false --recovery-attempted true|false --notes-file <file> --after-summary-file <file>\n  npm run golden-tasks:session -- cancel --session <sessionId>\n\n` +
    `可在所有参数后加 --root <fixture-dir> 做隔离测试。runner 不创建合成参与者或合成证据。`)
}

function buildOperationalReport(root) {
  const manifest = readJson(path.join(root, 'manifest.json'))
  const tasks = Array.isArray(manifest.tasks) ? manifest.tasks : []
  if (manifest.measurementPolicy?.realUsersOnly !== true || manifest.measurementPolicy?.syntheticEvidenceAllowed !== false) {
    fail('manifest 必须声明 realUsersOnly=true 且 syntheticEvidenceAllowed=false')
  }
  const taskById = new Map()
  for (const task of tasks) {
    if (!task?.id || taskById.has(task.id)) fail('manifest task id 缺失或重复')
    if (!Array.isArray(task.acceptance?.requiredEvidenceKinds) || task.acceptance.requiredEvidenceKinds.length === 0) {
      fail(`任务缺少 requiredEvidenceKinds：${task.id}`)
    }
    taskById.set(task.id, task)
  }

  const pendingDir = path.join(root, 'evidence', 'in-progress')
  const evidenceDir = path.join(root, 'evidence')
  const pending = readJsonFiles(pendingDir)
  const evidence = readJsonFiles(evidenceDir).filter((entry) => entry.name !== 'in-progress')
  const pendingRows = pending.map(({ filePath, value }) => validatePending(value, filePath, taskById))
  const evidenceRows = evidence.map(({ filePath, value }) => validateEvidence(value, filePath, taskById))
  const participantKeys = new Set()
  const duplicateParticipantTaskIds = []
  for (const row of evidenceRows) {
    const key = `${row.taskId}\u0000${row.participantId}`
    if (participantKeys.has(key)) duplicateParticipantTaskIds.push({ taskId: row.taskId, participantId: row.participantId })
    participantKeys.add(key)
  }

  const minimum = Number(manifest.thresholds?.participantsPerTaskMin ?? 0)
  if (!Number.isInteger(minimum) || minimum < 1) fail('manifest participantsPerTaskMin 必须是正整数')
  const taskRows = tasks.map((task) => {
    const taskEvidence = evidenceRows.filter((row) => row.taskId === task.id)
    const taskPending = pendingRows.filter((row) => row.taskId === task.id)
    const participantCount = new Set(taskEvidence.map((row) => row.participantId)).size
    const missingKinds = task.acceptance.requiredEvidenceKinds.filter((kind) => !taskEvidence.some((row) => row.evidenceKinds.includes(kind)))
    const incompleteEvidenceKindsCount = taskEvidence.filter((row) => task.acceptance.requiredEvidenceKinds.some((kind) => !row.evidenceKinds.includes(kind))).length
    const incompleteEvidenceCount = taskEvidence.filter((row) => !row.evidenceComplete).length
    const blockedReasons = []
    if (participantCount < minimum) blockedReasons.push(`participants ${participantCount}/${minimum}`)
    if (missingKinds.length > 0) blockedReasons.push(`evidenceKinds missing: ${missingKinds.join(',')}`)
    if (incompleteEvidenceKindsCount > 0) blockedReasons.push(`evidenceKinds incomplete: ${incompleteEvidenceKindsCount}`)
    if (incompleteEvidenceCount > 0) blockedReasons.push(`evidenceComplete false: ${incompleteEvidenceCount}`)
    return {
      id: task.id,
      scenario: task.scenario,
      requiredEvidenceKinds: task.acceptance.requiredEvidenceKinds,
      inProgressCount: taskPending.length,
      evidenceCount: taskEvidence.length,
      participantCount,
      evidenceCompleteCount: taskEvidence.length - incompleteEvidenceCount,
      incompleteEvidenceCount,
      incompleteEvidenceKindsCount,
      status: blockedReasons.length === 0 ? 'ready_for_review' : 'blocked',
      blockedReasons
    }
  })
  const blockers = []
  if (pendingRows.length > 0) blockers.push(`in-progress sessions: ${pendingRows.length}`)
  if (duplicateParticipantTaskIds.length > 0) blockers.push('duplicate participant/task evidence records')
  for (const row of taskRows) {
    for (const reason of row.blockedReasons) blockers.push(`${row.id}: ${reason}`)
  }
  return {
    schemaVersion: 1,
    kind: 'caogen.golden-task-operational-report',
    status: blockers.length === 0 ? 'ready_for_review' : 'blocked',
    fixture: manifest.id,
    sourcePlan: manifest.sourcePlan,
    generatedAt: new Date().toISOString(),
    policy: {
      realUsersOnly: true,
      syntheticEvidenceAllowed: false,
      retention: manifest.measurementPolicy.retention,
      missingEvidenceStatus: manifest.measurementPolicy.missingEvidenceStatus
    },
    thresholds: manifest.thresholds,
    tasks: taskRows,
    sessions: {
      inProgress: pendingRows,
      evidence: evidenceRows
    },
    duplicateParticipantTaskIds,
    blockers
  }
}

function readJsonFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const filePath = path.join(directory, entry.name)
      return { filePath, name: entry.name, value: readJson(filePath) }
    })
}

function validatePending(value, filePath, taskById) {
  if (value?.kind !== 'caogen.golden-user-task-capture' || value.status !== 'in_progress' || value.synthetic !== false || value.consent !== true || value.evidenceOrigin !== 'human-test') {
    fail(`拒绝非真实人工 pending session：${filePath}`)
  }
  if (!taskById.has(value.taskId) || !/^redacted-[a-z0-9-]+$/.test(value.participantId ?? '') || !/^golden-[0-9a-f-]+$/.test(value.sessionId ?? '')) {
    fail(`pending session 元数据无效：${filePath}`)
  }
  if (!/^\d+$/.test(value.capture?.monotonic?.startedNs ?? '')) fail(`pending session 缺少 monotonic 起点：${filePath}`)
  return {
    sessionId: value.sessionId,
    taskId: value.taskId,
    participantId: value.participantId,
    firstUsefulMarked: Boolean(value.capture?.monotonic?.firstUsefulNs),
    startedAt: value.startedAt ?? null,
    version: value.capture?.version ?? null
  }
}

function validateEvidence(value, filePath, taskById) {
  if (value?.kind !== 'caogen.golden-user-task-evidence' || value.synthetic !== false || value.consent !== true || value.evidenceOrigin !== 'human-test') {
    fail(`拒绝非真实人工 evidence：${filePath}`)
  }
  if (!taskById.has(value.taskId) || !/^redacted-[a-z0-9-]+$/.test(value.participantId ?? '')) fail(`evidence 元数据无效：${filePath}`)
  if (!Array.isArray(value.evidenceKinds) || value.evidenceKinds.length === 0 || value.evidenceKinds.some((kind) => typeof kind !== 'string' || kind.trim() === '') || new Set(value.evidenceKinds).size !== value.evidenceKinds.length) fail(`evidenceKinds 无效：${filePath}`)
  if (value.timing?.clock !== 'monotonic' || !Number.isFinite(value.timing?.totalSeconds) || value.timing.totalSeconds < 0) fail(`evidence timing 无效：${filePath}`)
  if (typeof value.completed !== 'boolean' || typeof value.evidenceComplete !== 'boolean') fail(`evidence 完成状态无效：${filePath}`)
  if (typeof value.recovery?.attempted !== 'boolean' || (value.recovery.attempted && typeof value.recovery.succeeded !== 'boolean')) fail(`evidence recovery 状态无效：${filePath}`)
  return {
    taskId: value.taskId,
    participantId: value.participantId,
    completed: value.completed,
    evidenceComplete: value.evidenceComplete,
    evidenceKinds: [...value.evidenceKinds],
    firstUsefulSeconds: value.timing.firstUsefulSeconds ?? null,
    totalSeconds: value.timing.totalSeconds,
    recoveryAttempted: value.recovery.attempted,
    recoverySucceeded: value.recovery.succeeded ?? null
  }
}

function writeDurableJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporaryPath, filePath)
}

function fail(message) {
  console.error(`golden task session runner: ${message}`)
  process.exit(1)
}
