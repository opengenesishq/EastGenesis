#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  artifactReportChecks,
  deepEvidenceChecks,
  macUpdateMetadataChecks,
  renderMacUpdateMetadata
} from './lib/release-matrix-evidence.mjs'
import {
  releaseArtifactEvidence,
  releasePlatformArtifactEvidence,
  releasePlatformArtifactNames,
  releasePlatformMatrixChecks
} from './lib/release-platform-matrix.mjs'
import { trustedMacDistributionChecks } from './lib/release-packaging-policy.mjs'

const repoRoot = process.cwd()
const inputRoot = resolvePath(argValue('--input') || 'test-results/release-matrix-input')
const distDir = path.join(repoRoot, 'dist')
const version = (argValue('--version') || process.env.CAOGEN_RELEASE_VERSION || '').trim()
const expectedCommit = (argValue('--commit') || process.env.CAOGEN_RELEASE_COMMIT || '').trim().toLowerCase()
const packageJson = readJson(path.join(repoRoot, 'package.json'))
const packageLock = readJson(path.join(repoRoot, 'package-lock.json'))
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'release-matrix-assemble')
const reportDir = path.join(reportRoot, runId)
const checks = {
  versionIsStable: /^\d+\.\d+\.\d+$/.test(version),
  commitIsFullSha: /^[0-9a-f]{40}$/.test(expectedCommit),
  packageVersionMatches: packageJson.version === version,
  lockVersionMatches: packageLock.version === version && packageLock.packages?.['']?.version === version,
  checkedOutCommitMatches: git(['rev-parse', 'HEAD']).toLowerCase() === expectedCommit,
  aggregateWorktreeClean: git(['status', '--porcelain=v1', '--untracked-files=all']) === ''
}

const targets = [
  { id: 'macos-x64', audit: 'macos-release-audit/latest-x64.json', launch: 'packaged-app-smoke/latest-macos-x64.json' },
  { id: 'macos-arm64', audit: 'macos-release-audit/latest-arm64.json', launch: 'packaged-app-smoke/latest-macos-arm64.json' },
  { id: 'windows-x64', audit: 'windows-release-audit/latest-x64.json', launch: 'packaged-app-smoke/latest-windows-x64.json' }
]

mkdirSync(distDir, { recursive: true })
for (const target of targets) {
  const names = releasePlatformArtifactNames(version, target.id)
  for (const name of names) copyRequired(
    path.join(inputRoot, target.id, 'dist', name),
    path.join(distDir, name),
    `${target.id}:${name}`
  )
  copyEvidence(target.id, target.audit)
  copyEvidence(target.id, target.launch)
}
copyRequired(
  path.join(inputRoot, 'macos-x64', 'dist', 'mac', 'EastGenesis.app', 'Contents', 'Resources', 'app.asar'),
  path.join(distDir, 'mac', 'EastGenesis.app', 'Contents', 'Resources', 'app.asar'),
  'macos-x64:app.asar'
)
copyEvidence('macos-x64', 'caogen-deep/latest.json')
copyEvidence('macos-x64', 'p2-release-scope/latest.json')

const releaseDate = new Date().toISOString()
const updateMetadata = renderMacUpdateMetadata({ version, distDir, releaseDate })
writeFileSync(path.join(distDir, 'latest-mac.yml'), updateMetadata, 'utf8')
Object.assign(checks, prefix('macUpdate', macUpdateMetadataChecks(updateMetadata, { version, distDir })))

const macosX64Audit = readCanonical('macos-release-audit/latest-x64.json')
const macosArm64Audit = readCanonical('macos-release-audit/latest-arm64.json')
const windowsX64Audit = readCanonical('windows-release-audit/latest-x64.json')
const macosX64Launch = readCanonical('packaged-app-smoke/latest-macos-x64.json')
const macosArm64Launch = readCanonical('packaged-app-smoke/latest-macos-arm64.json')
const windowsX64Launch = readCanonical('packaged-app-smoke/latest-windows-x64.json')
const deep = readCanonical('caogen-deep/latest.json')
const p2ReleaseScope = readCanonical('p2-release-scope/latest.json')
const gitState = { commit: expectedCommit, worktreeClean: checks.aggregateWorktreeClean }
const platformArtifacts = Object.fromEntries(targets.map((target) => [
  target.id,
  releasePlatformArtifactEvidence(repoRoot, version, target.id)
]))

