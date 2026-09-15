import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = path.join(repoRoot, 'PRODUCT-LAUNCH-FIXTURE', 'manifest.json')
const reportRoot = path.join(repoRoot, 'test-results', 'product-launch-fixture')
const manifest = JSON.parse(readFileSync(fixturePath, 'utf8'))
const checks = []

check('schema version is supported', manifest.schemaVersion === 1)
check('fixture kind is canonical', manifest.kind === 'caogen.product-launch-fixture')
check('fixture has stable identity', manifest.id === 'product-launch-v2')
check('default business line is 产品发布府', manifest.businessLine === '产品发布府')
check('golden goal is present', manifest.title === '本周上线一个产品' && typeof manifest.goal?.statement === 'string')
check('goal has constraints and deliverables', nonEmpty(manifest.goal?.constraints) && nonEmpty(manifest.goal?.deliverables))
check('at least four launch roles are declared', Array.isArray(manifest.roles) && manifest.roles.length >= 4)
check('expected WorkItems are declared', Array.isArray(manifest.expectedWorkItems) && manifest.expectedWorkItems.length >= 4)
check('external side effects require approval', manifest.externalSideEffects === 'approval_required')
check('fixture contains no credential-shaped values', !JSON.stringify(manifest).match(/(?:api[_-]?key|access[_-]?token|secret|private key|bearer\s)/i))

const report = {
  schemaVersion: 1,
  kind: 'caogen.product-launch-fixture-report',
  generatedAt: new Date().toISOString(),
  fixture: {
    path: path.relative(repoRoot, fixturePath),
    id: manifest.id,
    digest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
  },
  status: checks.every((item) => item.status === 'passed') ? 'passed' : 'failed',
  checks,
  summary: {
    passed: checks.filter((item) => item.status === 'passed').length,
    total: checks.length
  }
}

mkdirSync(reportRoot, { recursive: true })
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ ...report, reportPath: path.join(reportRoot, 'latest.json') }, null, 2))
if (report.status !== 'passed') process.exitCode = 1

function check(name, passed) {
  checks.push({ name, status: passed ? 'passed' : 'failed' })
}

function nonEmpty(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim())
}
