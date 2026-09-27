#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const descriptorPath = path.join(repoRoot, 'docs', 'FIX-000-D0.json')
const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'))
const artifactPath = path.join(repoRoot, descriptor.relativePath)
const nodeExecutable = process.execPath
const nodeRoot = path.dirname(nodeExecutable)
const nodeLicense = path.join(nodeRoot, 'LICENSE')
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const outputRoot = path.join(repoRoot, 'test-results', 'fix-000-owner-kit')
const outputDir = path.join(outputRoot, runId)
const kitName = 'EastGenesis-FIX-000-Owner-Kit'
const kitDir = path.join(outputDir, kitName)
const zipPath = path.join(outputDir, `${kitName}.zip`)
const failures = []

const inputs = [
  [artifactPath, descriptor.fileName],
  [descriptorPath, 'FIX-000-D0.json'],
  [path.join(repoRoot, 'scripts', 'fix-000-portable-packaged-smoke.mjs'), 'FIX-000-PACKAGED-SMOKE.mjs'],
  [path.join(repoRoot, 'scripts', 'fix-000-run-portable-preflight.cmd'), 'RUN-FIX-000-PREFLIGHT.cmd'],
  [path.join(repoRoot, 'scripts', 'fix-000-run-assisted-install.cmd'), 'RUN-FIX-000-ASSISTED-INSTALL.cmd'],
  [path.join(repoRoot, 'scripts', 'fix-000-run-portable-smoke.cmd'), 'RUN-FIX-000-PACKAGED-SMOKE.cmd'],
  [path.join(repoRoot, 'docs', 'OWNER-FIX-000-PORTABLE-KIT.md'), 'START-HERE.md'],
  [path.join(repoRoot, 'docs', 'OWNER-FIX-000-RESULT.template.json'), 'OWNER-FIX-000-RESULT.template.json'],
  [nodeExecutable, path.join('runtime', 'node.exe')],
  [nodeLicense, path.join('runtime', 'LICENSE.node.txt')]
]

validateDescriptor()
for (const [source] of inputs) if (!existsSync(source) || !statSync(source).isFile()) failures.push('required kit input is missing')
if (process.platform !== 'win32' || process.arch !== 'x64') failures.push('Owner kit must be built with a Windows x64 Node runtime')
if (Number(process.versions.node.split('.')[0]) < 22) failures.push('Owner kit requires Node 22 or newer for built-in CDP transport')

let artifact = null
if (existsSync(artifactPath)) {
  artifact = { size: statSync(artifactPath).size, sha256: await sha256File(artifactPath) }
  if (artifact.size !== descriptor.size) failures.push('D0 artifact size does not match the descriptor')
  if (artifact.sha256 !== descriptor.sha256) failures.push('D0 artifact SHA-256 does not match the descriptor')
}

let manifest = null
let manifestSha256 = null
let zip = null
if (failures.length === 0) {
  mkdirSync(kitDir, { recursive: true })
  for (const [source, destination] of inputs) {
    const target = path.join(kitDir, destination)
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(source, target)
  }

  const fileEntries = []
  for (const relativePath of walkFiles(kitDir)) {
    const filePath = path.join(kitDir, relativePath)
    fileEntries.push({
      path: relativePath.replaceAll('\\', '/'),
      size: statSync(filePath).size,
      sha256: await sha256File(filePath)
    })
  }
  fileEntries.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  manifest = {
    schemaVersion: 1,
    evidenceClass: 'fix_000_owner_portable_kit',
    generatedAt: new Date().toISOString(),
    artifact: {
      fileName: descriptor.fileName,
      size: descriptor.size,
      sha256: descriptor.sha256,
      artifactSetSha256: descriptor.artifactSetSha256
    },
    runtime: { nodeVersion: process.version, platform: process.platform, architecture: process.arch },
    files: fileEntries,
    contentSetSha256: createHash('sha256').update(JSON.stringify(fileEntries)).digest('hex'),
    policy: 'Dirty D0 defect verification only. The Owner host runs installed artifacts, not repository source.'
  }
  const manifestPath = path.join(kitDir, 'MANIFEST.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  manifestSha256 = await sha256File(manifestPath)

  const archive = spawnSync('tar.exe', ['-a', '-c', '-f', zipPath, '-C', outputDir, kitName], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  })
  if (archive.status !== 0) {
    failures.push('portable kit ZIP creation failed')
  } else {
    const listing = spawnSync('tar.exe', ['-t', '-f', zipPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    })
    const members = String(listing.stdout || '').split(/\r?\n/).filter(Boolean)
    const expectedMembers = [`${kitName}/MANIFEST.json`, ...manifest.files.map((item) => `${kitName}/${item.path}`)]
    if (listing.status !== 0 || expectedMembers.some((item) => !members.includes(item))) {
      failures.push('portable kit ZIP member verification failed')
    } else {
      zip = { size: statSync(zipPath).size, sha256: await sha256File(zipPath), memberCount: members.length }
    }
  }
}

const report = {
  status: failures.length === 0 ? 'passed' : 'failed',
  evidenceClass: 'fix_000_owner_portable_kit_build',
  required,
  runId,
  outputDir: path.relative(repoRoot, outputDir),
  artifact,
  artifactSetSha256: descriptor.artifactSetSha256,
  manifest: manifest ? { sha256: manifestSha256, contentSetSha256: manifest.contentSetSha256, fileCount: manifest.files.length } : null,
  zip,
  failures,
  privacy: 'The kit and report contain no credential, Provider, project, Office, user, or private evidence value.'
}

mkdirSync(outputDir, { recursive: true })
writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
mkdirSync(outputRoot, { recursive: true })
writeFileSync(path.join(outputRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (required && report.status !== 'passed') process.exitCode = 1

function validateDescriptor() {
  if (descriptor?.schemaVersion !== 1 || descriptor?.gateId !== 'fix_000_d0') failures.push('D0 descriptor schema is invalid')
  if (descriptor?.platform !== 'windows-x64' || descriptor?.distributionChannel !== 'unsigned_preview') failures.push('D0 descriptor platform/channel is invalid')
  if (!Number.isInteger(descriptor?.size) || descriptor.size <= 0) failures.push('D0 descriptor size is invalid')
  if (!/^[a-f0-9]{64}$/.test(descriptor?.sha256 || '')) failures.push('D0 descriptor SHA-256 is invalid')
  if (!/^[a-f0-9]{64}$/.test(descriptor?.artifactSetSha256 || '')) failures.push('D0 descriptor artifact-set SHA-256 is invalid')
}

function walkFiles(root, prefix = '') {
  const files = []
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relativePath = path.join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(root, relativePath))
    else if (entry.isFile()) files.push(relativePath)
  }
  return files
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}