Object.assign(checks, prefix('deep', deepEvidenceChecks(deep, expectedCommit)))
checks.p2ReleaseScopePassed = p2ReleaseScope?.status === 'passed'
checks.p2ReleaseScopeCommitMatches = p2ReleaseScope?.git?.commit === expectedCommit
checks.p2ReleaseScopeCleanEvidence =
  p2ReleaseScope?.git?.worktreeClean === true && p2ReleaseScope?.git?.unchanged === true
checks.p2ReleaseScopeRequirementsProved = ['P2-002', 'P2-003', 'P2-005'].every((id) =>
  p2ReleaseScope?.requirements?.some((item) => item?.id === id && item?.status === 'proved')
)
Object.assign(checks, prefix('macosX64Artifacts', artifactReportChecks(
  macosX64Audit,
  releasePlatformArtifactNames(version, 'macos-x64'),
  distDir
)))
Object.assign(checks, prefix('macosArm64Artifacts', artifactReportChecks(
  macosArm64Audit,
  releasePlatformArtifactNames(version, 'macos-arm64'),
  distDir
)))
Object.assign(checks, prefix('windowsX64Artifacts', artifactReportChecks(
  windowsX64Audit,
  releasePlatformArtifactNames(version, 'windows-x64'),
  distDir
)))
Object.assign(checks, prefix('macosX64Distribution', trustedMacDistributionChecks({
  audit: macosX64Audit,
  releaseVersion: version,
  gitState,
  artifactSetSha256: platformArtifacts['macos-x64'].artifactSetSha256,
  targetArch: 'x64'
})))
Object.assign(checks, prefix('platformMatrix', releasePlatformMatrixChecks({
  releaseVersion: version,
  gitState,
  macosX64ArtifactSetSha256: platformArtifacts['macos-x64'].artifactSetSha256,
  macosX64Audit,
  macosArm64Audit,
  windowsX64Audit,
  macosX64LaunchAudit: macosX64Launch,
  macosArm64LaunchAudit: macosArm64Launch,
  windowsX64LaunchAudit: windowsX64Launch
})))

const artifacts = releaseArtifactEvidence(repoRoot, version)
checks.completeTwelveAssetSet = artifacts.complete && Object.keys(artifacts.files).length === 12
checks.aggregateRemainsClean = git(['status', '--porcelain=v1', '--untracked-files=all']) === ''
const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
const report = {
  status: failures.length === 0 ? 'passed' : 'failed',
  runId,
  packageVersion: version,
  git: gitState,
  inputRoot: path.relative(repoRoot, inputRoot),
  releaseDate,
  artifacts,
  platformArtifacts,
  evidence: Object.fromEntries(targets.map((target) => [target.id, {
    audit: `test-results/${target.audit}`,
    launch: `test-results/${target.launch}`
  }])),
  p2ReleaseScope: 'test-results/p2-release-scope/latest.json',
  checks,
  failures
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) process.exitCode = 1

function copyEvidence(target, relativePath) {
  copyRequired(
    path.join(inputRoot, target, 'test-results', relativePath),
    path.join(repoRoot, 'test-results', relativePath),
    `${target}:${relativePath}`
  )
}

function copyRequired(source, destination, label) {
  if (!existsSync(source)) throw new Error(`release matrix input is missing: ${label}`)
  mkdirSync(path.dirname(destination), { recursive: true })
  cpSync(source, destination, { force: true })
}

function readCanonical(relativePath) {
  return readJson(path.join(repoRoot, 'test-results', relativePath))
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function prefix(label, values) {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [`${label}.${name}`, value]))
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value)
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}
