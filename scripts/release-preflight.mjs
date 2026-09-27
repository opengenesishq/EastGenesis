#!/usr/bin/env node

/**
 * Fail-closed preflight for a formal EastGenesis release.
 *
 * This is deliberately separate from the unsigned preview path. A formal
 * macOS build must have a Developer ID identity and notarization credentials
 * before electron-builder is allowed to run, otherwise it is too easy to
 * mistake a local unsigned artifact for a shippable installer.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(process.env.EASTGENESIS_REPO_ROOT || process.cwd())
const packageJson = readJson(path.join(repoRoot, 'package.json'))
const args = parseArgs(process.argv.slice(2))
const outputDir = path.join(repoRoot, 'test-results', 'release-preflight')
const outputPath = path.join(outputDir, 'latest.json')
const checks = []

const report = {
  schemaVersion: 1,
  kind: 'eastgenesis.release-preflight-report',
  status: 'running',
  channel: 'formal',
  platform: args.platform,
  targetArch: args.arch,
  packageVersion: packageJson.version,
  productName: packageJson.productName,
  checks,
  externalBlockers: []
}

function parseArgs(argv) {
  const parsed = { platform: '', arch: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--platform') parsed.platform = argv[++index] || ''
    else if (value === '--arch') parsed.arch = argv[++index] || ''
    else if (value === '--help' || value === '-h') {
      console.log('Usage: node scripts/release-preflight.mjs --platform mac --arch x64|arm64')
      process.exit(0)
    } else throw new Error(`unknown option: ${value}`)
  }
  if (parsed.platform !== 'mac') throw new Error('--platform mac is required')
  if (!['x64', 'arm64'].includes(parsed.arch)) throw new Error('--arch must be x64 or arm64')
  return parsed
}

function readJson(filePath) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')) }
  catch (error) { throw new Error(`cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`) }
}

function check(name, pass, detail, blocker = false) {
  const entry = { name, status: pass ? 'passed' : 'failed', detail: detail || '' }
  checks.push(entry)
  if (!pass && blocker) report.externalBlockers.push({ name, detail: detail || '' })
  console[pass ? 'log' : 'error'](`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}

function commandOutput(command, args) {
  try { return execFileSync(command, args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch { return '' }
}

check('product metadata is EastGenesis', packageJson.productName === 'EastGenesis', `productName=${String(packageJson.productName)}`)
check('electron-updater runtime dependency is declared', Boolean(packageJson.dependencies?.['electron-updater']),
  'package.json must declare electron-updater in dependencies', true)
const publishTarget = Array.isArray(packageJson.build?.publish) ? packageJson.build.publish[0] : null
const expectedPublishTarget = publishTarget?.provider === 'github' &&
  publishTarget.owner === 'opengenesishq' && publishTarget.repo === 'EastGenesis'
check('formal update target is the EastGenesis GitHub repository', expectedPublishTarget,
  publishTarget?.provider === 'github'
    ? `configured target=${publishTarget.owner || '(missing owner)'}/${publishTarget.repo || '(missing repository)'}`
    : 'formal build.publish must use the GitHub provider for opengenesishq/EastGenesis', true)
if (publishTarget?.provider === 'github' && publishTarget.owner && publishTarget.repo) {
  const repository = `${publishTarget.owner}/${publishTarget.repo}`
  const visibleRepository = commandOutput('gh', ['api', `repos/${repository}`, '--jq', '.full_name']).trim()
  check('public EastGenesis release repository is reachable', visibleRepository.toLowerCase() === repository.toLowerCase(),
    visibleRepository ? `resolved repository=${visibleRepository}` : `GitHub repository ${repository} is unavailable; rename the existing repository or create the EastGenesis alias`, true)
}
check('formal mac config requires signing and notarization',
  existsSync(path.join(repoRoot, 'electron-builder.release.cjs')) &&
    /forceCodeSigning:\s*true/.test(readFileSync(path.join(repoRoot, 'electron-builder.release.cjs'), 'utf8')) &&
    /notarize:\s*true/.test(readFileSync(path.join(repoRoot, 'electron-builder.release.cjs'), 'utf8')),
  'electron-builder.release.cjs must keep forceCodeSigning and notarize enabled', true)

if (process.platform !== 'darwin') {
  check('formal mac release runs on macOS', false, `current platform=${process.platform}; run this gate on macOS`, true)
} else {
  const identities = commandOutput('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'])
  const hasDeveloperId = /Developer ID Application:/m.test(identities)
  check('Developer ID Application identity is available', hasDeveloperId,
    hasDeveloperId ? 'identity discovered' : 'Apple Developer ID certificate not found; obtain/install one before formal release', true)

  const appleApiKey = process.env.APPLE_API_KEY || process.env.API_KEY_PATH
  const appleApiKeyId = process.env.APPLE_API_KEY_ID
  const appleApiIssuer = process.env.APPLE_API_ISSUER
  const hasNotaryCredentials = Boolean(appleApiKey && appleApiKeyId && appleApiIssuer)
  check('notarization credentials are available', hasNotaryCredentials,
    hasNotaryCredentials ? 'App Store Connect API key variables discovered' : 'set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER for notarization', true)
}

const dirty = commandOutput('git', ['status', '--porcelain=v1', '--untracked-files=all']).trim()
const allowDirty = process.env.EASTGENESIS_RELEASE_PREFLIGHT_ALLOW_DIRTY === '1'
check('release worktree is clean', !dirty || allowDirty,
  !dirty ? 'clean' : allowDirty ? 'dirty allowed by explicit EASTGENESIS_RELEASE_PREFLIGHT_ALLOW_DIRTY=1' : 'commit or stash changes before creating a formal release', !allowDirty)

report.status = checks.every((item) => item.status === 'passed') ? 'passed' : 'blocked'
report.generatedAt = new Date().toISOString()
mkdirSync(outputDir, { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`release preflight: ${report.status}`)
console.log(`report: ${outputPath}`)
if (report.status !== 'passed') process.exitCode = 1
