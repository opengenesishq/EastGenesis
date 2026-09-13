#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildAcceptanceMap } from './lib/product-acceptance-map.mjs'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'product-1.0-acceptance-map')
const reportDir = path.join(reportRoot, runId)
const packageJson = readJson(path.join(repoRoot, 'package.json'))
const acceptanceMap = buildAcceptanceMap({
  prdMarkdown: readFileSync(path.join(repoRoot, 'docs', 'PRODUCT-REQUIREMENTS.md'), 'utf8'),
  matrixMarkdown: readFileSync(path.join(repoRoot, 'docs', '1.0-ACCEPTANCE-MATRIX.md'), 'utf8'),
  packageScripts: packageJson.scripts ?? {},
  expectedCounts: { P0: 65, P1: 38 }
})
const git = readGitState()
const releaseBindingFailures = [
  ...(!git.commit ? ['release commit is unresolved'] : []),
  ...(!git.worktreeClean ? ['worktree is not clean'] : [])
]
const structuralStatus = acceptanceMap.structuralFailures.length === 0 ? 'passed' : 'failed'
const closureStatus = structuralStatus === 'passed' &&
  acceptanceMap.closureFailures.length === 0 &&
  releaseBindingFailures.length === 0
  ? 'passed'
  : 'failed'
const report = {
  schemaVersion: 1,
  status: required ? closureStatus : structuralStatus,
  structuralStatus,
  closureStatus,
  required,
  requirement: required ? 'required' : 'structural',
  runId,
  packageVersion: packageJson.version,
  git,
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version
  },
  source: 'docs/PRODUCT-REQUIREMENTS.md',
  matrix: 'docs/1.0-ACCEPTANCE-MATRIX.md',
  summary: acceptanceMap.summary,
  structuralFailures: acceptanceMap.structuralFailures,
  closureFailures: acceptanceMap.closureFailures,
  releaseBindingFailures,
  unexpectedMatrixIds: acceptanceMap.unexpectedMatrixIds,
  entries: acceptanceMap.entries
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({
  status: report.status,
  structuralStatus,
  closureStatus,
  required,
  summary: report.summary,
  structuralFailures: report.structuralFailures,
  closureFailureCount: report.closureFailures.length,
  releaseBindingFailures,
  reportDir
}, null, 2))
if (report.status !== 'passed') process.exitCode = 1

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function readGitState() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const porcelain = execFileSync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    ).trim()
    return { commit, worktreeClean: porcelain.length === 0 }
  } catch {
    return { commit: '', worktreeClean: false }
  }
}
