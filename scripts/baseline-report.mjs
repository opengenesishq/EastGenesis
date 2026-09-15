import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runId = new Date().toISOString().replaceAll(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'baseline')
const reportDir = path.join(reportRoot, runId)
const checks = [
  { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
  { name: 'build', command: 'npm', args: ['run', 'build'] }
]

const report = {
  schemaVersion: 1,
  kind: 'caogen.baseline-report',
  generatedAt: new Date().toISOString(),
  git: gitIdentity(),
  checks: []
}

for (const check of checks) {
  const startedAt = Date.now()
  try {
    const output = execFileSync(check.command, check.args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    report.checks.push({
      ...check,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      output: truncate(output)
    })
  } catch (error) {
    report.checks.push({
      ...check,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      exitCode: error?.status ?? null,
      output: truncate([error?.stdout, error?.stderr].filter(Boolean).join('\n')),
      error: error instanceof Error ? error.message : String(error)
    })
    break
  }
}

report.status = report.checks.every((check) => check.status === 'passed') ? 'passed' : 'failed'
report.summary = {
  passed: report.checks.filter((check) => check.status === 'passed').length,
  total: checks.length
}

mkdirSync(reportDir, { recursive: true })
const serialized = `${JSON.stringify(report, null, 2)}\n`
writeFileSync(path.join(reportDir, 'report.json'), serialized, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), serialized, 'utf8')
console.log(JSON.stringify({ ...report, reportDir }, null, 2))
if (report.status !== 'passed') process.exitCode = 1

function truncate(value, max = 20_000) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text
}

function gitIdentity() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim().length > 0
    return { sha, branch, dirty }
  } catch {
    return { sha: null, branch: null, dirty: null }
  }
}
