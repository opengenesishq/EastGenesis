#!/usr/bin/env node
/**
 * Static packaging policy contract.
 *
 * This contract is deliberately independent of a built artifact. It proves that
 * the preview and release builder configurations cannot be confused by naming
 * or signing defaults. It makes no release-readiness claim.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(process.env.CAOGEN_REPO_ROOT || process.cwd())
const outputDir = path.join(repoRoot, 'test-results', 'packaged-preview-policy')
const outputPath = path.join(outputDir, 'latest.json')
const checks = []

function check(name, condition, detail) {
  const status = condition ? 'passed' : 'failed'
  checks.push({ name, status, detail })
  console.log(`[${status === 'passed' ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) throw new Error(detail || name)
}

function source(file) {
  const filePath = path.join(repoRoot, file)
  check(`${file} exists`, existsSync(filePath), existsSync(filePath) ? filePath : `missing ${file}`)
  return readFileSync(filePath, 'utf8')
}

const report = {
  schemaVersion: 1,
  kind: 'caogen.packaged-preview-policy-report',
  status: 'running',
  releaseClaim: false,
  checks
}

try {
  const preview = source('electron-builder.windows-preview.cjs')
  const release = source('electron-builder.release.cjs')
  const smoke = source('scripts/packaged-preview-smoke-required.mjs')

  check('preview disables forced signing', preview.includes('forceCodeSigning: false'))
  check('preview disables publishing', preview.includes('publish: null'))
  check('preview artifact is visibly unsigned', preview.includes('unsigned-preview'))
  check('preview disables certificate discovery', preview.includes("CSC_IDENTITY_AUTO_DISCOVERY = 'false'"))
  check('release requires signing', release.includes('forceCodeSigning: true'))
  check('release requires macOS notarization', release.includes('notarize: true'))
  check('smoke scope is unsigned preview only', smoke.includes("claimScope: 'local-unsigned-preview'"))
  check('smoke rejects release channel', smoke.includes("selectedChannel !== 'unsigned-preview'"))
  check('smoke never claims release readiness', smoke.includes('releaseClaim: false'))
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
  console.error(`[FAIL] packaged preview policy: ${report.error}`)
  process.exitCode = 1
}

mkdirSync(outputDir, { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`packaged preview policy: ${report.status}`)
console.log(`report: ${outputPath}`)
