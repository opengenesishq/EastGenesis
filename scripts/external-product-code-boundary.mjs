#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const failures = []
const scannedFiles = []
const inspectedInstallMetadata = []
const oversizedGuardedFiles = []
const rootFlagIndex = process.argv.indexOf('--root')
if (rootFlagIndex >= 0 && !process.argv[rootFlagIndex + 1]) {
  console.error('external-product-code-boundary: --root requires a directory')
  process.exit(2)
}
const scriptRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = rootFlagIndex >= 0
  ? path.resolve(process.argv[rootFlagIndex + 1])
  : scriptRepoRoot
const MAX_GUARDED_TEXT_BYTES = 4 * 1024 * 1024
const guardedSourceSkipDirectories = new Set([
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'venv'
])
const forbiddenDependencyPrefixes = [
  '@tencent/',
  '@tencentcloud/',
  '@wecom/',
  '@tencent-connect/',
  '@cloudbase/',
  '@genie/workbuddy',
  '@workbuddy/',
  'workbuddy-',
  'cos-js-sdk-',
  'cos-nodejs-sdk-',
  'tencentcloud-',
  'cloudbase-',
  'aegis-',
  'qimei-',
  'qqbot-',
  'qq-bot-',
  'wecom-bot-',
  'universal-report-',
  'tencent-coding-',
  'wechat-miniprogram-',
  'wx-server-sdk-'
]
const forbiddenDependencyNames = new Set([
  '@genie/workbuddy',
  'workbuddy',
  'cos-js-sdk-v5',
  'cos-nodejs-sdk-v5',
  'tencentcloud-sdk-nodejs',
  'cloudbase',
  'aegis',
  'aegis-sdk',
  'aegis-web-sdk',
  'qimei',
  'universal-report',
  'qqbot',
  'qq-bot',
  'wecom',
  'wecom-bot-sdk',
  'tencent-coding',
  'wechat-miniprogram',
  'wx-server-sdk'
])
const forbiddenDependencyReferencePatterns = [
  /@(?:tencent|tencentcloud|wecom|tencent-connect|cloudbase)\//i,
  /@(?:genie\/)?workbuddy(?:[\/@:._-]|$)/i,
  /(?:^|[\/@:._-])(?:workbuddy|tencentcloud|tencent-coding|tencent_coding|wechat-miniprogram|wechat_miniprogram|wx-server-sdk|cos-js-sdk|cos-nodejs-sdk|cloudbase|aegis-sdk|aegis-web-sdk|qimei|universal-report|qqbot|qq-bot|wecom-bot|tencent-docs)(?:[\/@:._-]|$)/i,
  /(?:github|gitlab)\.com\/tencent(?:cloud)?\//i
]
const packageBoundarySkipDirectories = new Set([
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'output',
  'outputs',
  'release',
  'test-results',
  'tmp'
])
const packageBoundaries = discoverPackageBoundaries(repoRoot)
// VS Code's extension dependencies are installed without a package manifest
// in this checkout. They are still first-party shipped tooling and must not
// hide a forbidden package in their npm installation tree.
const standaloneInstallRoots = ['plugins/vscode']

const manifest = readJson('package.json')
const lock = readJson('package-lock.json')
const rootLock = lock.packages?.[''] ?? {}

requireEqual(manifest.name, 'caogen', 'package.json name must remain caogen')
requireEqual(manifest.productName, 'CaoGen', 'package.json productName must remain CaoGen')
requireEqual(lock.name, manifest.name, 'package-lock.json name must match package.json')
requireEqual(lock.version, manifest.version, 'package-lock.json version must match package.json')
requireEqual(rootLock.name, manifest.name, 'package-lock root package name must match package.json')
requireEqual(rootLock.version, manifest.version, 'package-lock root package version must match package.json')

for (const scriptName of ['build', 'typecheck', 'test:deep', 'workos:release-doctor']) {
  if (typeof manifest.scripts?.[scriptName] !== 'string' || manifest.scripts[scriptName].trim() === '') {
    failures.push(`package.json is missing required CaoGen script: ${scriptName}`)
  }
}

