import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// This suite establishes local integration evidence. Live-provider quality and
// release readiness remain separate acceptance requirements.
const stages = [
  ['types', 'typecheck'],
  ['standards', 'test:coding-standards:required'],
  ['routing-policy-contract', 'test:routing-policy-contract'],
  ['routing-settings-core', 'test:routing-settings-core'],
  ['routing-settings-persistence', 'test:routing-settings-persistence'],
  ['routing-policy-evaluator', 'test:routing-policy-evaluator'],
  ['routing-rule-service', 'test:routing-rule-service'],
  ['routing-rule-ui', 'test:routing-rule-ui'],
  ['routing-constraints', 'test:model-route-constraints'],
  ['runtime-routing', 'test:session-runtime-routing'],
  ['native-recovery-eligibility', 'test:native-recovery-eligibility'],
  ['native-recovery-scope', 'test:native-recovery-scope'],
  ['runtime-continuation', 'test:session-runtime-continuation'],
  ['request-budget', 'test:request-budget'],
  ['assistant-search-evidence', 'test:assistant-search:required'],
  ['personal-submission', 'test:personal-task-submission'],
  ['personal-client', 'test:personal-task-submission-client'],
  ['personal-restart', 'test:personal-task-restart'],
  ['personal-plan-recovery', 'test:personal-task-plan-recovery'],
  ['session-entrypoints', 'test:session-entrypoint-ipc'],
  ['office-revision', 'test:office-revision'],
  ['office-revision-ui-contract', 'test:office-revision-ui-contract'],
  ['media-agent-tools', 'test:media-agent-tools'],
  ['business-registry', 'test:business-line-registry'],
  ['business-navigation', 'test:business-line-navigation'],
  ['business-ownership', 'test:business-line-canonical'],
  ['provider-onboarding', 'test:provider-onboarding-policy'],
  ['media-routing', 'test:media-routing'],
  ['media-transport', 'test:media-transport-routing'],
  ['media-reconciliation', 'test:media-reconciliation-lease'],
  ['media-cancel-reconciliation', 'test:media-cancel-reconciliation'],
  ['storyboard', 'test:video-storyboard'],
  ['office-projection', 'test:office-operational-actors'],
  ['control-room-workitem-navigation', 'test:control-room-workitem-navigation:required'],
  ['office-actions', 'test:office-actions'],
  ['office-label-layout', 'test:office-task-label-layout'],
  ['ming-geometry', 'test:ming-academy-geometry'],
  ['office-resource-cache', 'test:office-resource-cache'],
  ['office-operation-refresh', 'test:office-operation-refresh'],
  ['office-quality-policy', 'test:office-quality-policy'],
  ['build', 'build'],
  ['business-ui', 'test:business-line-ui'],
  ['business-creation-ui', 'test:business-creation-ui'],
  ['provider-ui', 'test:provider-onboarding-ui'],
  ['project-lifecycle-ui', 'test:project-lifecycle-ui'],
  ['media-ui', 'test:media-routing:e2e'],
  ['media-agent-ui', 'test:media-agent:e2e'],
  ['storyboard-ui', 'test:video-storyboard:e2e'],
  ['assistant-office-ui', 'test:assistant-office-ui'],
  ['office-command-ui', 'test:office-command-ui'],
  ['office-archive-index-ui', 'test:office-archive-index-ui'],
  ['office-palace-navigation', 'test:office-palace-navigation'],
  ['office-ui', 'test:office-operational-ui'],
  ['office-labels-ui', 'test:office-task-labels-ui'],
  ['office-session-actions-ui', 'test:office-session-actions-ui'],
  ['ming-capacity', 'test:ming-academy-capacity']
]

const root = process.cwd()
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const output = path.join(root, 'test-results/product-foundation')
const runDir = path.join(output, runId)
mkdirSync(runDir, { recursive: true })
const report = { runId, status: 'running', startedAt: new Date().toISOString(),
  source: sourceFingerprint(), stages: [], scope: 'isolated local and mocked-provider integration',
  excluded: ['live-provider output quality', 'competitor user comparison', 'signed release and upgrade qualification'] }
writeReport()
for (const [name, script] of stages) {
  console.log(`START ${name}: npm run ${script}`)
  const result = await runStage(name, script)
  report.stages.push(result)
  console.log(`${result.status.toUpperCase()} ${name} (${Math.round(result.elapsedMs / 1000)}s)`)
  writeReport()
  if (result.status !== 'pass') break
}
report.endedAt = new Date().toISOString()
report.finalSource = sourceFingerprint()
report.sourceChangedDuringRun = report.source.sha256 !== report.finalSource.sha256
report.status = report.stages.length === stages.length && report.stages.every((item) => item.status === 'pass')
  ? (report.sourceChangedDuringRun ? 'stale' : 'pass') : 'fail'
writeReport()
console.log(`Product foundation: ${report.status}; ${path.join(runDir, 'report.json')}`)
if (report.status !== 'pass') process.exitCode = 1

function sourceFingerprint() {
  const names = [...new Set(execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root }).toString().split('\0'))]
    .filter((name) => /^(src\/|scripts\/|package(?:-lock)?\.json$|tsconfig.*\.json$|electron\.vite\.config\.)/.test(name)).sort()
  const digest = createHash('sha256')
  let files = 0
  for (const name of names) {
    try { digest.update(name).update('\0').update(readFileSync(path.join(root, name))).update('\0'); files++ }
    catch (error) { if (error.code !== 'ENOENT') throw error; digest.update(`deleted:${name}\0`) }
  }
  return { sha256: digest.digest('hex'), files, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim() }
}

function runStage(name, script) {
  const started = Date.now()
  // Recovery cases boot isolated real runtimes; the measured 36-case run took 645s.
  const timeoutMs = name === 'native-recovery-scope' ? 900_000 : 300_000
  const logFile = path.join(runDir, `${name}.log`)
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], {
      cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
      detached: process.platform !== 'win32'
    })
    const chunks = []
    let timedOut = false, finished = false, killTimer
    child.stdout.on('data', (data) => chunks.push(data))
    child.stderr.on('data', (data) => chunks.push(data))
    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
      else {
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
        killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }, 5000)
      }
    }, timeoutMs)
    const finish = (exitCode, error) => {
      if (finished) return
      finished = true; clearTimeout(timer); clearTimeout(killTimer)
      if (error) chunks.push(Buffer.from(String(error)))
      writeFileSync(logFile, Buffer.concat(chunks))
      resolve({ name, script, status: exitCode === 0 && !timedOut ? 'pass' : 'fail', exitCode,
        timedOut, timeoutMs, elapsedMs: Date.now() - started, log: logFile, ...(error ? { error: String(error) } : {}) })
    }
    child.once('error', (error) => finish(null, error))
    child.once('close', (code) => finish(code))
  })
}

function writeReport() {
  writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(path.join(output, 'latest.json'), JSON.stringify(report, null, 2))
}
