#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = resolveFixtureRoot(process.argv.slice(2))
const manifestPath = path.join(fixtureRoot, 'manifest.json')
const evidenceRoot = path.join(fixtureRoot, 'evidence')
const reportRoot = path.join(repoRoot, 'test-results', 'golden-task-contract')
const reportPath = path.join(reportRoot, 'latest.json')
const CREDENTIAL_PATTERN = /(?:api[_-]?key|access[_-]?token|secret|private\s+key|bearer\s+[a-z0-9._-]{8,})/i
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const checks = []
const manifest = readJson(manifestPath)

check('manifest schema is supported', manifest?.schemaVersion === 1)
check('manifest kind is canonical', manifest?.kind === 'caogen.golden-user-task-suite')
check('manifest identifies the 0913 plan', manifest?.sourcePlan === 'CAOGEN-FLAGSHIP-RESTRUCTURE-2026-09-13.md')
check('manifest declares five tasks', manifest?.taskCount === 5 && Array.isArray(manifest?.tasks) && manifest.tasks.length === 5)
check('task ids are unique', unique(manifest?.tasks?.map((task) => task.id)).length === 5)
check('measurement policy forbids synthetic evidence', manifest?.measurementPolicy?.realUsersOnly === true && manifest.measurementPolicy.syntheticEvidenceAllowed === false)
check('measurement policy marks missing evidence blocked', manifest?.measurementPolicy?.missingEvidenceStatus === 'blocked')
check('all thresholds are finite', thresholdsAreValid(manifest?.thresholds))
check('every task has an input contract', Array.isArray(manifest?.tasks) && manifest.tasks.every((task) => nonEmpty(task.inputContract)))
check('every task has required deliverables', Array.isArray(manifest?.tasks) && manifest.tasks.every((task) => nonEmpty(task.requiredDeliverables)))
check('every task has acceptance policy', Array.isArray(manifest?.tasks) && manifest.tasks.every((task) => acceptanceIsValid(task.acceptance)))
check('external side effects require approval', Array.isArray(manifest?.tasks) && manifest.tasks.every((task) => task.acceptance.externalSideEffectPolicy === 'approval_required'))
check('fixture contract has no credential-shaped values', !JSON.stringify(manifest).match(CREDENTIAL_PATTERN))