for (const directory of packageBoundaries) {
  const manifestPath = path.posix.join(directory, 'package.json').replace(/^\.\//, '')
  const lockPath = path.posix.join(directory, 'package-lock.json').replace(/^\.\//, '')
  inspectManifest(manifestPath)
  if (existsSync(path.join(repoRoot, lockPath))) {
    inspectBoundaryIdentity(manifestPath, lockPath)
    inspectLock(lockPath)
  }
  const shrinkwrapPath = path.posix.join(directory, 'npm-shrinkwrap.json').replace(/^\.\//, '')
  if (existsSync(path.join(repoRoot, shrinkwrapPath))) inspectLock(shrinkwrapPath)
  for (const unsupportedLock of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    const relativePath = path.posix.join(directory, unsupportedLock).replace(/^\.\//, '')
    if (existsSync(path.join(repoRoot, relativePath))) {
      failures.push(`${relativePath}: unsupported dependency lock format; extend external-product-code-boundary before use`)
    }
  }
  inspectInstalledDependencies(directory)
}
for (const directory of standaloneInstallRoots) {
  if (!packageBoundaries.includes(directory)) inspectInstalledDependencies(directory)
}

if (existsSync(path.join(repoRoot, 'ui-hifi', 'competitors.html'))) {
  failures.push('ui-hifi/competitors.html must remain deleted; comparative material belongs in docs or the CaoGen website')
}

// Keep the scan focused on code and shipped/demo surfaces. Product research is
// intentionally kept in docs (and the CaoGen website); it is not part of this
// source boundary. Compatibility adapters and protocol names can be retained
// by the narrow file exemptions below, but copied product material cannot.
const guardedRoots = [
  '.caogen',
  'src',
  'scripts',
  'ui-hifi',
  'caogen-promo',
  'plugins/vscode',
  'tools/website-demo-video'
]
const forbiddenCopy = [
  {
    name: 'external-product-package-reference',
    regex: /@(?:tencent|tencentcloud|wecom|tencent-connect|cloudbase)\/|@(?:genie\/)?workbuddy(?:[-/]|\b)|\bworkbuddy(?:[-/]|\b)|cos-(?:js|nodejs)-sdk-|tencent-docs|腾讯文档/gi
  },
  {
    name: 'external-product-sdk-reference',
    regex: /tencentcloud-sdk-|cloudbase-|aegis-(?:sdk|web-sdk)|qimei(?:[-/]|\b)|universal-report(?:[-/]|\b)|qq[-_]?bot(?:[-/]|\b)|wecom-bot(?:[-/]|\b)|wx-server-sdk(?:[-/]|\b)/gi
  },
  { name: 'external-product-promotional-url', regex: /(?:workbuddy\.ai|codebuddy\.cn|tencentdocs?\.(?:com|cn))/gi },
  { name: 'retired-tencent-product-surface', regex: /tencent[_ -]?coding|wechat[_ -]?miniprogram|腾讯\s*CODING|微信小程序/gi },
  {
    name: 'retired-wecom-notification-surface',
    regex: /\b(?:wecom|wechat\s*work|wechatwork)\b|企业微信|(?:qyapi|work)\.weixin\.qq\.com/gi
  },
  { name: 'competitor-copy-zh', regex: /竞品/g },
  { name: 'competitor-copy-en', regex: /\bcompetitors?\b/gi },
  { name: 'copied-product-name', regex: /\bWorkBuddy\b/g },
  { name: 'unsupported-market-rank', regex: /国内日活第一/g },
  { name: 'comparative-design-copy', regex: /反打.{0,24}企业蓝|借鉴.{0,16}别学/g }
]
const forbiddenRuntimePathPatterns = [
  { name: 'external-runtime-claude-root', regex: /["'`]\.claude(?:[\\/]|["'`])/i },
  { name: 'external-runtime-claude-desktop-config', regex: /claude_desktop_config\.json/i },
  { name: 'external-runtime-codex-plugin-cache', regex: /\.codex[\\/]plugins[\\/]cache/i },
  { name: 'external-runtime-codex-home', regex: /\bCODEX_HOME\b/ },
  { name: 'external-runtime-codex-plugin-manifest', regex: /\.codex-plugin[\\/]plugin\.json/i },
  { name: 'external-runtime-claude-mcp-tool', regex: /\bmcp_import_claude_desktop\b/ },
  { name: 'external-runtime-claude-rules', regex: /\bCLAUDE\.md\b/ }
]
const allForbiddenCopyRuleNames = new Set(forbiddenCopy.map((pattern) => pattern.name))
const guardRuleExemptions = new Map([
  ['scripts/product-positioning-audit.mjs', new Set(['competitor-copy-zh', 'competitor-copy-en'])],
  ['scripts/release-notes-audit.mjs', new Set(['competitor-copy-en'])],
  ['scripts/sprint-01-gate-audit.mjs', new Set(['competitor-copy-en'])],
  ['scripts/ide-plugin-retirement-smoke.mjs', new Set(['competitor-copy-en'])],
  ['scripts/external-product-code-boundary-smoke.mjs', new Set([
    'external-product-package-reference',
    'external-product-sdk-reference',
    'retired-tencent-product-surface',
    'retired-wecom-notification-surface',
    'copied-product-name'
  ])],
  ['scripts/external-product-code-boundary.mjs', allForbiddenCopyRuleNames]
])

for (const root of guardedRoots) {
  const absoluteRoot = path.join(repoRoot, root)
  if (!existsSync(absoluteRoot)) continue
  for (const absolutePath of walkFiles(absoluteRoot)) {
    const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join('/')
    if (!isTextCodeFile(relativePath)) continue
    if (hasForbiddenProductPath(relativePath)) {
      failures.push(`${relativePath}: forbidden external-product path`)
      continue
    }
    const size = statSync(absolutePath).size
    if (size > MAX_GUARDED_TEXT_BYTES) {
      oversizedGuardedFiles.push(relativePath)
      failures.push(`${relativePath}: guarded text file exceeds ${MAX_GUARDED_TEXT_BYTES} bytes and cannot be silently skipped`)
      continue
    }
    const text = readFileSync(absolutePath, 'utf8')
    scannedFiles.push(relativePath)
    inspectRuntimeModuleSpecifiers(text, relativePath)
    inspectExternalRuntimePaths(text, relativePath)
    const exemptRules = guardRuleExemptions.get(relativePath) ?? new Set()
    for (const pattern of forbiddenCopy) {
      if (exemptRules.has(pattern.name)) continue
      pattern.regex.lastIndex = 0
      if (pattern.regex.test(text)) failures.push(`${relativePath}: forbidden ${pattern.name}`)
    }
  }
}

const report = {
  status: failures.length === 0 ? 'passed' : 'failed',
  packageIdentity: {
    name: manifest.name,
    productName: manifest.productName,
    version: manifest.version,
    lockVersion: lock.version
  },
  packageBoundaries,
  standaloneInstallRoots,
  guardedRoots,
  scannedFiles: scannedFiles.length,
  oversizedGuardedFiles,
  inspectedInstallMetadata: inspectedInstallMetadata.length,
  failures
}

console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) process.exitCode = 1

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'))
  } catch (error) {
    failures.push(`cannot read ${relativePath}: ${error.message}`)
    return {}
  }
}

function requireEqual(actual, expected, message) {
  if (actual !== expected) failures.push(`${message}; expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`)
}

function inspectExternalRuntimePaths(text, relativePath) {
  if (!relativePath.startsWith('src/') || isExplicitLegacyMigrationAdapter(relativePath)) return
  for (const pattern of forbiddenRuntimePathPatterns) {
    pattern.regex.lastIndex = 0
    if (pattern.regex.test(text)) failures.push(`${relativePath}: forbidden ${pattern.name}`)
  }
}

function isExplicitLegacyMigrationAdapter(relativePath) {
  return relativePath === 'src/main/migration.ts' ||
    relativePath.startsWith('src/main/migration-') ||
    relativePath === 'src/main/provider/providerNativeConfigImport.ts'
}

function inspectBoundaryIdentity(manifestPath, lockPath) {
  const packageManifest = readJson(manifestPath)
  const packageLock = readJson(lockPath)
  const lockRoot = packageLock.packages?.[''] ?? {}
  if (typeof packageManifest.name === 'string' && typeof packageLock.name === 'string') {
    if (packageManifest.name !== packageLock.name) {
      failures.push(`${lockPath} name must match ${manifestPath}; expected ${packageManifest.name}, found ${packageLock.name}`)
    }
    if (lockRoot.name !== undefined && lockRoot.name !== packageManifest.name) {
      failures.push(`${lockPath} root package name must match ${manifestPath}; expected ${packageManifest.name}, found ${String(lockRoot.name)}`)
    }
  }
  if (typeof packageManifest.version === 'string' && typeof packageLock.version === 'string') {
    if (packageManifest.version !== packageLock.version) {
      failures.push(`${lockPath} version must match ${manifestPath}; expected ${packageManifest.version}, found ${packageLock.version}`)
    }
    if (lockRoot.version !== undefined && lockRoot.version !== packageManifest.version) {
      failures.push(`${lockPath} root package version must match ${manifestPath}; expected ${packageManifest.version}, found ${String(lockRoot.version)}`)
    }
  }
}

function discoverPackageBoundaries(directory, relativeDirectory = '.') {
  const boundaries = []
  if (existsSync(path.join(directory, 'package.json'))) boundaries.push(relativeDirectory)

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const childRelativeDirectory = relativeDirectory === '.' ? entry.name : path.posix.join(relativeDirectory, entry.name)
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      entry.name.startsWith('.') ||
      packageBoundarySkipDirectories.has(entry.name)
    ) continue
    boundaries.push(...discoverPackageBoundaries(
      path.join(directory, entry.name),
      childRelativeDirectory
    ))
  }
  return boundaries.sort()
}

function inspectManifest(relativePath) {
  const packageManifest = readJson(relativePath)
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
    'overrides',
    'resolutions'
  ]) {
    inspectDependencyMap(packageManifest[field], `${relativePath}.${field}`)
  }
  for (const field of ['bundledDependencies', 'bundleDependencies']) {
    const names = Array.isArray(packageManifest[field]) ? packageManifest[field] : []
    for (const name of names) reportForbiddenDependency(name, `${relativePath}.${field}`)
  }
  inspectDependencyMap(packageManifest.pnpm?.overrides, `${relativePath}.pnpm.overrides`)
}

