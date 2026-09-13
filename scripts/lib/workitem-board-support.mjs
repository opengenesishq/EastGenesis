import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export function compareBoardOrder(left, right) {
  return (left.boardOrder ?? left.createdAt) - (right.boardOrder ?? right.createdAt) ||
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}

export async function assertRejects(promise, predicate, message) {
  try {
    await promise
  } catch (error) {
    if (predicate(error)) return
    throw new Error(`${message}: unexpected ${safeError(error)}`)
  }
  throw new Error(`${message}: operation unexpectedly succeeded`)
}

export function summarizePerformance(performanceReport, assert) {
  return {
    cold: summarizeSamples(performanceReport.coldSamplesMs, assert),
    warm: summarizeSamples(performanceReport.warmSamplesMs, assert),
    migration: summarizeSamples(performanceReport.migrationSamplesMs, assert)
  }
}

function summarizeSamples(samples, assert) {
  assert(samples.length > 0, 'performance sample set is empty')
  const sorted = [...samples].sort((left, right) => left - right)
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
  return {
    count: sorted.length,
    minMs: sorted[0],
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[p95Index],
    maxMs: sorted[sorted.length - 1],
    samplesMs: samples
  }
}

export function roundMilliseconds(value) {
  return Math.round(value * 10) / 10
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

export function sha256Directory(rootDir, assert) {
  const hash = createHash('sha256')
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name)
      const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join('/')
      assert(!entry.isSymbolicLink(), `source binding cannot follow symbolic link: ${relativePath}`)
      if (entry.isDirectory()) {
        visit(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      const bytes = readFileSync(absolutePath)
      hash.update(relativePath)
      hash.update('\0')
      hash.update(String(bytes.length))
      hash.update('\0')
      hash.update(bytes)
    }
  }
  visit(rootDir)
  return hash.digest('hex')
}

export function createPhaseTiming(name, startedAt = performance.now()) {
  return { name, startedAt, marksMs: {} }
}

export function markPhaseTiming(timing, stage) {
  timing.marksMs[stage] = roundMilliseconds(performance.now() - timing.startedAt)
}

export function completePhaseTiming(timing) {
  const segmentsMs = {}
  let previous = 0
  for (const [stage, elapsed] of Object.entries(timing.marksMs)) {
    segmentsMs[stage] = roundMilliseconds(elapsed - previous)
    previous = elapsed
  }
  return { name: timing.name, marksMs: timing.marksMs, segmentsMs }
}

export function gitState(repoRoot) {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    return {
      commit,
      worktreeClean: status.length === 0,
      statusEntryCount: status ? status.split(/\r?\n/).length : 0,
      statusSha256: createHash('sha256').update(status).digest('hex')
    }
  } catch {
    return { commit: null, worktreeClean: null, statusEntryCount: null, statusSha256: null }
  }
}

export function finalizeSourceBinding({ repoRoot, report, isolatedOutDir, scriptPath, assert }) {
  const finalGit = gitState(repoRoot)
  report.git.finished = finalGit
  report.git.unchangedDuringRun = Boolean(
    report.git.started.commit &&
    finalGit.commit === report.git.started.commit &&
    report.git.started.statusSha256 &&
    finalGit.statusSha256 === report.git.started.statusSha256
  )
  report.sourceBinding.finalScriptSha256 = sha256File(scriptPath)
  report.sourceBinding.finalCopiedBuildSha256 = report.sourceBinding.copiedBuildSha256 && existsSync(isolatedOutDir)
    ? sha256Directory(isolatedOutDir, assert)
    : null
  report.sourceBinding.unchangedDuringRun =
    report.sourceBinding.finalScriptSha256 === report.sourceBinding.scriptSha256 &&
    report.sourceBinding.finalCopiedBuildSha256 === report.sourceBinding.copiedBuildSha256
  assert(report.git.unchangedDuringRun, 'Git commit or working-tree source identity changed during the run')
  assert(report.sourceBinding.unchangedDuringRun, 'harness script or copied build bytes changed during the run')
}

export function safeError(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error)
}

export function assertDeepEqual(actual, expected, message) {
  const difference = firstDifference(expected, actual)
  if (!difference) return
  throw new Error(
    `${message}: first difference at ${difference.path} (${difference.reason}); ` +
    `expected ${formatDifferenceValue(difference.expected)}, got ${formatDifferenceValue(difference.actual)}`
  )
}

function firstDifference(expected, actual, currentPath = '$') {
  if (Object.is(expected, actual)) return null
  if (typeof expected !== typeof actual) return { path: currentPath, reason: 'type mismatch', expected, actual }
  if (expected === null || actual === null || typeof expected !== 'object') {
    return { path: currentPath, reason: 'value mismatch', expected, actual }
  }
  const expectedIsArray = Array.isArray(expected)
  const actualIsArray = Array.isArray(actual)
  if (expectedIsArray !== actualIsArray) return { path: currentPath, reason: 'array/object mismatch', expected, actual }
  if (expectedIsArray) return compareArrays(expected, actual, currentPath)
  return compareObjects(expected, actual, currentPath)
}

function compareArrays(expected, actual, currentPath) {
  if (expected.length !== actual.length) {
    return { path: `${currentPath}.length`, reason: 'array length mismatch', expected: expected.length, actual: actual.length }
  }
  for (let index = 0; index < expected.length; index += 1) {
    const difference = firstDifference(expected[index], actual[index], `${currentPath}[${index}]`)
    if (difference) return difference
  }
  return null
}

function compareObjects(expected, actual, currentPath) {
  const expectedKeys = Object.keys(expected).sort()
  const actualKeys = Object.keys(actual).sort()
  for (const key of expectedKeys) {
    const propertyPath = appendPropertyPath(currentPath, key)
    if (!Object.prototype.hasOwnProperty.call(actual, key)) {
      return { path: propertyPath, reason: 'missing actual field', expected: expected[key], actual: undefined }
    }
    const difference = firstDifference(expected[key], actual[key], propertyPath)
    if (difference) return difference
  }
  for (const key of actualKeys) {
    if (!Object.prototype.hasOwnProperty.call(expected, key)) {
      return { path: appendPropertyPath(currentPath, key), reason: 'unexpected actual field', expected: undefined, actual: actual[key] }
    }
  }
  return null
}

function appendPropertyPath(parent, key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`
}

function formatDifferenceValue(value) {
  const rendered = value === undefined ? 'undefined' : JSON.stringify(value)
  if (rendered === undefined) return String(value)
  return rendered.length > 500 ? `${rendered.slice(0, 497)}...` : rendered
}
