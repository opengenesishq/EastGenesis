#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'

const repoRoot = process.cwd()
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'caogen-workflow-audit-identity-'))
const reportPath = path.join(repoRoot, 'test-results', 'workflow-audit-identity', 'latest.json')
let report = { schemaVersion: 1, kind: 'caogen.workflow-audit-identity-report', status: 'failed', providerCalls: false, humanEvidence: false }
try {
  const stub = path.join(fixtureRoot, 'electron-stub.ts')
  const bundle = path.join(fixtureRoot, 'audit-identity.cjs')
  writeFileSync(stub, `export const app = { getPath: () => ${JSON.stringify(fixtureRoot)} }\n`)
  buildSync({ entryPoints: [path.join(repoRoot, 'scripts', 'workflow-audit-identity-entry.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', alias: { electron: stub } })
  const output = execFileSync(process.execPath, [bundle, fixtureRoot], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(repoRoot, 'node_modules') }
  })
  const result = JSON.parse(output.trim().split('\n').at(-1))
  report = { ...report, ...result }
  console.log(`Workflow audit identity: PASS (${result.checks.length}/${result.checks.length})\nreport: ${reportPath}`)
} catch (error) {
  report.failure = String(error?.stderr?.toString?.() || error?.message || error)
  console.error(report.failure)
  process.exitCode = 1
} finally {
  report.generatedAt = new Date().toISOString()
  mkdirSync(path.dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  rmSync(fixtureRoot, { recursive: true, force: true })
}