function inspectDependencyMap(value, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  for (const [rawName, nested] of Object.entries(value)) {
    reportForbiddenDependency(rawName, location)
    if (typeof nested === 'string') {
      reportForbiddenDependency(nested, `${location}.${rawName}`)
      reportForbiddenDependencyReference(nested, `${location}.${rawName}`)
    }
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      inspectDependencyMap(nested, `${location}.${rawName}`)
    }
  }
}

function reportForbiddenDependency(rawName, location) {
  const name = normalizeDependencyName(rawName)
  if (isForbiddenDependency(name)) {
    failures.push(`${location} contains forbidden external-product dependency: ${name}`)
  }
}

function reportForbiddenDependencyReference(rawValue, location) {
  if (typeof rawValue !== 'string') return
  const references = [rawValue]
  try {
    const decoded = decodeURIComponent(rawValue)
    if (decoded !== rawValue) references.push(decoded)
  } catch {
    // Malformed URL encoding is not relevant unless the undecoded value matches.
  }
  if (references.some((value) => forbiddenDependencyReferencePatterns.some((pattern) => pattern.test(value)))) {
    failures.push(`${location} contains forbidden external-product dependency reference: ${rawValue}`)
  }
}

function inspectLock(relativePath) {
  const packageLock = readJson(relativePath)
  for (const [packagePath, entry] of Object.entries(packageLock.packages ?? {})) {
    const name = packageNameFromLockPath(packagePath)
    reportForbiddenDependency(name, `${relativePath}.packages`)
    inspectLockEntry(entry, `${relativePath}.packages.${packagePath || '<root>'}`)
  }
  inspectLegacyLockDependencies(packageLock.dependencies, `${relativePath}.dependencies`)
  for (const section of ['snapshots']) {
    for (const rawName of Object.keys(packageLock[section] ?? {})) {
      reportForbiddenDependency(rawName, `${relativePath}.${section}`)
    }
  }
}