const taskById = new Map((manifest.tasks ?? []).map((task) => [task.id, task]))
const evidenceFiles = listEvidenceFiles(evidenceRoot)
const records = []
const evidenceErrors = []
for (const filePath of evidenceFiles) {
  try {
    const record = readJson(filePath)
    const errors = validateEvidence(record, taskById)
    if (errors.length > 0) {
      evidenceErrors.push({ file: path.relative(repoRoot, filePath), errors })
      continue
    }
    records.push({ ...record, sourceFile: path.relative(repoRoot, filePath) })
  } catch (error) {
    evidenceErrors.push({
      file: path.relative(repoRoot, filePath),
      errors: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`]
    })
  }
}

const taskResults = (manifest.tasks ?? []).map((task) => {
  const taskRecords = records.filter((record) => record.taskId === task.id)
  if (taskRecords.length === 0) {
    return {
      taskId: task.id,
      scenario: task.scenario,
      status: 'blocked',
      reason: 'real_user_evidence_missing',
      observedRecords: 0,
      requiredEvidenceKinds: task.acceptance.requiredEvidenceKinds
    }
  }
  const completed = taskRecords.filter((record) => record.completed)
  const completeEvidence = taskRecords.filter((record) => record.evidenceComplete)
  return {
    taskId: task.id,
    scenario: task.scenario,
    status: completed.length > 0 ? 'partial' : 'blocked',
    reason: completed.length > 0 ? 'task_recorded_but_suite_gate_not_closed' : 'no_completed_real_user_record',
    observedRecords: taskRecords.length,
    completedRecords: completed.length,
    evidenceCompleteRecords: completeEvidence.length,
    requiredEvidenceKinds: task.acceptance.requiredEvidenceKinds
  }
})

const uniqueParticipants = unique(records.map((record) => record.participantId))
const firstUsefulSamples = records.map((record) => record.timing.firstUsefulSeconds)
const firstUsefulSuccesses = records.filter((record) => record.timing.firstUsefulSeconds <= manifest.thresholds.firstUsefulResultMaxSeconds)
const contextCopyFree = records.filter((record) => record.contextCopyCount === 0)
const evidenceComplete = records.filter((record) => record.evidenceComplete)
const recoverySamples = records.filter((record) => record.recovery.attempted === true)
const recoverySuccesses = recoverySamples.filter((record) => record.recovery.succeeded === true)
const metrics = {
  participantCount: uniqueParticipants.length,
  recordCount: records.length,
  firstUsefulResultSuccessRate: rate(firstUsefulSuccesses.length, records.length),
  firstUsefulResultMedianSeconds: median(firstUsefulSamples),
  contextCopyFreeRate: rate(contextCopyFree.length, records.length),
  evidenceCompleteRate: rate(evidenceComplete.length, records.length),
  recoveryAttemptCount: recoverySamples.length,
  recoverySuccessRate: rate(recoverySuccesses.length, recoverySamples.length),
  taskCoverage: rate(taskResults.filter((result) => result.observedRecords > 0).length, taskResults.length),
  completedTaskCoverage: rate(taskResults.filter((result) => result.completedRecords > 0).length, taskResults.length)
}
const participantCoverageByTask = taskResults.map((result) => ({
  taskId: result.taskId,
  participants: unique(records.filter((record) => record.taskId === result.taskId).map((record) => record.participantId)).length,
  required: manifest.thresholds.participantsPerTaskMin
}))

const gateReasons = []
if (!checks.every((item) => item.status === 'passed')) gateReasons.push('fixture_contract_invalid')
if (evidenceFiles.length === 0) gateReasons.push('real_user_evidence_missing')
if (evidenceErrors.length > 0) gateReasons.push('evidence_records_invalid')
if (uniqueParticipants.length < 5) gateReasons.push('fewer_than_five_real_participants_observed')
if (metrics.taskCoverage !== 1) gateReasons.push('not_all_five_tasks_observed')
if (metrics.completedTaskCoverage !== 1) gateReasons.push('not_all_five_tasks_completed')
if (participantCoverageByTask.some((item) => item.participants < item.required)) gateReasons.push('not_enough_participants_per_task')
if (metrics.firstUsefulResultSuccessRate === null || metrics.firstUsefulResultSuccessRate < manifest.thresholds.firstUsefulResultSuccessRateMin) gateReasons.push('first_useful_result_success_rate_below_threshold')
if (metrics.firstUsefulResultMedianSeconds === null || metrics.firstUsefulResultMedianSeconds > manifest.thresholds.firstUsefulResultMedianMaxSeconds) gateReasons.push('first_useful_result_median_above_threshold')
if (metrics.contextCopyFreeRate === null || metrics.contextCopyFreeRate < manifest.thresholds.contextCopyFreeRateMin) gateReasons.push('context_copy_free_rate_below_threshold')
if (metrics.evidenceCompleteRate === null || metrics.evidenceCompleteRate < manifest.thresholds.evidenceCompleteRateMin) gateReasons.push('evidence_complete_rate_below_threshold')
if (metrics.recoverySuccessRate === null || metrics.recoverySuccessRate < manifest.thresholds.recoverySuccessRateMin) gateReasons.push('recovery_success_rate_missing_or_below_threshold')

const contractStatus = checks.every((item) => item.status === 'passed') ? 'passed' : 'failed'
const evidenceStatus = evidenceFiles.length === 0 || evidenceErrors.length > 0 || gateReasons.some((reason) => reason !== 'fixture_contract_invalid') ? 'blocked' : 'passed'
const status = contractStatus === 'failed' ? 'failed' : evidenceStatus === 'passed' ? 'passed' : 'partial'
const report = {
  schemaVersion: 1,
  kind: 'caogen.golden-user-task-contract-report',
  generatedAt: new Date().toISOString(),
  status,
  contractStatus,
  evidenceStatus,
  gate: status === 'passed' ? 'passed' : evidenceFiles.length === 0 ? 'blocked' : 'partial',
  provenance: {
    source: 'GOLDEN-USER-TASKS/manifest.json',
    evidenceSource: 'GOLDEN-USER-TASKS/evidence/*.json',
    syntheticEvidenceGenerated: false,
    realUserIdentityVerified: false,
    note: '本门禁只读取已提交的脱敏记录，不能凭格式证明参与者是真实用户。'
  },
  fixture: {
    path: path.relative(repoRoot, manifestPath),
    id: manifest.id,
    digest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    taskCount: manifest.tasks.length,
    taskIds: manifest.tasks.map((task) => task.id)
  },
  thresholds: manifest.thresholds,
  checks,
  evidenceFiles: evidenceFiles.map((filePath) => path.relative(repoRoot, filePath)),
  evidenceErrors,
  taskResults,
  metrics,
  participantCoverageByTask,
  gateReasons,
  summary: {
    passedChecks: checks.filter((item) => item.status === 'passed').length,
    totalChecks: checks.length,
    observedTasks: taskResults.filter((result) => result.observedRecords > 0).length,
    completedTasks: taskResults.filter((result) => result.completedRecords > 0).length,
    participantCount: uniqueParticipants.length
  }
}

mkdirSync(reportRoot, { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ ...report, reportPath }, null, 2))
if (status !== 'passed') process.exitCode = 1

function check(name, passed) {
  checks.push({ name, status: passed ? 'passed' : 'failed' })
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function listEvidenceFiles(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(root, entry.name))
      .sort()
  } catch {
    return []
  }
}

function validateEvidence(record, taskById) {
  const errors = []
  if (!record || typeof record !== 'object' || Array.isArray(record)) errors.push('record must be an object')
  if (record?.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (record?.kind !== 'caogen.golden-user-task-evidence') errors.push('kind is not canonical')
  if (!taskById.has(record?.taskId)) errors.push('taskId is not declared in the fixture')
  if (record?.synthetic !== false) errors.push('synthetic must be false; synthetic evidence is forbidden')
  if (record?.evidenceOrigin !== 'human-test') errors.push('evidenceOrigin must be human-test')
  if (typeof record?.participantId !== 'string' || !/^redacted-[a-z0-9-]+$/.test(record.participantId)) errors.push('participantId must be a redacted identifier')
  if (record?.consent !== true) errors.push('consent must be true')
  if (!isIsoDate(record?.startedAt) || !isIsoDate(record?.firstUsefulAt) || !isIsoDate(record?.completedAt)) errors.push('startedAt, firstUsefulAt and completedAt must be ISO timestamps')
  const startedAt = Date.parse(record?.startedAt)
  const firstUsefulAt = Date.parse(record?.firstUsefulAt)
  const completedAt = Date.parse(record?.completedAt)
  if ([startedAt, firstUsefulAt, completedAt].every(Number.isFinite) && !(startedAt <= firstUsefulAt && firstUsefulAt <= completedAt)) errors.push('startedAt, firstUsefulAt and completedAt must be ordered')
  if (record?.completed !== true && record?.completed !== false) errors.push('completed must be boolean')
  if (!Number.isFinite(record?.timing?.firstUsefulSeconds) || record.timing.firstUsefulSeconds < 0) errors.push('timing.firstUsefulSeconds must be a non-negative number')
  if (!Number.isFinite(record?.timing?.totalSeconds) || record.timing.totalSeconds < 0) errors.push('timing.totalSeconds must be a non-negative number')
  if (Number.isFinite(record?.timing?.firstUsefulSeconds) && Number.isFinite(record?.timing?.totalSeconds) && record.timing.firstUsefulSeconds > record.timing.totalSeconds) errors.push('firstUsefulSeconds cannot exceed totalSeconds')
  if (!Number.isInteger(record?.contextCopyCount) || record.contextCopyCount < 0) errors.push('contextCopyCount must be a non-negative integer')
  if (typeof record?.evidenceComplete !== 'boolean') errors.push('evidenceComplete must be boolean')
  const task = taskById.get(record?.taskId)
  if (!Array.isArray(record?.evidenceKinds) || record.evidenceKinds.length === 0) errors.push('evidenceKinds must be a non-empty array')
  if (task && Array.isArray(record?.evidenceKinds) && task.acceptance.requiredEvidenceKinds.some((kind) => !record.evidenceKinds.includes(kind))) errors.push('evidenceKinds must include every required evidence kind for the task')
  if (record?.recovery?.attempted !== true && record?.recovery?.attempted !== false) errors.push('recovery.attempted must be boolean')
  if (record?.recovery?.attempted === true && record.recovery.succeeded !== true && record.recovery.succeeded !== false) errors.push('recovery.succeeded must be boolean when recovery was attempted')
  if (record?.recovery?.attempted === false && record.recovery.succeeded !== null) errors.push('recovery.succeeded must be null when recovery was not attempted')
  if (typeof record?.notes !== 'string' || record.notes.trim().length === 0) errors.push('notes must be a non-empty redacted observation summary')
  validateHarnessCapture(record, errors)
  if (JSON.stringify(record).match(CREDENTIAL_PATTERN)) errors.push('credential-shaped value detected')
  if (JSON.stringify(record).match(EMAIL_PATTERN)) errors.push('email-shaped value detected; use a redacted participant id')
  return errors
}

function validateHarnessCapture(record, errors) {
  if (record?.capture === undefined) return
  if (!record.capture || typeof record.capture !== 'object' || Array.isArray(record.capture)) {
    errors.push('capture must be an object when present')
    return
  }
  if (record.capture.harness !== 'golden-task-evidence-capture-v1') errors.push('capture.harness is not canonical')
  if (typeof record.capture.version !== 'string' || record.capture.version.trim().length === 0) errors.push('capture.version must be a non-empty build identifier')
  for (const key of ['beforeSummary', 'afterSummary']) {
    if (typeof record.capture[key] !== 'string' || record.capture[key].trim().length === 0) errors.push(`capture.${key} must be a non-empty redacted summary`)
  }
  const monotonic = record.capture.monotonic
  if (!monotonic || typeof monotonic !== 'object') {
    errors.push('capture.monotonic is required')
    return
  }
  const values = ['startedNs', 'firstUsefulNs', 'completedNs'].map((key) => monotonic[key])
  if (values.some((value) => typeof value !== 'string' || !/^\d+$/.test(value))) {
    errors.push('capture.monotonic values must be decimal strings')
    return
  }
  const [startedNs, firstUsefulNs, completedNs] = values.map((value) => BigInt(value))
  if (!(startedNs <= firstUsefulNs && firstUsefulNs <= completedNs)) errors.push('capture.monotonic values must be ordered')
  if (record.timing?.clock !== 'monotonic') errors.push('timing.clock must be monotonic for harness captures')
  const firstUsefulSeconds = Number((Number(firstUsefulNs - startedNs) / 1e9).toFixed(3))
  const totalSeconds = Number((Number(completedNs - startedNs) / 1e9).toFixed(3))
  if (record.timing?.firstUsefulSeconds !== firstUsefulSeconds) errors.push('timing.firstUsefulSeconds does not match monotonic capture')
  if (record.timing?.totalSeconds !== totalSeconds) errors.push('timing.totalSeconds does not match monotonic capture')
}

function acceptanceIsValid(acceptance) {
  return Array.isArray(acceptance?.requiredEvidenceKinds) && acceptance.requiredEvidenceKinds.length > 0 && acceptance.requiresHumanDecision === true && acceptance.mustPreserveContext === true && acceptance.mustBeRecoverable === true
}

function thresholdsAreValid(thresholds) {
  return thresholds &&
    Number.isInteger(thresholds.participantsPerTaskMin) && thresholds.participantsPerTaskMin > 0 &&
    Number.isFinite(thresholds.firstUsefulResultMaxSeconds) && thresholds.firstUsefulResultMaxSeconds > 0 &&
    Number.isFinite(thresholds.firstUsefulResultMedianMaxSeconds) && thresholds.firstUsefulResultMedianMaxSeconds > 0 &&
    Number.isFinite(thresholds.firstUsefulResultSuccessRateMin) && thresholds.firstUsefulResultSuccessRateMin >= 0 && thresholds.firstUsefulResultSuccessRateMin <= 1 &&
    Number.isFinite(thresholds.contextCopyFreeRateMin) && thresholds.contextCopyFreeRateMin >= 0 && thresholds.contextCopyFreeRateMin <= 1 &&
    Number.isFinite(thresholds.evidenceCompleteRateMin) && thresholds.evidenceCompleteRateMin >= 0 && thresholds.evidenceCompleteRateMin <= 1 &&
    Number.isFinite(thresholds.recoverySuccessRateMin) && thresholds.recoverySuccessRateMin >= 0 && thresholds.recoverySuccessRateMin <= 1
}

function nonEmpty(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim().length > 0)
}

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean))]
}

function rate(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2)) : sorted[middle]
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && value.includes('T')
}

function resolveFixtureRoot(argv) {
  const index = argv.indexOf('--root')
  if (index === -1) return path.join(repoRoot, 'GOLDEN-USER-TASKS')
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error('--root requires a fixture directory')
  return path.resolve(value)
}
