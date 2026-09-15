#!/usr/bin/env node

/**
 * Human-run capture helper for the five Golden User Tasks.
 *
 * This tool never creates synthetic participants or fills in outcome values.
 * A tester must start a session, mark the first useful result, and explicitly
 * finish it with redacted before/after summaries and evidence metadata. The
 * monotonic clock values are retained only as opaque strings so a second
 * process can continue the same capture without trusting wall-clock deltas.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultFixtureRoot = path.join(repoRoot, 'GOLDEN-USER-TASKS')
const manifestPath = path.join(defaultFixtureRoot, 'manifest.json')
const CREDENTIAL_PATTERN = /(?:api[_-]?key|access[_-]?token|secret|private\s+key|bearer\s+[a-z0-9._-]{8,})/i
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i

const { command, args } = parseArgs(process.argv.slice(2))
const fixtureRoot = resolveFixtureRoot(args.root)
const inProgressRoot = path.join(fixtureRoot, 'evidence', 'in-progress')
const evidenceRoot = path.join(fixtureRoot, 'evidence')

if (command === 'help' || command === undefined) {
  printUsage()
  process.exit(0)
}

if (command === 'start') {
  const manifest = readJson(path.join(fixtureRoot, 'manifest.json'))
  const taskId = required(args, 'task')
  if (!manifest.tasks?.some((task) => task.id === taskId)) fail(`task 未在 manifest 中声明：${taskId}`)
  const participantId = required(args, 'participant')
  if (!/^redacted-[a-z0-9-]+$/.test(participantId)) fail('participant 必须是 redacted-* 脱敏标识')
  if (args.consent !== 'true') fail('必须显式传入 --consent true')
  const version = required(args, 'version')
  const beforeSummary = readRedactedSummary(args, 'before-summary-file')
  const now = new Date()
  const sessionId = `golden-${randomUUID()}`
  const startedMonotonicNs = process.hrtime.bigint().toString()
  const pending = {
    schemaVersion: 1,
    kind: 'caogen.golden-user-task-capture',
    status: 'in_progress',
    sessionId,
    taskId,
    participantId,
    consent: true,
    synthetic: false,
    evidenceOrigin: 'human-test',
    startedAt: now.toISOString(),
    capture: {
      harness: 'golden-task-evidence-capture-v1',
      version,
      beforeSummary,
      monotonic: { startedNs: startedMonotonicNs }
    }
  }
  mkdirSync(inProgressRoot, { recursive: true })
  const filePath = path.join(inProgressRoot, `${sessionId}.json`)
  writeDurableJson(filePath, pending)
  console.log(JSON.stringify({ status: 'started', sessionId, pendingFile: path.relative(repoRoot, filePath) }, null, 2))
  process.exit(0)
}

if (command === 'mark-first-useful') {
  const pendingPath = findPending(required(args, 'session'))
  const pending = readJson(pendingPath)
  if (pending.status !== 'in_progress') fail('capture session 已经结束或取消')
  if (pending.capture?.monotonic?.firstUsefulNs) fail('first useful result 已经记录；不得覆盖')
  const firstUsefulNs = process.hrtime.bigint().toString()
  if (BigInt(firstUsefulNs) < BigInt(pending.capture?.monotonic?.startedNs ?? '0')) fail('monotonic clock 顺序无效')
  pending.firstUsefulAt = new Date().toISOString()
  pending.capture.monotonic.firstUsefulNs = firstUsefulNs
  if (args['first-useful-summary-file']) pending.capture.firstUsefulSummary = readRedactedSummary(args, 'first-useful-summary-file')
  writeDurableJson(pendingPath, pending)
  console.log(JSON.stringify({ status: 'first_useful_marked', sessionId: pending.sessionId, firstUsefulAt: pending.firstUsefulAt }, null, 2))
  process.exit(0)
}

if (command === 'finish') {
  const sessionId = required(args, 'session')
  const pendingPath = findPending(sessionId)
  const pending = readJson(pendingPath)
  if (pending.status !== 'in_progress') fail('capture session 已经结束或取消')
  if (!pending.capture?.monotonic?.firstUsefulNs || !pending.firstUsefulAt) fail('必须先执行 mark-first-useful')
  const completed = booleanArg(args, 'completed')
  const evidenceComplete = booleanArg(args, 'evidence-complete')
  const contextCopyCount = integerArg(args, 'context-copy-count')
  if (contextCopyCount < 0) fail('context-copy-count 必须不小于 0')
  const evidenceKinds = required(args, 'evidence-kinds').split(',').map((value) => value.trim()).filter(Boolean)
  if (evidenceKinds.length === 0) fail('evidence-kinds 不能为空')
  const manifest = readJson(path.join(fixtureRoot, 'manifest.json'))
  const task = manifest.tasks?.find((candidate) => candidate.id === pending.taskId)
  const missingKinds = (task?.acceptance?.requiredEvidenceKinds ?? []).filter((kind) => !evidenceKinds.includes(kind))
  if (missingKinds.length > 0) fail(`evidence-kinds 缺少任务要求：${missingKinds.join(',')}`)
  const recoveryAttempted = booleanArg(args, 'recovery-attempted')
  const recoverySucceeded = recoveryAttempted ? booleanArg(args, 'recovery-succeeded') : null
  const notes = readRedactedSummary(args, 'notes-file')
  const afterSummary = readRedactedSummary(args, 'after-summary-file')
  const completedMonotonicNs = process.hrtime.bigint().toString()
  const startedNs = BigInt(pending.capture.monotonic.startedNs)
  const firstUsefulNs = BigInt(pending.capture.monotonic.firstUsefulNs)
  const completedNs = BigInt(completedMonotonicNs)
  if (firstUsefulNs < startedNs || completedNs < firstUsefulNs) fail('monotonic clock 顺序无效')
  const completedAt = new Date().toISOString()
  const record = {
    schemaVersion: 1,
    kind: 'caogen.golden-user-task-evidence',
    taskId: pending.taskId,
    participantId: pending.participantId,
    consent: true,
    synthetic: false,
    evidenceOrigin: 'human-test',
    evidenceKinds,
    startedAt: pending.startedAt,
    firstUsefulAt: pending.firstUsefulAt,
    completedAt,
    completed,
    timing: {
      clock: 'monotonic',
      firstUsefulSeconds: secondsBetween(startedNs, firstUsefulNs),
      totalSeconds: secondsBetween(startedNs, completedNs)
    },
    contextCopyCount,
    evidenceComplete,
    recovery: { attempted: recoveryAttempted, succeeded: recoverySucceeded },
    notes,
    capture: {
      harness: 'golden-task-evidence-capture-v1',
      version: pending.capture.version,
      beforeSummary: pending.capture.beforeSummary,
      firstUsefulSummary: pending.capture.firstUsefulSummary ?? null,
      afterSummary,
      monotonic: {
        startedNs: pending.capture.monotonic.startedNs,
        firstUsefulNs: pending.capture.monotonic.firstUsefulNs,
        completedNs: completedMonotonicNs
      }
    }
  }
  mkdirSync(evidenceRoot, { recursive: true })
  const finalPath = path.join(evidenceRoot, `${pending.taskId}-${pending.participantId}-${sessionId}.json`)
  writeDurableJson(finalPath, record)
  rmSync(pendingPath, { force: true })
  console.log(JSON.stringify({ status: 'finished', sessionId, evidenceFile: path.relative(repoRoot, finalPath), timing: record.timing }, null, 2))
  process.exit(0)
}

if (command === 'cancel') {
  const pendingPath = findPending(required(args, 'session'))
  rmSync(pendingPath, { force: true })
  console.log(JSON.stringify({ status: 'cancelled', sessionId: path.basename(pendingPath, '.json') }, null, 2))
  process.exit(0)
}

fail(`未知命令：${command}`)

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

function resolveFixtureRoot(value) {
  const root = value ? path.resolve(value) : defaultFixtureRoot
  if (!existsSync(path.join(root, 'manifest.json'))) fail(`找不到 fixture manifest：${root}`)
  return root
}

function required(values, key) {
  const value = values[key]
  if (typeof value !== 'string' || value.trim() === '') fail(`缺少 --${key}`)
  return value.trim()
}

function booleanArg(values, key) {
  const value = required(values, key)
  if (value !== 'true' && value !== 'false') fail(`--${key} 必须是 true 或 false`)
  return value === 'true'
}

function integerArg(values, key) {
  const value = Number(required(values, key))
  if (!Number.isInteger(value)) fail(`--${key} 必须是整数`)
  return value
}

function readRedactedSummary(values, key) {
  const filePath = path.resolve(required(values, key))
  const value = readFileSync(filePath, 'utf8').trim()
  if (!value) fail(`脱敏摘要不能为空：${filePath}`)
  if (CREDENTIAL_PATTERN.test(value)) fail(`摘要疑似包含凭据：${filePath}`)
  if (EMAIL_PATTERN.test(value)) fail(`摘要疑似包含邮箱：${filePath}`)
  if (value.length > 4000) fail(`摘要超过 4000 字符：${filePath}`)
  return value
}

function findPending(sessionId) {
  if (!/^golden-[0-9a-f-]+$/.test(sessionId)) fail('session 必须是 harness 生成的 golden-* 标识')
  const filePath = path.join(inProgressRoot, `${sessionId}.json`)
  if (!existsSync(filePath)) fail(`找不到进行中的 session：${sessionId}`)
  return filePath
}

function writeDurableJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tempPath, filePath)
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    fail(`无法读取 JSON：${filePath} (${error instanceof Error ? error.message : String(error)})`)
  }
}

function secondsBetween(startNs, endNs) {
  return Number((Number(endNs - startNs) / 1e9).toFixed(3))
}

function printUsage() {
  console.log(`五用户黄金任务证据采集（只接受真实人工测试）\n\n` +
    `开始：\n  node scripts/golden-task-evidence-capture.mjs start --task <taskId> --participant redacted-... --consent true --version <build> --before-summary-file <file>\n` +
    `标记首个有用结果：\n  node scripts/golden-task-evidence-capture.mjs mark-first-useful --session <sessionId> [--first-useful-summary-file <file>]\n` +
    `结束并写入证据：\n  node scripts/golden-task-evidence-capture.mjs finish --session <sessionId> --completed true|false --evidence-kinds kind1,kind2 --context-copy-count <n> --evidence-complete true|false --recovery-attempted true|false [--recovery-succeeded true|false] --notes-file <file> --after-summary-file <file>\n` +
    `取消：\n  node scripts/golden-task-evidence-capture.mjs cancel --session <sessionId>\n\n` +
    `摘要文件必须脱敏；脚本不会生成参与者、耗时或成功率来填空。可用 --root <fixtureRoot> 做临时 fixture 测试。`)
}

function fail(message) {
  console.error(`golden evidence capture: ${message}`)
  process.exit(1)
}