function inspectLockEntry(entry, location) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return
  for (const field of ['name', 'version', 'resolved', 'from']) {
    if (typeof entry[field] !== 'string') continue
    if (field === 'name') reportForbiddenDependency(entry[field], `${location}.${field}`)
    reportForbiddenDependencyReference(entry[field], `${location}.${field}`)
  }
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'requires']) {
    inspectDependencyMap(entry[field], `${location}.${field}`)
  }
}

function inspectInstalledDependencies(directory) {
  const nodeModulesPath = path.join(repoRoot, directory, 'node_modules')
  if (!existsSync(nodeModulesPath)) return

  // npm keeps a hidden lockfile in every installed tree. It is part of the
  // effective dependency graph even though it is not checked into the repo.
  // Walk nested package trees too: workspaces and bundled tools can carry a
  // second node_modules/.package-lock.json below a package directory.
  for (const absolutePath of walkInstalledMetadata(nodeModulesPath)) {
    const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join('/')
    inspectedInstallMetadata.push(relativePath)
    if (path.basename(absolutePath) === 'package.json') {
      inspectInstalledManifest(relativePath)
    } else {
      inspectLock(relativePath)
    }
  }

  for (const forbiddenPath of findForbiddenInstalledPaths(nodeModulesPath)) {
    reportForbiddenDependency(forbiddenPath.name, forbiddenPath.relativePath)
  }
}

