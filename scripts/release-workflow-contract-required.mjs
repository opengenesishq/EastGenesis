#!/usr/bin/env node
/**
 * Static contract for release scripts and CI entry points.
 *
 * This gate only checks that every referenced local command/file exists and
 * that preview/formal packaging keep their explicit signing/publication
 * boundaries. It never builds, signs, publishes, or claims release evidence.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.env.CAOGEN_REPO_ROOT || process.cwd())
const packageJsonPath = path.join(root, 'package.json')
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
const mode = process.argv.includes('--windows-release')
  ? 'windows-release'
  : process.argv.includes('--windows-preview')
    ? 'windows-preview'
    : 'all'
const checks = []

function check(name, condition, detail = '') {
  assert.equal(condition, true, detail || name)
  checks.push({ name, status: 'passed', detail })
  console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`)
}

function source(relativePath) {
  const filePath = path.join(root, relativePath)
  check(`source exists: ${relativePath}`, existsSync(filePath))
  return readFileSync(filePath, 'utf8')
}

function referencedScripts(text, owner) {
  for (const match of text.matchAll(/npm(?:\.cmd)?\s+run\s+([A-Za-z0-9:_-]+)/g)) {
    const name = match[1]
    check(`${owner} references declared npm script: ${name}`, typeof packageJson.scripts?.[name] === 'string')
  }
  for (const match of text.matchAll(/(?:^|[\s'"&(])(?:node|tsx)\s+(scripts\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|ts|cmd))/g)) {
    const relativePath = match[1]
    check(`${owner} references existing script: ${relativePath}`, existsSync(path.join(root, relativePath)))
  }
}

check('product metadata is EastGenesis', packageJson.productName === 'EastGenesis')
const releaseConfig = source('electron-builder.release.cjs')
const previewConfig = source('electron-builder.windows-preview.cjs')
const releaseWorkflow = source('.github/workflows/windows-unsigned-build.yml')
const officeWorkflow = source('.github/workflows/macos-x64-office-diagnostics.yml')

check('formal Windows build keeps forceCodeSigning', /win:\s*\{[\s\S]*?forceCodeSigning:\s*true/.test(releaseConfig))
check('formal Windows build targets NSIS', /win:\s*\{[\s\S]*?target:\s*\['nsis'\]/.test(releaseConfig))
check('formal Windows build does not publish implicitly', /--publish\s+never/.test(packageJson.scripts?.['dist:win:release:x64'] || ''))
check('Windows preview disables signing', /forceCodeSigning:\s*false/.test(previewConfig))
check('Windows preview disables publication', /publish:\s*null/.test(previewConfig))
check('Windows preview artifact is explicitly unsigned', /unsigned-preview/.test(previewConfig))
check('Windows preview workflow uses preview config', /electron-builder\.windows-preview\.cjs/.test(releaseWorkflow))
check('Windows preview workflow never publishes', /--publish\s+never/.test(releaseWorkflow))
check('Windows preview workflow does not create a GitHub release', !/gh\s+(release|api).*releases|--publish\s+(always|onTag)/i.test(releaseWorkflow))
check('macOS Office workflow uses a declared Office gate', /npm(?:\.cmd)?\s+run\s+test:office-delivery:required/.test(officeWorkflow))

for (const [name, value] of Object.entries(packageJson.scripts || {})) {
  if (typeof value === 'string') referencedScripts(value, `package script ${name}`)
}
for (const relativePath of [
  '.github/workflows/macos-x64-office-diagnostics.yml',
  '.github/workflows/windows-unsigned-build.yml'
]) {
  referencedScripts(source(relativePath), relativePath)
}

const outputDir = path.join(root, 'test-results', 'release-workflow-contract')
mkdirSync(outputDir, { recursive: true })
writeFileSync(path.join(outputDir, 'latest.json'), `${JSON.stringify({
  schemaVersion: 1,
  kind: 'eastgenesis.release-workflow-contract-report',
  status: 'passed',
  mode,
  releaseClaim: false,
  checks
}, null, 2)}\n`)
console.log(`release workflow contract: passed (${checks.length} checks; mode=${mode})`)