function* findForbiddenInstalledPaths(nodeModulesPath) {
  for (const entry of readdirSync(nodeModulesPath, { withFileTypes: true })) {
    if (entry.name === '.package-lock.json') continue
    const absolutePath = path.join(nodeModulesPath, entry.name)
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const child of readdirSync(absolutePath, { withFileTypes: true })) {
        const childPath = path.join(absolutePath, child.name)
        if ((child.isDirectory() || child.isSymbolicLink()) && isForbiddenDependency(`${entry.name}/${child.name}`)) {
          yield { name: `${entry.name}/${child.name}`, relativePath: path.relative(repoRoot, childPath) }
        }
        if (child.isDirectory() && !child.isSymbolicLink()) yield* findNestedNodeModules(childPath)
      }
      continue
    }
    if (isForbiddenDependency(entry.name)) {
      yield { name: entry.name, relativePath: path.relative(repoRoot, absolutePath) }
    }
    if (entry.isDirectory()) yield* findNestedNodeModules(absolutePath)
  }
}

function inspectInstalledManifest(relativePath) {
  const packageManifest = readJson(relativePath)
  if (typeof packageManifest.name === 'string') {
    reportForbiddenDependency(packageManifest.name, `${relativePath}.name`)
  }
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
    'overrides',
    'resolutions'
  ]) {
    inspectDependencyMap(packageManifest[field], `${relativePath}.${field}`)
  }
}

function* walkInstalledMetadata(directory) {
  const hiddenLock = path.join(directory, '.package-lock.json')
  if (existsSync(hiddenLock)) yield hiddenLock

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '.package-lock.json') continue
    const absolutePath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      failures.push(`${path.relative(repoRoot, absolutePath)}: installed dependency symlink cannot be verified`)
      continue
    }
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('@')) {
      for (const child of readdirSync(absolutePath, { withFileTypes: true })) {
        const packagePath = path.join(absolutePath, child.name)
        if (child.isSymbolicLink()) {
          failures.push(`${path.relative(repoRoot, packagePath)}: installed dependency symlink cannot be verified`)
          continue
        }
        if (child.isDirectory()) yield* installedPackageMetadata(packagePath)
      }
      continue
    }
    yield* installedPackageMetadata(absolutePath)
  }
}

function* installedPackageMetadata(packagePath) {
  const manifestPath = path.join(packagePath, 'package.json')
  if (existsSync(manifestPath)) yield manifestPath
  const nestedNodeModules = path.join(packagePath, 'node_modules')
  if (existsSync(nestedNodeModules)) yield* walkInstalledMetadata(nestedNodeModules)
}

function* findNestedNodeModules(packagePath) {
  const nestedNodeModules = path.join(packagePath, 'node_modules')
  if (existsSync(nestedNodeModules)) yield* findForbiddenInstalledPaths(nestedNodeModules)
}

function inspectLegacyLockDependencies(value, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  for (const [rawName, entry] of Object.entries(value)) {
    reportForbiddenDependency(rawName, location)
    if (entry && typeof entry === 'object') {
      inspectLockEntry(entry, `${location}.${rawName}`)
      inspectLegacyLockDependencies(entry.dependencies, `${location}.${rawName}.dependencies`)
    }
  }
}

function isForbiddenDependency(name) {
  const normalized = name.toLowerCase()
  return forbiddenDependencyNames.has(normalized) || forbiddenDependencyPrefixes.some((prefix) => normalized.startsWith(prefix))
}

function normalizeDependencyName(value) {
  if (typeof value !== 'string') return ''
  const name = value.trim()
  const npmAlias = name.match(/^npm:(@[^/]+\/[^@]+|[^@]+)(?:@|$)/)
  if (npmAlias) return npmAlias[1]
  if (name.startsWith('@')) {
    const slash = name.indexOf('/')
    const versionSeparator = name.indexOf('@', slash + 1)
    return versionSeparator > 0 ? name.slice(0, versionSeparator) : name
  }
  const versionSeparator = name.indexOf('@')
  return versionSeparator > 0 ? name.slice(0, versionSeparator) : name
}

function packageNameFromLockPath(packagePath) {
  return packagePath.replace(/^node_modules\//, '').split('/node_modules/').at(-1) ?? ''
}

function inspectRuntimeModuleSpecifiers(text, relativePath) {
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\b(?:import|require|require\.resolve)\s*\(\s*['"]([^'"]+)['"]/g
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1]
      const normalizedName = normalizeDependencyName(specifier)
      if (isForbiddenDependency(normalizedName)) {
        failures.push(`${relativePath}: forbidden runtime dependency import: ${specifier}`)
        continue
      }
      reportForbiddenDependencyReference(specifier, `${relativePath} runtime import`)
    }
  }
}

function isTextCodeFile(relativePath) {
  return /\.(?:cjs|css|html|js|jsx|md|mjs|py|sh|ts|tsx)$/.test(relativePath)
}

function hasForbiddenProductPath(relativePath) {
  return /(?:^|\/)(?:(?:competitors?|workbuddy|tencent-coding-devops|wechat-miniprogram|wecom|wechatwork|wechat-work)(?:\.|\/|$)|competitive-(?:parity|benchmark)(?:[-./]|$))/i.test(relativePath)
}

function* walkFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (guardedSourceSkipDirectories.has(entry.name)) continue
    const absolutePath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      failures.push(`${path.relative(repoRoot, absolutePath)}: symbolic links are not allowed in guarded source roots`)
      continue
    }
    if (entry.isDirectory()) {
      yield* walkFiles(absolutePath)
      continue
    }
    if (entry.isFile()) yield absolutePath
  }
}
